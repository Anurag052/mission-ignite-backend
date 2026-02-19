import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

/**
 * NestJS Bridge to the Python Behavior Analysis Microservice.
 *
 * Maintains a persistent WebSocket connection to the Python service
 * and proxies video/audio frames from the frontend → Python,
 * and metrics/alerts from Python → frontend.
 */

export interface BehaviorMetrics {
    timestamp: number;
    confidence: {
        visual: number;
        vocal: number;
        gestural: number;
        emotional: number;
        overall: number;
    };
    stress: {
        index: number;
        trend: 'INCREASING' | 'DECREASING' | 'STABLE' | 'VOLATILE';
        components: Record<string, number>;
    };
    face?: any;
    hands?: any;
    audio?: any;
}

export interface BehaviorAlert {
    alert_type: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    indicator: string;
    value: number;
    threshold: number;
    description: string;
    recommendation: string;
}

export interface HeatmapData {
    grid: number[][];
    resolution: [number, number];
    peak_zones: Array<{ zone: string; intensity: number; x: number; y: number }>;
    overall_stress: number;
    dominant_indicator: string;
}

@Injectable()
export class BehaviorAnalysisBridge extends EventEmitter implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BehaviorAnalysisBridge.name);
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private isConnected = false;
    private pythonUrl: string;

    // Session mapping: clientSessionId → python session
    private activeSessions: Map<string, string> = new Map();

    constructor(private readonly config: ConfigService) {
        super();
        this.pythonUrl = this.config.get<string>('BA_MICROSERVICE_URL', 'ws://localhost:8100/ws/analyze');
    }

    async onModuleInit() {
        this.connect();
    }

    onModuleDestroy() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) this.ws.close();
    }

    // ── Connection management ─────────────────────────────────────────────────────

    private connect() {
        try {
            this.ws = new WebSocket(this.pythonUrl);

            this.ws.on('open', () => {
                this.isConnected = true;
                this.logger.log('Connected to Python Behavior Analysis service');
                this.emit('bridge:connected');
            });

            this.ws.on('message', (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());
                    this.handlePythonMessage(msg);
                } catch (err) {
                    this.logger.error('Failed to parse Python message', err);
                }
            });

            this.ws.on('close', () => {
                this.isConnected = false;
                this.logger.warn('Disconnected from Python service, reconnecting in 5s...');
                this.scheduleReconnect();
            });

            this.ws.on('error', (err) => {
                this.logger.error(`Python bridge error: ${err.message}`);
                this.isConnected = false;
            });
        } catch (err) {
            this.logger.error('Failed to connect to Python service');
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }

    // ── Send to Python ────────────────────────────────────────────────────────────

    /**
     * Start a behavior analysis session on the Python side.
     */
    startSession(sessionId: string, userId: string, gtoSessionId?: string): boolean {
        if (!this.isConnected || !this.ws) return false;

        this.activeSessions.set(sessionId, userId);
        this.ws.send(JSON.stringify({
            type: 'start',
            session_id: sessionId,
            user_id: userId,
            gto_session_id: gtoSessionId,
        }));

        this.logger.log(`BA session started: ${sessionId}`);
        return true;
    }

    /**
     * Send a video frame to Python for analysis.
     * @param frameBase64 - Base64-encoded JPEG frame
     */
    sendVideoFrame(sessionId: string, frameBase64: string) {
        if (!this.isConnected || !this.ws) return;
        this.ws.send(JSON.stringify({
            type: 'video_frame',
            session_id: sessionId,
            data: frameBase64,
        }));
    }

    /**
     * Send an audio chunk to Python for analysis.
     * @param audioBase64 - Base64-encoded PCM16 audio
     */
    sendAudioChunk(sessionId: string, audioBase64: string) {
        if (!this.isConnected || !this.ws) return;
        this.ws.send(JSON.stringify({
            type: 'audio_chunk',
            session_id: sessionId,
            data: audioBase64,
        }));
    }

    /**
     * Send combined video + audio for synchronized analysis.
     */
    sendCombined(sessionId: string, videoBase64?: string, audioBase64?: string) {
        if (!this.isConnected || !this.ws) return;
        this.ws.send(JSON.stringify({
            type: 'combined',
            session_id: sessionId,
            video: videoBase64 || null,
            audio: audioBase64 || null,
        }));
    }

    /**
     * Stop the analysis session.
     */
    stopSession(sessionId: string) {
        if (!this.isConnected || !this.ws) return;
        this.ws.send(JSON.stringify({ type: 'stop', session_id: sessionId }));
        this.activeSessions.delete(sessionId);
        this.logger.log(`BA session stopped: ${sessionId}`);
    }

    // ── Receive from Python ───────────────────────────────────────────────────────

    private handlePythonMessage(msg: any) {
        switch (msg.type) {
            case 'metrics':
                this.emit('ba:metrics', msg.data as BehaviorMetrics);
                break;

            case 'heatmap':
                this.emit('ba:heatmap', msg.data as HeatmapData);
                break;

            case 'alert':
                this.emit('ba:alert', msg.data as BehaviorAlert);
                break;

            case 'session_summary':
                this.emit('ba:summary', msg.data);
                break;

            case 'session_started':
                this.emit('ba:session_started', msg);
                break;

            case 'error':
                this.logger.error(`Python error: ${msg.message}`);
                this.emit('ba:error', msg.message);
                break;

            default:
                this.logger.debug(`Unknown Python msg type: ${msg.type}`);
        }
    }

    // ── Status ────────────────────────────────────────────────────────────────────

    get connected(): boolean {
        return this.isConnected;
    }

    get sessionCount(): number {
        return this.activeSessions.size;
    }

    async getHealth(): Promise<any> {
        try {
            const httpUrl = this.pythonUrl.replace('ws://', 'http://').replace('/ws/analyze', '/health');
            const res = await fetch(httpUrl);
            return await res.json();
        } catch {
            return { status: 'disconnected' };
        }
    }
}
