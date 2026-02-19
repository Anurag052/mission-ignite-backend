import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
    OnGatewayConnection,
    OnGatewayDisconnect,
    WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { UseGuards, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { GTOSessionStatus, GTOTaskType } from '@prisma/client';

interface AuthenticatedSocket extends Socket {
    userId: string;
    sessionId?: string;
}

@WebSocketGateway({
    namespace: '/gto',
    cors: { origin: '*', credentials: true },
})
export class GtoGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(GtoGateway.name);
    // Map: sessionId → countdown interval
    private timers = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly jwtService: JwtService,
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
    ) { }

    // ── Connection lifecycle ──────────────────────────────────────────────────────

    async handleConnection(client: AuthenticatedSocket) {
        try {
            const token =
                client.handshake.auth?.token ||
                client.handshake.headers?.authorization?.replace('Bearer ', '');

            if (!token) throw new WsException('No token provided');

            const payload = this.jwtService.verify(token, {
                secret: this.config.get<string>('JWT_SECRET'),
            });

            client.userId = payload.sub;
            this.logger.log(`GTO client connected: ${client.id} (user: ${client.userId})`);
            client.emit('connected', { message: 'GTO Gateway connected', userId: client.userId });
        } catch {
            client.emit('error', { message: 'Authentication failed' });
            client.disconnect();
        }
    }

    handleDisconnect(client: AuthenticatedSocket) {
        this.logger.log(`GTO client disconnected: ${client.id}`);
        if (client.sessionId) {
            this.clearTimer(client.sessionId);
        }
    }

    // ── Start GTO session ─────────────────────────────────────────────────────────

    @SubscribeMessage('gto:start')
    async handleStartSession(
        @MessageBody() data: { taskType: GTOTaskType; durationSec?: number },
        @ConnectedSocket() client: AuthenticatedSocket,
    ) {
        const durationSec = data.durationSec ?? 600;

        const session = await this.prisma.gTOTestSession.create({
            data: {
                userId: client.userId,
                taskType: data.taskType,
                status: GTOSessionStatus.ACTIVE,
                durationSec,
                startedAt: new Date(),
                isGD: data.taskType === GTOTaskType.GD,
            },
        });

        client.sessionId = session.id;
        client.join(`session:${session.id}`);

        client.emit('gto:session_started', {
            sessionId: session.id,
            taskType: data.taskType,
            durationSec,
        });

        // Start countdown timer
        this.startCountdown(session.id, durationSec, client);
        this.logger.log(`GTO session started: ${session.id} (${data.taskType})`);
    }

    // ── Stream transcript chunk ───────────────────────────────────────────────────

    @SubscribeMessage('gto:transcript_chunk')
    async handleTranscriptChunk(
        @MessageBody() data: { sessionId: string; chunk: string },
        @ConnectedSocket() client: AuthenticatedSocket,
    ) {
        // Append chunk to DB transcript
        await this.prisma.gTOTestSession.update({
            where: { id: data.sessionId },
            data: {
                transcript: {
                    // Prisma doesn't support string concat natively; use raw
                },
            },
        });

        // Broadcast chunk to session room (for multi-device)
        this.server.to(`session:${data.sessionId}`).emit('gto:chunk', {
            sessionId: data.sessionId,
            chunk: data.chunk,
            timestamp: Date.now(),
        });
    }

    // ── End session ───────────────────────────────────────────────────────────────

    @SubscribeMessage('gto:end')
    async handleEndSession(
        @MessageBody() data: { sessionId: string; transcript?: string },
        @ConnectedSocket() client: AuthenticatedSocket,
    ) {
        this.clearTimer(data.sessionId);

        const session = await this.prisma.gTOTestSession.update({
            where: { id: data.sessionId },
            data: {
                status: GTOSessionStatus.COMPLETED,
                completedAt: new Date(),
                transcript: data.transcript,
            },
        });

        client.emit('gto:session_ended', { sessionId: session.id, status: 'COMPLETED' });
        client.leave(`session:${data.sessionId}`);
        this.logger.log(`GTO session ended: ${data.sessionId}`);
    }

    // ── Pause / Resume ────────────────────────────────────────────────────────────

    @SubscribeMessage('gto:pause')
    handlePause(
        @MessageBody() data: { sessionId: string },
        @ConnectedSocket() client: AuthenticatedSocket,
    ) {
        this.clearTimer(data.sessionId);
        client.emit('gto:paused', { sessionId: data.sessionId });
    }

    // ── Private helpers ───────────────────────────────────────────────────────────

    private startCountdown(sessionId: string, durationSec: number, client: AuthenticatedSocket) {
        let remaining = durationSec;

        const interval = setInterval(async () => {
            remaining -= 1;

            // Emit tick every second
            this.server.to(`session:${sessionId}`).emit('gto:tick', {
                sessionId,
                remaining,
                elapsed: durationSec - remaining,
            });

            if (remaining <= 0) {
                this.clearTimer(sessionId);

                // Auto-complete session
                await this.prisma.gTOTestSession.update({
                    where: { id: sessionId },
                    data: { status: GTOSessionStatus.COMPLETED, completedAt: new Date() },
                });

                this.server.to(`session:${sessionId}`).emit('gto:timeout', {
                    sessionId,
                    message: 'Session time expired. Auto-submitted.',
                });
            }
        }, 1000);

        this.timers.set(sessionId, interval);
    }

    private clearTimer(sessionId: string) {
        const interval = this.timers.get(sessionId);
        if (interval) {
            clearInterval(interval);
            this.timers.delete(sessionId);
        }
    }
}
