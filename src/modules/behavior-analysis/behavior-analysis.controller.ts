import {
    Controller,
    Get,
    Post,
    Delete,
    Param,
    HttpStatus,
    HttpCode,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BehaviorAnalysisBridge } from './behavior-analysis.bridge';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Behavior Analysis')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/behavior-analysis')
export class BehaviorAnalysisController {

    constructor(
        private readonly bridge: BehaviorAnalysisBridge,
        private readonly prisma: PrismaService,
    ) { }

    @Get('health')
    @ApiOperation({ summary: 'Check Behavior Analysis microservice health' })
    async health() {
        const pythonHealth = await this.bridge.getHealth();
        return {
            bridge: {
                connected: this.bridge.connected,
                activeSessions: this.bridge.sessionCount,
            },
            python: pythonHealth,
        };
    }

    @Get('sessions/:sessionId/summary')
    @ApiOperation({ summary: 'Get behavior analysis session summary' })
    async getSessionSummary(
        @Param('sessionId') sessionId: string,
        @CurrentUser() user: any,
    ) {
        // Try Python service first (live session)
        const pythonHealth = await this.bridge.getHealth();
        const httpUrl = (pythonHealth as any)?.url || 'http://localhost:8100';

        try {
            const res = await fetch(`${httpUrl}/sessions/${sessionId}/summary`, {
                method: 'POST',
            });
            if (res.ok) return await res.json();
        } catch {
            // Python service unavailable
        }

        // Fallback: check logs
        const logs = await this.prisma.agentLog.findMany({
            where: {
                userId: user.sub,
                agentName: 'BEHAVIOR_ANALYSIS',
                inputPayload: { path: ['sessionId'], equals: sessionId },
            },
            orderBy: { createdAt: 'desc' },
            take: 10,
        });

        return {
            sessionId,
            logs: logs.map(l => ({
                action: l.action,
                timestamp: l.createdAt,
                data: l.outputPayload,
            })),
        };
    }

    @Delete('sessions/:sessionId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete behavior analysis session data (GDPR)' })
    async deleteSession(
        @Param('sessionId') sessionId: string,
        @CurrentUser() user: any,
    ) {
        this.bridge.stopSession(sessionId);

        // Delete logs
        await this.prisma.agentLog.deleteMany({
            where: {
                userId: user.sub,
                agentName: 'BEHAVIOR_ANALYSIS',
                inputPayload: { path: ['sessionId'], equals: sessionId },
            },
        });

        return { message: 'Session data deleted', sessionId };
    }

    @Get('sessions')
    @ApiOperation({ summary: 'List user behavior analysis sessions' })
    async listSessions(@CurrentUser() user: any) {
        const sessions = await this.prisma.agentLog.findMany({
            where: {
                userId: user.sub,
                agentName: 'BEHAVIOR_ANALYSIS',
                action: 'SESSION_STARTED',
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
        });

        return sessions.map(s => ({
            sessionId: (s.inputPayload as any)?.sessionId,
            gtoSessionId: (s.inputPayload as any)?.gtoSessionId,
            startedAt: s.createdAt,
        }));
    }
}
