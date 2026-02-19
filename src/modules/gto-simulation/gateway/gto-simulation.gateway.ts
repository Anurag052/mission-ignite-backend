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
import { VoiceAnalysisService, VoiceFrame, VoiceMetricsSnapshot, StepBackEvent } from '../voice/voice-analysis.service';
import { PressureEngine, InterruptionDecision, PressureState } from '../pressure/pressure.engine';

interface SimSocket extends Socket {
    userId: string;
    sessionId?: string;
    sessionStartMs?: number;
    wordsSinceLastInterrupt?: number;
    previousMetrics?: VoiceMetricsSnapshot;
    lastAiChallenge?: string;
    stepBackEvents?: StepBackEvent[];
    fullTranscript?: string[];
    aiInterventions?: Array<{ timestamp: number; text: string; type: string; level: number }>;
}

export interface SimulationConfig {
    taskType: 'PGT' | 'HGT' | 'FGT' | 'COMMAND_TASK' | 'GPE' | 'GD' | 'LECTURETTE';
    durationSec: number;
    groupSize: number;
    scenario: string;
    difficulty: 'STANDARD' | 'HARD' | 'EXTREME';
}

/**
 * GTO Simulation WebSocket Gateway — Voice-Only Real-Time Engine
 *
 * Flow:
 *   1. Client connects with JWT → authenticated
 *   2. Client sends `sim:start` with config → session created
 *   3. Client streams voice frames `sim:voice_frame` every ~1s
 *   4. Server analyzes voice → decides to interrupt → sends `sim:ai_interrupt`
 *   5. Server tracks step-back events → emits `sim:step_back`
 *   6. Client sends `sim:end` → server generates post-test analysis
 *   7. Server emits `sim:analysis_ready` with full tactical breakdown
 */
