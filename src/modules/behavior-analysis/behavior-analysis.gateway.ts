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
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
    BehaviorAnalysisBridge,
    BehaviorMetrics,
    BehaviorAlert,
    HeatmapData,
} from './behavior-analysis.bridge';

interface BaSocket extends Socket {
    userId: string;
    baSessionId?: string;
    gtoSessionId?: string;
}

/**
 * Behavior Analysis WebSocket Gateway — Client-Facing.
 *
 * Flow:
 *   1. Frontend connects via Socket.IO with JWT
 *   2. Frontend sends 'ba:start' → starts Python session via bridge
 *   3. Frontend streams video frames (WebRTC → capture → base64 JPEG):
 *        'ba:video_frame' { data: base64 }
 *   4. Frontend streams audio chunks:
 *        'ba:audio_chunk' { data: base64 }
 *   5. Server proxies to Python → receives metrics → emits back to client:
 *        'ba:metrics', 'ba:heatmap', 'ba:alert'
 *   6. Frontend sends 'ba:stop' → session ends, summary returned
 */
@WebSocketGateway({
    namespace: '/behavior-analysis',
    cors: { origin: '*', credentials: true },
})
export class BehaviorAnalysisGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer() server: Server;
    private readonly logger = new Logger(BehaviorAnalysisGateway.name);

    constructor(
        private readonly jwtService: JwtService,
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
        private readonly bridge: BehaviorAnalysisBridge,
    ) {
        // Listen to bridge events and forward to appropriate clients
        this.bridge.on('ba:metrics', (data: BehaviorMetrics) => {
            this.server?.emit('ba:metrics', data);
        });

        this.bridge.on('ba:heatmap', (data: HeatmapData) => {
            this.server?.emit('ba:heatmap', data);
        });

        this.bridge.on('ba:alert', (data: BehaviorAlert) => {
            this.server?.emit('ba:alert', data);
        });

        this.bridge.on('ba:summary', (data: any) => {
            this.server?.emit('ba:session_summary', data);
        });
    }

    // ── Connection ────────────────────────────────────────────────────────────────

    async handleConnection(client: BaSocket) {
        try {
            const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.replace('Bearer ', '');
            if (!token) throw new WsException('No token');

            const payload = this.jwtService.verify(token, { secret: this.config.get<string>('JWT_SECRET') });
            client.userId = payload.sub;

            this.logger.log(`BA client connected: ${client.id} (user: ${client.userId})`);
            client.emit('connected', {
                message: 'Behavior Analysis Engine ready',
                pythonServiceConnected: this.bridge.connected,
            });
        } catch {
            client.emit('error', { message: 'Authentication failed' });
            client.disconnect();
        }
    }

    handleDisconnect(client: BaSocket) {
        if (client.baSessionId) {
            this.bridge.stopSession(client.baSessionId);
        }
        this.logger.log(`BA client disconnected: ${client.id}`);
    }

    // ── Start analysis ────────────────────────────────────────────────────────────

    @SubscribeMessage('ba:start')
    async handleStart(
        @MessageBody() data: { gtoSessionId?: string },
        @ConnectedSocket() client: BaSocket,
    ) {
        const sessionId = `ba-${client.userId}-${Date.now()}`;
        client.baSessionId = sessionId;
        client.gtoSessionId = data.gtoSessionId;

        // Start on Python side
        const started = this.bridge.startSession(sessionId, client.userId, data.gtoSessionId);

        // Store in DB
        await this.prisma.agentLog.create({
            data: {
                userId: client.userId,
                agentName: 'BEHAVIOR_ANALYSIS',
                action: 'SESSION_STARTED',
                inputPayload: { sessionId, gtoSessionId: data.gtoSessionId } as any,
                outputPayload: { pythonConnected: started } as any,
            },
        });

        client.emit('ba:started', {
            sessionId,
            pythonConnected: started,
            message: started
                ? 'Behavior analysis active. Stream video/audio frames.'
                : 'Python service offline — visual analysis unavailable, audio-only mode.',
        });
    }

    // ── Video frame ───────────────────────────────────────────────────────────────

    @SubscribeMessage('ba:video_frame')
    handleVideoFrame(
        @MessageBody() data: { data: string },
        @ConnectedSocket() client: BaSocket,
    ) {
        if (client.baSessionId) {
            this.bridge.sendVideoFrame(client.baSessionId, data.data);
        }
    }

    // ── Audio chunk ───────────────────────────────────────────────────────────────

    @SubscribeMessage('ba:audio_chunk')
    handleAudioChunk(
        @MessageBody() data: { data: string },
        @ConnectedSocket() client: BaSocket,
    ) {
        if (client.baSessionId) {
            this.bridge.sendAudioChunk(client.baSessionId, data.data);
        }
    }

    // ── Combined ──────────────────────────────────────────────────────────────────

    @SubscribeMessage('ba:combined')
    handleCombined(
        @MessageBody() data: { video?: string; audio?: string },
        @ConnectedSocket() client: BaSocket,
    ) {
        if (client.baSessionId) {
            this.bridge.sendCombined(client.baSessionId, data.video, data.audio);
        }
    }

    // ── Stop analysis ─────────────────────────────────────────────────────────────

    @SubscribeMessage('ba:stop')
    async handleStop(
        @MessageBody() data: any,
        @ConnectedSocket() client: BaSocket,
    ) {
        if (!client.baSessionId) return;

        this.bridge.stopSession(client.baSessionId);

        await this.prisma.agentLog.create({
            data: {
                userId: client.userId,
                agentName: 'BEHAVIOR_ANALYSIS',
                action: 'SESSION_ENDED',
                inputPayload: { sessionId: client.baSessionId } as any,
                outputPayload: {} as any,
            },
        });

        client.emit('ba:ended', { sessionId: client.baSessionId });
        client.baSessionId = undefined;
    }
}
