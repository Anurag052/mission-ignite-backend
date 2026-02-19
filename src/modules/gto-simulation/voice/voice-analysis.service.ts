import { Injectable, Logger } from '@nestjs/common';

/**
 * Voice Analysis Service — local speech metrics detection.
 *
 * Analyzes raw audio features extracted from WebAudio API (sent via WebSocket)
 * to detect psychological indicators during GTO simulation:
 *
 *   - Voice tremor (frequency jitter)
 *   - Speech hesitation (filler words + pauses)
 *   - Tone drop (pitch decline)
 *   - Volume drop (RMS energy decline)
 *   - Idea abandonment (sentence trail-off)
 *   - Confidence score (composite 0-100)
 */

export interface VoiceFrame {
    timestamp: number;         // ms since session start
    rmsVolume: number;         // 0.0 - 1.0 RMS energy
    pitchHz: number;           // dominant frequency in Hz
    pitchVariance: number;     // jitter — high = tremor
    speechRate: number;        // words per minute (estimated from STT)
    pauseDurationMs: number;   // silence gap before this frame
    fillerWordCount: number;   // "um", "uh", "like", "so"
    wordCount: number;         // words in this chunk
    transcript: string;        // STT text for this frame
}

export interface VoiceMetricsSnapshot {
    timestamp: number;
    voiceTremor: number;          // 0-100 (higher = more tremor)
    speechHesitation: number;     // 0-100
    toneDrop: number;             // 0-100
    volumeDrop: number;           // 0-100
    ideaAbandonment: boolean;
    confidenceScore: number;      // 0-100 (composite)
    rawValues: {
        avgPitch: number;
        avgVolume: number;
        avgSpeechRate: number;
        totalPauses: number;
        totalFillers: number;
    };
}

export interface StepBackEvent {
    timestamp: number;
    type: 'VOICE_TREMOR' | 'HESITATION' | 'IDEA_ABANDON' | 'TONE_DROP' | 'VOLUME_DROP' | 'CONFIDENCE_COLLAPSE';
    severity: 'MILD' | 'MODERATE' | 'SEVERE';
    confidenceBefore: number;
    confidenceAfter: number;
    transcript: string;
    aiChallenge: string;     // what the AI said that triggered this
    description: string;
}

@Injectable()
export class VoiceAnalysisService {
    private readonly logger = new Logger(VoiceAnalysisService.name);

    // Sliding window of frames for trend analysis
    private sessionFrames: Map<string, VoiceFrame[]> = new Map();
    // Baseline metrics (captured in first 30s of session)
    private baselines: Map<string, { avgPitch: number; avgVolume: number; avgRate: number }> = new Map();

    // ── Session lifecycle ─────────────────────────────────────────────────────────

    initSession(sessionId: string): void {
        this.sessionFrames.set(sessionId, []);
        this.baselines.delete(sessionId);
    }

    endSession(sessionId: string): void {
        this.sessionFrames.delete(sessionId);
        this.baselines.delete(sessionId);
    }

    // ── Process incoming voice frame ──────────────────────────────────────────────

    processFrame(sessionId: string, frame: VoiceFrame): VoiceMetricsSnapshot {
        const frames = this.sessionFrames.get(sessionId) || [];
        frames.push(frame);
        this.sessionFrames.set(sessionId, frames);

        // Build baseline from first 30 seconds
        if (!this.baselines.has(sessionId) && frame.timestamp > 30000 && frames.length > 10) {
            this.calibrateBaseline(sessionId, frames);
        }

        return this.computeMetrics(sessionId, frames);
    }

    // ── Detect step-back events ───────────────────────────────────────────────────

    detectStepBack(
        sessionId: string,
        currentMetrics: VoiceMetricsSnapshot,
        previousMetrics: VoiceMetricsSnapshot | null,
        aiChallenge: string,
    ): StepBackEvent | null {
        if (!previousMetrics) return null;

        const confidenceDrop = previousMetrics.confidenceScore - currentMetrics.confidenceScore;
        const transcript = this.getRecentTranscript(sessionId, 5);

        // ── Confidence collapse (drop > 25 points) ──────────────────────
        if (confidenceDrop > 25) {
            return {
                timestamp: currentMetrics.timestamp,
                type: 'CONFIDENCE_COLLAPSE',
                severity: confidenceDrop > 40 ? 'SEVERE' : 'MODERATE',
                confidenceBefore: previousMetrics.confidenceScore,
                confidenceAfter: currentMetrics.confidenceScore,
                transcript,
                aiChallenge,
                description: `Confidence dropped by ${confidenceDrop.toFixed(0)} points after AI challenge`,
            };
        }

        // ── Idea abandonment ────────────────────────────────────────────
        if (currentMetrics.ideaAbandonment) {
            return {
                timestamp: currentMetrics.timestamp,
                type: 'IDEA_ABANDON',
                severity: 'MODERATE',
                confidenceBefore: previousMetrics.confidenceScore,
                confidenceAfter: currentMetrics.confidenceScore,
                transcript,
                aiChallenge,
                description: 'Candidate abandoned their idea after AI interruption',
            };
        }

        // ── Severe voice tremor ─────────────────────────────────────────
        if (currentMetrics.voiceTremor > 70) {
            return {
                timestamp: currentMetrics.timestamp,
                type: 'VOICE_TREMOR',
                severity: currentMetrics.voiceTremor > 85 ? 'SEVERE' : 'MODERATE',
                confidenceBefore: previousMetrics.confidenceScore,
                confidenceAfter: currentMetrics.confidenceScore,
                transcript,
                aiChallenge,
                description: `Voice tremor detected (${currentMetrics.voiceTremor.toFixed(0)}/100)`,
            };
        }

        // ── Volume drop (candidate getting quieter) ─────────────────────
        if (currentMetrics.volumeDrop > 60) {
            return {
                timestamp: currentMetrics.timestamp,
                type: 'VOLUME_DROP',
                severity: currentMetrics.volumeDrop > 80 ? 'SEVERE' : 'MILD',
                confidenceBefore: previousMetrics.confidenceScore,
                confidenceAfter: currentMetrics.confidenceScore,
                transcript,
                aiChallenge,
                description: `Volume dropped significantly (${currentMetrics.volumeDrop.toFixed(0)}/100)`,
            };
        }

        // ── Tone drop (pitch declining) ─────────────────────────────────
        if (currentMetrics.toneDrop > 60) {
            return {
                timestamp: currentMetrics.timestamp,
                type: 'TONE_DROP',
                severity: 'MILD',
                confidenceBefore: previousMetrics.confidenceScore,
                confidenceAfter: currentMetrics.confidenceScore,
                transcript,
                aiChallenge,
                description: `Pitch/tone declined (${currentMetrics.toneDrop.toFixed(0)}/100)`,
            };
        }

        return null;
    }