@WebSocketGateway({
    namespace: '/gto-sim',
    cors: { origin: '*', credentials: true },
})
export class GtoSimulationGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(GtoSimulationGateway.name);
    private timers = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly jwtService: JwtService,
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
        private readonly voiceAnalysis: VoiceAnalysisService,
        private readonly pressureEngine: PressureEngine,
    ) { }

    // ── Connection lifecycle ──────────────────────────────────────────────────────

    async handleConnection(client: SimSocket) {
        try {
            const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.replace('Bearer ', '');
            if (!token) throw new WsException('No token provided');

            const payload = this.jwtService.verify(token, { secret: this.config.get<string>('JWT_SECRET') });
            client.userId = payload.sub;
            client.stepBackEvents = [];
            client.fullTranscript = [];
            client.aiInterventions = [];
            client.wordsSinceLastInterrupt = 0;

            this.logger.log(`GTO-SIM client connected: ${client.id} (user: ${client.userId})`);
            client.emit('connected', { message: 'GTO Simulation Engine ready', mode: 'VOICE_ONLY' });
        } catch {
            client.emit('error', { message: 'Authentication failed' });
            client.disconnect();
        }
    }

    handleDisconnect(client: SimSocket) {
        if (client.sessionId) {
            this.cleanup(client.sessionId);
            this.voiceAnalysis.endSession(client.sessionId);
            this.pressureEngine.endSession(client.sessionId);
        }
        this.logger.log(`GTO-SIM client disconnected: ${client.id}`);
    }

    // ── Start simulation ──────────────────────────────────────────────────────────

    @SubscribeMessage('sim:start')
    async handleStart(
        @MessageBody() config: SimulationConfig,
        @ConnectedSocket() client: SimSocket,
    ) {
        // Create DB session
        const session = await this.prisma.gTOTestSession.create({
            data: {
                userId: client.userId,
                taskType: config.taskType as any,
                status: 'ACTIVE',
                durationSec: config.durationSec,
                startedAt: new Date(),
                isGD: config.taskType === 'GD',
                metadata: {
                    simulationType: 'VOICE_ONLY_AI_GTO',
                    scenario: config.scenario,
                    difficulty: config.difficulty,
                    groupSize: config.groupSize,
                },
            },
        });

        client.sessionId = session.id;
        client.sessionStartMs = Date.now();
        client.join(`sim:${session.id}`);

        // Init analysis engines
        this.voiceAnalysis.initSession(session.id);
        this.pressureEngine.initSession(session.id);

        // Start countdown
        this.startCountdown(session.id, config.durationSec, client);

        // Opening GTO statement
        const openingText = this.getOpeningStatement(config);
        client.emit('sim:ai_speak', {
            text: openingText,
            ttsText: openingText,
            type: 'OPENING',
            pressureLevel: 1,
        });

        client.emit('sim:started', {
            sessionId: session.id,
            taskType: config.taskType,
            durationSec: config.durationSec,
            message: 'Voice-only mode active. AI GTO is listening. Begin your plan.',
        });

        this.logger.log(`SIM started: ${session.id} (${config.taskType}, ${config.difficulty})`);
    }

    // ── Voice frame processing (core loop) ────────────────────────────────────────

    @SubscribeMessage('sim:voice_frame')
    async handleVoiceFrame(
        @MessageBody() frame: VoiceFrame,
        @ConnectedSocket() client: SimSocket,
    ) {
        if (!client.sessionId) return;

        // Track transcript
        if (frame.transcript) {
            client.fullTranscript!.push(frame.transcript);
            client.wordsSinceLastInterrupt! += frame.wordCount;
        }

        // ── 1. Analyze voice metrics ────────────────────────────────────
        const metrics = this.voiceAnalysis.processFrame(client.sessionId, frame);

        // Emit real-time metrics to client (for UI dashboard)
        client.emit('sim:metrics', metrics);

        // ── 2. Detect step-back ─────────────────────────────────────────
        const stepBack = this.voiceAnalysis.detectStepBack(
            client.sessionId,
            metrics,
            client.previousMetrics || null,
            client.lastAiChallenge || '',
        );

        if (stepBack) {
            client.stepBackEvents!.push(stepBack);
            this.pressureEngine.recordStepBack(client.sessionId);

            // Persist to DB
            await this.prisma.agentLog.create({
                data: {
                    userId: client.userId,
                    agentName: 'GTO_SIMULATION',
                    action: 'STEP_BACK_DETECTED',
                    inputPayload: stepBack as any,
                    outputPayload: { pressureState: this.pressureEngine.getState(client.sessionId) } as any,
                },
            });

            client.emit('sim:step_back', stepBack);
            this.logger.log(`STEP-BACK: ${stepBack.type} (${stepBack.severity}) in session ${client.sessionId}`);
        }

        // ── 3. Evaluate interruption ────────────────────────────────────
        const elapsed = Date.now() - (client.sessionStartMs || 0);
        const decision = this.pressureEngine.evaluateInterruption(
            client.sessionId,
            metrics,
            elapsed,
            client.wordsSinceLastInterrupt || 0,
        );

        if (decision.shouldInterrupt) {
            // Reset word counter
            client.wordsSinceLastInterrupt = 0;
            client.lastAiChallenge = decision.text;

            // Record AI intervention
            client.aiInterventions!.push({
                timestamp: elapsed,
                text: decision.text,
                type: decision.interruptionType,
                level: decision.pressureLevel,
            });

            // Delayed or immediate interrupt
            if (decision.waitBeforeMs > 0) {
                setTimeout(() => {
                    client.emit('sim:ai_interrupt', decision);
                }, decision.waitBeforeMs);
            } else {
                client.emit('sim:ai_interrupt', decision);
            }
        }

        // ── 4. Store previous metrics ───────────────────────────────────
        client.previousMetrics = metrics;
    }

    // ── End simulation ────────────────────────────────────────────────────────────

    @SubscribeMessage('sim:end')
    async handleEnd(
        @MessageBody() data: { reason?: string },
        @ConnectedSocket() client: SimSocket,
    ) {
        if (!client.sessionId) return;

        this.cleanup(client.sessionId);
        const pressureState = this.pressureEngine.endSession(client.sessionId);
        this.voiceAnalysis.endSession(client.sessionId);

        // Update DB
        await this.prisma.gTOTestSession.update({
            where: { id: client.sessionId },
            data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                transcript: client.fullTranscript?.join(' '),
                metadata: {
                    stepBackEvents: client.stepBackEvents,
                    aiInterventions: client.aiInterventions,
                    pressureFinalState: pressureState,
                    endReason: data.reason || 'MANUAL',
                },
            },
        });

        // Emit analysis ready signal
        client.emit('sim:ended', {
            sessionId: client.sessionId,
            totalStepBacks: client.stepBackEvents?.length || 0,
            totalInterruptions: pressureState?.interruptionCount || 0,
            maxPressureLevel: pressureState?.currentLevel || 1,
        });

        this.logger.log(`SIM ended: ${client.sessionId}`);
    }

    // ── Timer ─────────────────────────────────────────────────────────────────────

    private startCountdown(sessionId: string, durationSec: number, client: SimSocket) {
        let remaining = durationSec;

        const interval = setInterval(async () => {
            remaining--;

            // Tick every 5 seconds (not every second — reduce noise)
            if (remaining % 5 === 0) {
                this.server.to(`sim:${sessionId}`).emit('sim:tick', { remaining, elapsed: durationSec - remaining });
            }

            // Time warnings from AI GTO
            if (remaining === Math.floor(durationSec * 0.5)) {
                client.emit('sim:ai_speak', {
                    text: 'Half your time is gone. I expect to see results.',
                    ttsText: 'Half your time is gone. I expect to see results.',
                    type: 'TIME_WARNING',
                    pressureLevel: 3,
                });
            }

            if (remaining === 60) {
                client.emit('sim:ai_speak', {
                    text: 'One minute remaining. Wrap it up. NOW.',
                    ttsText: 'One minute remaining. Wrap it up. Now.',
                    type: 'TIME_WARNING',
                    pressureLevel: 4,
                });
            }

            if (remaining <= 0) {
                clearInterval(interval);
                this.timers.delete(sessionId);

                client.emit('sim:ai_speak', {
                    text: 'Time. Stop. Step back from the task area.',
                    ttsText: 'Time. Stop. Step back from the task area.',
                    type: 'TIME_UP',
                    pressureLevel: 5,
                });

                // Auto-end
                await this.handleEnd({ reason: 'TIMEOUT' }, client);
            }
        }, 1000);

        this.timers.set(sessionId, interval);
    }

    private cleanup(sessionId: string) {
        const interval = this.timers.get(sessionId);
        if (interval) {
            clearInterval(interval);
            this.timers.delete(sessionId);
        }
    }

    // ── Opening statements ────────────────────────────────────────────────────────

    private getOpeningStatement(config: SimulationConfig): string {
        const statements: Record<string, string> = {
            PGT: `Right. This is a Progressive Group Task. You have ${config.durationSec / 60} minutes. Your group of ${config.groupSize} must cross the obstacles using the materials provided. I want to see planning, coordination, and execution. No idle members. Begin your planning now.`,
            HGT: `This is a Half Group Task. You have ${config.durationSec / 60} minutes with half your group. I expect every member to contribute. Plan first, then execute. The clock starts NOW.`,
            FGT: `Final Group Task. This is your last chance to demonstrate leadership. ${config.durationSec / 60} minutes. I want to see improvement over your previous tasks. No excuses. Start planning.`,
            COMMAND_TASK: `You are the commander for this task. The rest are your subordinates. You have ${config.durationSec / 60} minutes. Show me you can lead. Plan, delegate, and execute. Begin.`,
            GPE: `Group Planning Exercise. Study the model carefully. You have 5 minutes to read, then each of you will present your individual plan. I want clarity, logic, and decisiveness.`,
            GD: `Group Discussion topic will be announced. You have ${config.durationSec / 60} minutes. I want structured arguments, not noise. Quality over quantity. The topic is: "${config.scenario}". Begin.`,
            LECTURETTE: `You have 3 minutes to prepare, then 3 minutes to present your lecturette. Topic: "${config.scenario}". I want clear structure, confident delivery, and eye contact. Your preparation time starts now.`,
        };
        return statements[config.taskType] || 'Begin your task. I am observing.';
    }
}
