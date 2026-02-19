import {
    Controller,
    Get,
    Post,
    Param,
    Body,
    Query,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { PostTestAnalysisService, TacticalBreakdown } from './analysis/post-test-analysis.service';
import { VideoOverviewService, VideoOverviewPlan } from './video/video-overview.service';
import { SimulationScenesService } from './scenes/simulation-scenes.service';
import { PressureEngine } from './pressure/pressure.engine';

@ApiTags('gto-simulation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('gto-sim')
export class GtoSimulationController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly analysis: PostTestAnalysisService,
        private readonly video: VideoOverviewService,
        private readonly scenes: SimulationScenesService,
        private readonly pressure: PressureEngine,
    ) { }

    // ── 3D Scene Data ─────────────────────────────────────────────────────────────

    @Get('scenes')
    @ApiOperation({ summary: 'List all available GTO task scenes' })
    listScenes() {
        return this.scenes.getAllScenes();
    }

    @Get('scenes/:taskType')
    @ApiOperation({ summary: 'Get full 3D scene config for a task type (PGT, HGT, FGT, COMMAND_TASK, GPE)' })
    @ApiQuery({ name: 'difficulty', required: false, enum: ['STANDARD', 'HARD', 'EXTREME'] })
    getScene(
        @Param('taskType') taskType: string,
        @Query('difficulty') difficulty: 'STANDARD' | 'HARD' | 'EXTREME' = 'STANDARD',
    ) {
        return this.scenes.getScene(taskType, difficulty);
    }

    // ── Post-Test Analysis ────────────────────────────────────────────────────────

    @Post('sessions/:sessionId/analysis')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Generate post-test tactical analysis for a completed session' })
    async generateAnalysis(
        @Param('sessionId') sessionId: string,
        @CurrentUser() user: any,
    ): Promise<TacticalBreakdown> {
        const session = await this.prisma.gTOTestSession.findUniqueOrThrow({
            where: { id: sessionId },
        });

        const metadata = (session as any).metadata || {};

        return this.analysis.generateAnalysis({
            sessionId,
            taskType: session.taskType,
            transcript: ((session as any).transcript || '').split(' '),
            stepBackEvents: metadata.stepBackEvents || [],
            aiInterventions: metadata.aiInterventions || [],
            pressureState: metadata.pressureFinalState || {
                currentLevel: 1,
                interruptionCount: 0,
                challengeCount: 0,
                lastInterruptionAt: 0,
                candidateStepBacks: 0,
                escalationTriggers: [],
            },
            durationSec: session.durationSec || 600,
        });
    }

    // ── Video Overview ────────────────────────────────────────────────────────────

    @Post('sessions/:sessionId/video-overview')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Generate NotebookLM-style video overview for a session analysis' })
    async generateVideoOverview(
        @Param('sessionId') sessionId: string,
        @CurrentUser() user: any,
    ): Promise<VideoOverviewPlan> {
        const session = await this.prisma.gTOTestSession.findUniqueOrThrow({
            where: { id: sessionId },
        });

        const metadata = (session as any).metadata || {};

        // Generate analysis first
        const analysisResult = await this.analysis.generateAnalysis({
            sessionId,
            taskType: session.taskType,
            transcript: ((session as any).transcript || '').split(' '),
            stepBackEvents: metadata.stepBackEvents || [],
            aiInterventions: metadata.aiInterventions || [],
            pressureState: metadata.pressureFinalState || {
                currentLevel: 1,
                interruptionCount: 0,
                challengeCount: 0,
                lastInterruptionAt: 0,
                candidateStepBacks: 0,
                escalationTriggers: [],
            },
            durationSec: session.durationSec || 600,
        });

        // Generate video plan from analysis
        return this.video.generateFromAnalysis(analysisResult, session.taskType);
    }

    @Post('video/custom')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Generate custom AI-powered lesson slides for a topic' })
    async generateCustomVideo(
        @Body() body: { topic: string; context: string },
    ) {
        const slides = await this.video.generateCustomSlides(body.topic, body.context);
        return {
            title: body.topic,
            totalSlides: slides.length,
            estimatedDurationSec: slides.reduce((sum, s) => sum + s.durationSec, 0),
            slides,
        };
    }

    // ── Session History ───────────────────────────────────────────────────────────

    @Get('sessions')
    @ApiOperation({ summary: 'List GTO simulation sessions for the authenticated user' })
    async listSessions(@CurrentUser() user: any) {
        return this.prisma.gTOTestSession.findMany({
            where: { userId: user.sub },
            orderBy: { startedAt: 'desc' },
            take: 20,
            select: {
                id: true,
                taskType: true,
                status: true,
                durationSec: true,
                startedAt: true,
                completedAt: true,
            },
        });
    }

    @Get('sessions/:sessionId')
    @ApiOperation({ summary: 'Get full session details including transcript and events' })
    async getSession(
        @Param('sessionId') sessionId: string,
        @CurrentUser() user: any,
    ) {
        return this.prisma.gTOTestSession.findUniqueOrThrow({
            where: { id: sessionId },
        });
    }
}