    // ── Private: Calibrate baseline ───────────────────────────────────────────────

    private calibrateBaseline(sessionId: string, frames: VoiceFrame[]): void {
        const baselineFrames = frames.filter((f) => f.timestamp <= 30000);
        if (baselineFrames.length < 5) return;

        const avgPitch = this.avg(baselineFrames.map((f) => f.pitchHz));
        const avgVolume = this.avg(baselineFrames.map((f) => f.rmsVolume));
        const avgRate = this.avg(baselineFrames.map((f) => f.speechRate));

        this.baselines.set(sessionId, { avgPitch, avgVolume, avgRate });
        this.logger.debug(`Baseline calibrated for ${sessionId}: pitch=${avgPitch.toFixed(0)}Hz vol=${avgVolume.toFixed(2)} rate=${avgRate.toFixed(0)}wpm`);
    }

    // ── Private: Compute real-time metrics ────────────────────────────────────────

    private computeMetrics(sessionId: string, frames: VoiceFrame[]): VoiceMetricsSnapshot {
        const recent = frames.slice(-10); // Last 10 frames (~10 seconds)
        const baseline = this.baselines.get(sessionId);

        const avgPitch = this.avg(recent.map((f) => f.pitchHz));
        const avgVolume = this.avg(recent.map((f) => f.rmsVolume));
        const avgRate = this.avg(recent.map((f) => f.speechRate));
        const avgPitchVar = this.avg(recent.map((f) => f.pitchVariance));
        const totalPauses = recent.filter((f) => f.pauseDurationMs > 1500).length;
        const totalFillers = recent.reduce((sum, f) => sum + f.fillerWordCount, 0);

        // Voice tremor: high pitch variance = tremor
        const voiceTremor = Math.min(100, avgPitchVar * 5);

        // Hesitation: fillers + long pauses + slow speech
        const fillerScore = Math.min(50, totalFillers * 10);
        const pauseScore = Math.min(50, totalPauses * 15);
        const speechHesitation = Math.min(100, fillerScore + pauseScore);

        // Tone drop: pitch declining relative to baseline
        let toneDrop = 0;
        if (baseline && baseline.avgPitch > 0) {
            const pitchDecline = ((baseline.avgPitch - avgPitch) / baseline.avgPitch) * 100;
            toneDrop = Math.max(0, Math.min(100, pitchDecline * 3));
        }

        // Volume drop: getting quieter relative to baseline
        let volumeDrop = 0;
        if (baseline && baseline.avgVolume > 0) {
            const volDecline = ((baseline.avgVolume - avgVolume) / baseline.avgVolume) * 100;
            volumeDrop = Math.max(0, Math.min(100, volDecline * 3));
        }

        // Idea abandonment: sentence trails off (low words + long pause + volume drop)
        const lastFrame = recent[recent.length - 1];
        const ideaAbandonment =
            lastFrame &&
            lastFrame.pauseDurationMs > 3000 &&
            lastFrame.wordCount < 3 &&
            volumeDrop > 40;

        // Composite confidence score (0-100, higher = more confident)
        const tremorPenalty = voiceTremor * 0.2;
        const hesitationPenalty = speechHesitation * 0.25;
        const tonePenalty = toneDrop * 0.15;
        const volumePenalty = volumeDrop * 0.2;
        const abandonPenalty = ideaAbandonment ? 20 : 0;

        const confidenceScore = Math.max(
            0,
            Math.min(100, 100 - tremorPenalty - hesitationPenalty - tonePenalty - volumePenalty - abandonPenalty),
        );

        return {
            timestamp: lastFrame?.timestamp || Date.now(),
            voiceTremor: Math.round(voiceTremor),
            speechHesitation: Math.round(speechHesitation),
            toneDrop: Math.round(toneDrop),
            volumeDrop: Math.round(volumeDrop),
            ideaAbandonment: !!ideaAbandonment,
            confidenceScore: Math.round(confidenceScore),
            rawValues: {
                avgPitch: Math.round(avgPitch),
                avgVolume: parseFloat(avgVolume.toFixed(3)),
                avgSpeechRate: Math.round(avgRate),
                totalPauses,
                totalFillers,
            },
        };
    }

    // ── Utility ───────────────────────────────────────────────────────────────────

    private getRecentTranscript(sessionId: string, n: number): string {
        const frames = this.sessionFrames.get(sessionId) || [];
        return frames
            .slice(-n)
            .map((f) => f.transcript)
            .filter(Boolean)
            .join(' ');
    }

    private avg(arr: number[]): number {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }
}
