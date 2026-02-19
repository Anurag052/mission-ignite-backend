import { Injectable, Logger } from '@nestjs/common';
import { VoiceMetricsSnapshot } from '../voice/voice-analysis.service';

/**
 * Pressure Engine — AI GTO Officer behavioral logic.
 *
 * Implements a strict, realistic GTO officer that:
 *   1. Listens to candidate's plan
 *   2. Deliberately interrupts mid-idea
 *   3. Challenges logic with pointed questions
 *   4. Gradually increases psychological pressure
 *   5. Attempts to make the candidate step back
 *
 * Pressure levels escalate over time and based on candidate's confidence.
 */

export type PressureLevel = 1 | 2 | 3 | 4 | 5;

export interface InterruptionDecision {
    shouldInterrupt: boolean;
    interruptionType: 'NONE' | 'CHALLENGE' | 'REDIRECT' | 'DEMAND_CLARITY' | 'DISMISS' | 'PRESSURE_TEST';
    text: string;               // What the AI GTO officer says
    ttsText: string;             // Clean text for TTS (no stage directions)
    pressureLevel: PressureLevel;
    tactic: string;              // Description of the psychological tactic used
    waitBeforeMs: number;        // How long to wait before speaking (0 = immediate interrupt)
}

export interface PressureState {
    currentLevel: PressureLevel;
    interruptionCount: number;
    challengeCount: number;
    lastInterruptionAt: number;
    candidateStepBacks: number;
    escalationTriggers: string[];
}

// ── Interruption templates by pressure level ────────────────────────────────────

const INTERRUPTIONS: Record<PressureLevel, Array<{ type: InterruptionDecision['interruptionType']; templates: string[]; tactic: string }>> = {
    1: [
        {
            type: 'CHALLENGE',
            templates: [
                'Wait. Explain that again — why did you choose this approach specifically?',
                'Hold on. How many people are in your group? You haven\'t accounted for everyone.',
                'Stop. What\'s your backup plan if this fails?',
            ],
            tactic: 'Gentle probing — testing clarity of thought',
        },
    ],
    2: [
        {
            type: 'DEMAND_CLARITY',
            templates: [
                'That doesn\'t make sense. You said one thing earlier and now you\'re contradicting yourself. Which is it?',
                'I\'m not convinced. Give me a concrete reason why your plan would work in the field.',
                'You\'re wasting time. Get to the point — what exactly is your plan?',
                'How many minutes do you think you have? You\'re already behind.',
            ],
            tactic: 'Time pressure + logical inconsistency attack',
        },
        {
            type: 'REDIRECT',
            templates: [
                'Forget that approach. What else can you do?',
                'That\'s been tried before and it failed. Think of something original.',
            ],
            tactic: 'Forcing candidate to abandon plan and think on feet',
        },
    ],
    3: [
        {
            type: 'DISMISS',
            templates: [
                'I don\'t think you\'ve understood the problem at all. Start over.',
                'Your team is looking at you. Do you even have a plan or are you just talking?',
                'An officer needs to be decisive. You\'re not showing me that right now.',
                'Every second you hesitate, your group loses confidence in you.',
            ],
            tactic: 'Direct dismissal — testing emotional resilience',
        },
        {
            type: 'PRESSURE_TEST',
            templates: [
                'The enemy is advancing. You have 30 seconds. What do you do? NOW.',
                'Your subordinate just refused your order. The group is watching. React.',
            ],
            tactic: 'Extreme time pressure — chaos injection',
        },
    ],
    4: [
        {
            type: 'PRESSURE_TEST',
            templates: [
                'You just lost two team members. Your plan is falling apart. What now?',
                'I\'ve heard better plans from cadets on their first day. Prove me wrong.',
                'If this were real, people would be in danger because of your indecisiveness. Do better.',
                'Stop. Look at me. Tell me ONE reason I should let you continue leading this task.',
            ],
            tactic: 'Personal challenge — testing core confidence',
        },
        {
            type: 'DISMISS',
            templates: [
                'You clearly haven\'t prepared for this. Why are you here?',
                'An officer leads from the front. Right now you\'re hiding behind words.',
            ],
            tactic: 'Identity-level challenge — maximum psychological pressure',
        },
    ],
    5: [
        {
            type: 'PRESSURE_TEST',
            templates: [
                'Fine. Your plan failed. Two casualties. The mission is compromised. NOW what?',
                'The entire group has lost faith in you. You have 10 seconds to win them back. Go.',
                'I\'m pulling you from command. Unless you can show me RIGHT NOW that you deserve to lead.',
                'This is your last chance. One clear, decisive action. What is it?',
            ],
            tactic: 'Maximum pressure — crisis simulation — pass/fail moment',
        },
    ],
};

@Injectable()
export class PressureEngine {
    private readonly logger = new Logger(PressureEngine.name);
    private states: Map<string, PressureState> = new Map();

    initSession(sessionId: string): void {
        this.states.set(sessionId, {
            currentLevel: 1,
            interruptionCount: 0,
            challengeCount: 0,
            lastInterruptionAt: 0,
            candidateStepBacks: 0,
            escalationTriggers: [],
        });
    }

    endSession(sessionId: string): PressureState | undefined {
        const state = this.states.get(sessionId);
        this.states.delete(sessionId);
        return state;
    }

    /**
     * Decide whether to interrupt the candidate based on:
     *   - Time since last interruption
     *   - Current pressure level
     *   - Candidate's metrics (if too confident, pressure harder)
     *   - Word count (wait for candidate to develop idea before cutting)
     */
    evaluateInterruption(
        sessionId: string,
        metrics: VoiceMetricsSnapshot,
        elapsedMs: number,
        candidateWordsSinceLastInterrupt: number,
    ): InterruptionDecision {
        const state = this.states.get(sessionId);
        if (!state) {
            return { shouldInterrupt: false, interruptionType: 'NONE', text: '', ttsText: '', pressureLevel: 1, tactic: '', waitBeforeMs: 0 };
        }

        const timeSinceLastInterrupt = elapsedMs - state.lastInterruptionAt;

        // ── Timing rules ────────────────────────────────────────────────────
        // Don't interrupt in first 15s (let candidate start)
        if (elapsedMs < 15000) {
            return this.noInterrupt(state.currentLevel);
        }

        // Minimum gap between interruptions (decreases with pressure level)
        const minGapMs = Math.max(8000, 25000 - state.currentLevel * 4000);
        if (timeSinceLastInterrupt < minGapMs) {
            return this.noInterrupt(state.currentLevel);
        }

        // Wait for candidate to say enough words (~15-40 words depending on level)
        const minWords = Math.max(10, 40 - state.currentLevel * 6);
        if (candidateWordsSinceLastInterrupt < minWords) {
            return this.noInterrupt(state.currentLevel);
        }

        // ── Probability of interruption ─────────────────────────────────────
        // Higher confidence → more likely to interrupt (AI wants to break confidence)
        // Higher pressure level → more likely to interrupt
        let probability = 0.3 + state.currentLevel * 0.12;
        if (metrics.confidenceScore > 70) probability += 0.15;
        if (metrics.confidenceScore > 85) probability += 0.15;

        if (Math.random() > probability) {
            return this.noInterrupt(state.currentLevel);
        }

        // ── Generate interruption ───────────────────────────────────────────
        const level = state.currentLevel;
        const pool = INTERRUPTIONS[level];
        const category = pool[Math.floor(Math.random() * pool.length)];
        const text = category.templates[Math.floor(Math.random() * category.templates.length)];

        // Update state
        state.interruptionCount++;
        state.challengeCount++;
        state.lastInterruptionAt = elapsedMs;

        // ── Escalation logic ─────────────────────────────────────────────
        this.evaluateEscalation(state, metrics);

        return {
            shouldInterrupt: true,
            interruptionType: category.type,
            text,
            ttsText: text,
            pressureLevel: state.currentLevel,
            tactic: category.tactic,
            waitBeforeMs: Math.random() < 0.3 ? 0 : Math.floor(Math.random() * 2000), // Sometimes immediate
        };
    }

    /**
     * Record that the candidate stepped back (called by simulation gateway when stepback detected).
     */
    recordStepBack(sessionId: string): void {
        const state = this.states.get(sessionId);
        if (!state) return;
        state.candidateStepBacks++;
        state.escalationTriggers.push(`Step-back #${state.candidateStepBacks} detected`);

        // Step-back slightly reduces pressure (realistic — GTO eases off briefly)
        if (state.candidateStepBacks >= 3 && state.currentLevel > 2) {
            state.currentLevel = Math.max(2, state.currentLevel - 1) as PressureLevel;
            this.logger.debug(`Pressure reduced to ${state.currentLevel} after ${state.candidateStepBacks} step-backs`);
        }
    }

    getState(sessionId: string): PressureState | undefined {
        return this.states.get(sessionId);
    }

    // ── Private ───────────────────────────────────────────────────────────────────

    private evaluateEscalation(state: PressureState, metrics: VoiceMetricsSnapshot): void {
        const maxLevel = 5;
        if (state.currentLevel >= maxLevel) return;

        // Escalate every 3 interruptions
        if (state.interruptionCount % 3 === 0 && state.interruptionCount > 0) {
            state.currentLevel = Math.min(maxLevel, state.currentLevel + 1) as PressureLevel;
            state.escalationTriggers.push(`Escalated to L${state.currentLevel} after ${state.interruptionCount} interruptions`);
        }

        // Escalate if candidate is too confident (> 80) for too long
        if (metrics.confidenceScore > 80 && state.interruptionCount > 2) {
            state.currentLevel = Math.min(maxLevel, state.currentLevel + 1) as PressureLevel;
            state.escalationTriggers.push(`Escalated to L${state.currentLevel} — candidate too confident`);
        }
    }

    private noInterrupt(level: PressureLevel): InterruptionDecision {
        return {
            shouldInterrupt: false,
            interruptionType: 'NONE',
            text: '',
            ttsText: '',
            pressureLevel: level,
            tactic: '',
            waitBeforeMs: 0,
        };
    }
}
