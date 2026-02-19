import { Injectable, Logger } from '@nestjs/common';
import { StepBackEvent, VoiceMetricsSnapshot } from '../voice/voice-analysis.service';
import { PressureState, InterruptionDecision } from '../pressure/pressure.engine';
import { OllamaClient } from '../../ai-engine/ollama/ollama.client';
import { ConcurrencyManager } from '../../ai-engine/concurrency/concurrency.manager';

/**
 * Post-Test Analysis Service
 *
 * After a GTO simulation session completes, this service generates:
 *   1. Tactical breakdown (where candidate failed, why, what to say instead)
 *   2. Real-time illustrated examples (corrected responses)
 *   3. Visual execution diagram data
 *   4. Mini-class content (GTO basics, command presence, voice projection)
 */

export interface TacticalBreakdown {
    overallGrade: 'A' | 'B' | 'C' | 'D' | 'F';
    overallScore: number;                          // 0-100
    commandPresenceScore: number;                  // 0-100
    voiceProjectionScore: number;                  // 0-100
    planningStructureScore: number;                // 0-100
    interruptionHandlingScore: number;             // 0-100
    summary: string;
    stepBackAnalysis: StepBackBreakdown[];
    correctResponses: CorrectedResponse[];
    executionDiagram: ExecutionNode[];
    miniClassTopics: MiniClassTopic[];
}

export interface StepBackBreakdown {
    event: StepBackEvent;
    whatHappened: string;
    whyItHappened: string;
    whatToSayInstead: string;
    psychologicalInsight: string;
    olqImpacted: string[];
}

export interface CorrectedResponse {
    originalTranscript: string;
    aiChallenge: string;
    candidateReaction: string;              // what they actually said/did
    idealResponse: string;                  // what they should have said
    tacticalNote: string;                   // why the ideal response works
    confidenceRecoveryTip: string;
}

export interface ExecutionNode {
    id: number;
    timestamp: number;
    phase: 'PLANNING' | 'EXECUTION' | 'RECOVERY' | 'LEADERSHIP_MOMENT' | 'FAILURE_POINT';
    label: string;
    confidenceAt: number;
    pressureLevelAt: number;
    wasStepBack: boolean;
    children: number[];                     // IDs of downstream nodes
}

export interface MiniClassTopic {
    id: string;
    title: string;
    category: 'GTO_BASICS' | 'COMMAND_PRESENCE' | 'VOICE_PROJECTION' | 'PLANNING_STRUCTURE' | 'INTERRUPTION_HANDLING';
    content: string;                        // Markdown content
    keyTakeaways: string[];
    practiceExercises: string[];
    duration: string;                       // e.g. "5 min"
}

@Injectable()
export class PostTestAnalysisService {
    private readonly logger = new Logger(PostTestAnalysisService.name);

    constructor(
        private readonly ollamaClient: OllamaClient,
        private readonly concurrency: ConcurrencyManager,
    ) { }

    /**
     * Generate full post-test analysis from session data.
     */
    async generateAnalysis(sessionData: {
        sessionId: string;
        taskType: string;
        transcript: string[];
        stepBackEvents: StepBackEvent[];
        aiInterventions: Array<{ timestamp: number; text: string; type: string; level: number }>;
        pressureState: PressureState;
        durationSec: number;
    }): Promise<TacticalBreakdown> {
        this.logger.log(`Generating post-test analysis for session ${sessionData.sessionId}`);

        // Run AI analysis and local analysis in parallel
        const [aiAnalysis, localAnalysis] = await Promise.all([
            this.generateAiAnalysis(sessionData),
            this.generateLocalAnalysis(sessionData),
        ]);

        return this.mergeAnalysis(aiAnalysis, localAnalysis, sessionData);
    }

    // ── AI-powered analysis (via Ollama) ──────────────────────────────────────────

    private async generateAiAnalysis(sessionData: any): Promise<any> {
        const taskId = `posttest-${sessionData.sessionId}`;
        await this.concurrency.acquire(taskId);

        try {
            const activeModel = this.ollamaClient.getActiveModel();
            if (!activeModel) return null;

            const prompt = `Analyze this GTO simulation session and provide tactical coaching.

SESSION DATA:
- Task Type: ${sessionData.taskType}
- Duration: ${sessionData.durationSec}s
- Total AI Interruptions: ${sessionData.aiInterventions.length}
- Step-back Events: ${sessionData.stepBackEvents.length}
- Max Pressure Level Reached: ${sessionData.pressureState.currentLevel}

CANDIDATE TRANSCRIPT (key moments):
${sessionData.transcript.slice(-20).join('\n')}

STEP-BACK EVENTS:
${JSON.stringify(sessionData.stepBackEvents.slice(-5), null, 2)}

AI INTERVENTIONS:
${JSON.stringify(sessionData.aiInterventions.slice(-8), null, 2)}

Provide a JSON response with:
1. "grade": overall grade A-F
2. "overallScore": 0-100
3. "commandPresence": 0-100
4. "voiceProjection": 0-100
5. "planningStructure": 0-100
6. "interruptionHandling": 0-100
7. "summary": 2-3 sentence overall assessment
8. "correctedResponses": array of { "originalContext", "idealResponse", "tacticalNote" }
9. "psychologicalInsights": array of strings
10. "keyWeaknesses": array of strings`;

            const response = await this.ollamaClient.chat({
                model: activeModel,
                messages: [
                    { role: 'system', content: 'You are an expert SSB GTO assessor. Analyze candidate performance with military precision. Output valid JSON only.' },
                    { role: 'user', content: prompt },
                ],
                format: 'json',
                temperature: 0.3,
                timeoutMs: 90000,
            });

            try {
                return JSON.parse(response.message.content);
            } catch {
                return null;
            }
        } finally {
            this.concurrency.release(taskId);
        }
    }

    // ── Local (rule-based) analysis ───────────────────────────────────────────────

    private generateLocalAnalysis(sessionData: any): Promise<{
        scores: Record<string, number>;
        stepBackBreakdowns: StepBackBreakdown[];
        executionNodes: ExecutionNode[];
    }> {
        const stepBacks = sessionData.stepBackEvents as StepBackEvent[];
        const interventions = sessionData.aiInterventions || [];

        // Score calculation
        const baseScore = 70;
        const stepBackPenalty = Math.min(40, stepBacks.length * 8);
        const pressurePenalty = Math.max(0, (sessionData.pressureState.currentLevel - 2) * 5);
        const overallScore = Math.max(0, baseScore - stepBackPenalty - pressurePenalty);

        const interruptionsHandled = interventions.length - stepBacks.length;
        const interruptionHandling = interventions.length > 0
            ? Math.round((interruptionsHandled / interventions.length) * 100)
            : 100;

        // Generate step-back breakdowns
        const stepBackBreakdowns: StepBackBreakdown[] = stepBacks.map((event) => ({
            event,
            whatHappened: `At ${Math.round(event.timestamp / 1000)}s, after the AI said: "${event.aiChallenge}", you showed ${event.type.toLowerCase().replace(/_/g, ' ')}`,
            whyItHappened: this.diagnoseStepBack(event),
            whatToSayInstead: this.generateIdealResponse(event),
            psychologicalInsight: this.getPsychInsight(event),
            olqImpacted: this.getImpactedOlqs(event),
        }));

        // Build execution timeline
        const executionNodes: ExecutionNode[] = [];
        let nodeId = 0;
        const totalDuration = sessionData.durationSec * 1000;

        // Opening phase
        executionNodes.push({
            id: nodeId++,
            timestamp: 0,
            phase: 'PLANNING',
            label: 'Session Start — Planning Phase',
            confidenceAt: 80,
            pressureLevelAt: 1,
            wasStepBack: false,
            children: [nodeId],
        });

        // Add intervention/step-back nodes
        for (const event of stepBacks) {
            executionNodes.push({
                id: nodeId++,
                timestamp: event.timestamp,
                phase: 'FAILURE_POINT',
                label: `Step-back: ${event.type}`,
                confidenceAt: event.confidenceAfter,
                pressureLevelAt: 0,
                wasStepBack: true,
                children: [nodeId],
            });
        }

        // Closing node
        executionNodes.push({
            id: nodeId,
            timestamp: totalDuration,
            phase: 'EXECUTION',
            label: 'Session End',
            confidenceAt: overallScore,
            pressureLevelAt: sessionData.pressureState.currentLevel,
            wasStepBack: false,
            children: [],
        });

        return Promise.resolve({
            scores: {
                overall: overallScore,
                commandPresence: Math.max(0, 80 - stepBackPenalty),
                voiceProjection: Math.max(0, 75 - stepBacks.filter((s) => s.type === 'VOLUME_DROP' || s.type === 'TONE_DROP').length * 15),
                planningStructure: Math.max(0, 70 - stepBacks.filter((s) => s.type === 'IDEA_ABANDON').length * 20),
                interruptionHandling,
            },
            stepBackBreakdowns,
            executionNodes,
        });
    }

    // ── Merge AI + local analysis ─────────────────────────────────────────────────

    private mergeAnalysis(ai: any, local: any, sessionData: any): TacticalBreakdown {
        const scores = local.scores;

        const overallScore = ai?.overallScore ?? scores.overall;
        const grade = overallScore >= 85 ? 'A' : overallScore >= 70 ? 'B' : overallScore >= 55 ? 'C' : overallScore >= 40 ? 'D' : 'F';

        const correctedResponses: CorrectedResponse[] = (sessionData.stepBackEvents as StepBackEvent[]).map((event, i) => ({
            originalTranscript: event.transcript,
            aiChallenge: event.aiChallenge,
            candidateReaction: `Showed ${event.type.toLowerCase().replace(/_/g, ' ')} (severity: ${event.severity})`,
            idealResponse: ai?.correctedResponses?.[i]?.idealResponse || this.generateIdealResponse(event),
            tacticalNote: ai?.correctedResponses?.[i]?.tacticalNote || 'Maintain your position with calm authority',
            confidenceRecoveryTip: 'Pause for one breath, then restate your point with conviction',
        }));

        return {
            overallGrade: grade,
            overallScore,
            commandPresenceScore: ai?.commandPresence ?? scores.commandPresence,
            voiceProjectionScore: ai?.voiceProjection ?? scores.voiceProjection,
            planningStructureScore: ai?.planningStructure ?? scores.planningStructure,
            interruptionHandlingScore: scores.interruptionHandling,
            summary: ai?.summary || `Session completed with ${sessionData.stepBackEvents.length} step-back events across ${sessionData.aiInterventions.length} AI challenges. Maximum pressure level: ${sessionData.pressureState.currentLevel}/5.`,
            stepBackAnalysis: local.stepBackBreakdowns,
            correctResponses: correctedResponses,
            executionDiagram: local.executionNodes,
            miniClassTopics: this.generateMiniClass(sessionData.stepBackEvents),
        };
    }

    // ── Mini-class generation ─────────────────────────────────────────────────────

    private generateMiniClass(stepBacks: StepBackEvent[]): MiniClassTopic[] {
        const topics: MiniClassTopic[] = [
            {
                id: 'gto-basics',
                title: 'GTO Task Fundamentals',
                category: 'GTO_BASICS',
                content: `## What is a GTO Task?
The GTO (Group Testing Officer) assesses your **practical leadership** through group tasks. Unlike psychological tests, GTO tasks are **live, observable, and dynamic**.

### Key Principles
- **Plan before you act** — 60-second planning saves 5 minutes of chaos
- **Communicate your plan** — others can't follow what they don't understand
- **Delegate clearly** — "Ravi, hold this plank. Amit, tie the rope here."
- **Adapt when challenged** — the GTO WILL interrupt. Your job is to stay steady.

### The GTO is Testing
1. Can you think under time pressure?
2. Can you lead when challenged?
3. Do you include everyone?
4. Do you stay calm when your plan fails?`,
                keyTakeaways: [
                    'GTO tests practical leadership, not theoretical knowledge',
                    'Always plan before acting',
                    'Clear delegation is a sign of confidence',
                ],
                practiceExercises: [
                    'Set a 2-minute timer and plan how to move 4 objects across a room using only 2 tools',
                    'Practice giving instructions to a friend without using "um" or "uh"',
                ],
                duration: '5 min',
            },
            {
                id: 'command-presence',
                title: 'Command Presence & Authority',
                category: 'COMMAND_PRESENCE',
                content: `## Command Presence
Command presence is the **aura of authority** that makes people follow you without question. It's built on:

### Body Language (70% of communication)
- Stand straight, shoulders back
- Plant your feet — no shifting
- Use open gestures, palms forward
- Make eye contact when speaking

### Voice (20% of communication)
- Speak from your diaphragm, not your throat
- Lower pitch = more authority (naturally, don't force it)
- Pause BEFORE important statements — silence commands attention
- Never let your volume drop when challenged

### Words (10% of communication)
- Use short, decisive sentences: "We do X, then Y."
- Never say "I think maybe..." — say "Here's what we'll do."
- Own mistakes instantly: "That didn't work. New plan:"`,
                keyTakeaways: [
                    'Confidence is projected through body, voice, and words — in that order',
                    'Lowering your voice when challenged is the #1 signal of weakness',
                    'Pausing before speaking shows control, not uncertainty',
                ],
                practiceExercises: [
                    'Stand in front of a mirror and give a 1-minute plan. Watch for volume drops.',
                    'Record yourself speaking and count filler words (um, uh, like)',
                    'Practice the "power pause" — count to 2 before every important sentence',
                ],
                duration: '7 min',
            },
            {
                id: 'voice-projection',
                title: 'Voice Projection & Control',
                category: 'VOICE_PROJECTION',
                content: `## Voice Projection Under Pressure
When the GTO challenges you, your voice is the first thing that shows stress. Here's how to control it:

### The 3-Second Rule
When interrupted: STOP → BREATHE → RESPOND. Never react in the same breath.

### Volume Control
- Your baseline volume should be 70% of maximum — this gives you room to increase WITHOUT shouting
- When challenged, **increase volume by 10%** — the opposite of instinct
- Project towards the back of the room, not at the person in front of you

### Pitch Control
- Stress raises pitch (squeaky voice). Counter this consciously.
- Before speaking, hum "mmm" at your natural low pitch.
- End statements with downward inflection (authority), not upward (seeking approval)

### Handling the Interrupt
\`\`\`
GTO: "That doesn't make sense. Why would you do that?"

WEAK: "Oh... uh... I was just thinking maybe..."
↓ (voice drops, eyes break contact)

STRONG: *pause 1 second* "Sir, I'll explain. The reason is X, and the advantage is Y."
↑ (volume steady, eye contact held, clear structure)
\`\`\``,
                keyTakeaways: [
                    'Stop-Breathe-Respond: the 3-second rule saves you from reactive failures',
                    'Raise volume 10% when challenged — counterintuitive but effective',
                    'End sentences with downward pitch for authority',
                ],
                practiceExercises: [
                    'Have a friend interrupt you randomly while you explain something. Practice the 3-second rule.',
                    'Record two versions: one where you trail off, one where you project. Compare.',
                ],
                duration: '6 min',
            },
        ];

        // Add targeted topics based on what went wrong
        const hasVolumeIssues = stepBacks.some((s) => s.type === 'VOLUME_DROP' || s.type === 'TONE_DROP');
        const hasIdeasAbandoned = stepBacks.some((s) => s.type === 'IDEA_ABANDON');
        const hasHesitation = stepBacks.some((s) => s.type === 'HESITATION');

        if (hasIdeasAbandoned) {
            topics.push({
                id: 'planning-structure',
                title: 'Structured Planning Under Pressure',
                category: 'PLANNING_STRUCTURE',
                content: `## Never Abandon Your Plan
When the GTO dismisses your idea, they're testing your **conviction**. Officers must hold ground.

### The OODA Loop (Military Planning)
1. **Observe** — assess the situation (10 sec)
2. **Orient** — identify your resources and constraints (10 sec)
3. **Decide** — commit to ONE plan (10 sec)
4. **Act** — execute without hesitation

### When Your Plan is Challenged
- "Sir, I understand the concern. However, my plan accounts for this because..."
- NEVER say "okay, let me think of something else" — that's surrender
- Modify your plan, don't abandon it: "I'll adjust by doing X instead of Y"`,
                keyTakeaways: [
                    'Abandoning your plan = surrendering leadership',
                    'Modify, don\'t abandon: adjust the plan, keep the direction',
                    'Use OODA Loop for structured 30-second planning',
                ],
                practiceExercises: [
                    'Practice the OODA loop with random scenarios (30 second drill)',
                    'Have someone reject your plan 3 times — practice modifying without abandoning',
                ],
                duration: '5 min',
            });
        }

        if (hasHesitation || hasVolumeIssues) {
            topics.push({
                id: 'interruption-handling',
                title: 'Handling Interruptions Like an Officer',
                category: 'INTERRUPTION_HANDLING',
                content: `## The Art of Being Interrupted
In real military and SSB scenarios, interruptions are **tests of composure**. The GTO interrupts to see if you crack.

### Interrupt Response Framework
| GTO Says | WRONG Response | RIGHT Response |
|----------|---------------|----------------|
| "That won't work" | "Oh... okay" | "Sir, here's why it will: [reason]" |
| "You're wasting time" | *speeds up, gets sloppy* | "Understood sir. My timeline: [X then Y then Z]" |
| "Your team doesn't agree" | *looks at team, hesitates* | "I'll address that. [Name], I've assigned you X because..." |
| "Start over" | *actually starts over* | "Sir, I can improve my current approach by..." |

### The 3 Never Rules
1. Never apologize for your plan
2. Never look down when challenged
3. Never reduce your volume`,
                keyTakeaways: [
                    'Interruptions are tests, not corrections — respond, don\'t retreat',
                    'Hold eye contact and match or exceed your previous volume',
                    'The 3 Never Rules: no apology, no eyes down, no volume drop',
                ],
                practiceExercises: [
                    'Practice the table above with a partner taking the GTO role',
                    'Film yourself being challenged and review your body language',
                ],
                duration: '6 min',
            });
        }

        return topics;
    }

    // ── Utility: diagnose step-backs ──────────────────────────────────────────────

    private diagnoseStepBack(event: StepBackEvent): string {
        const diagnoses: Record<string, string> = {
            VOICE_TREMOR: 'Your voice showed physical stress indicators (tremor/jitter). This is a fight-or-flight response to perceived authority challenge. It signals to the GTO that you lack confidence.',
            HESITATION: 'You paused excessively or used filler words after being challenged. This shows uncertainty and hesitation — the opposite of decisiveness that GTO looks for.',
            IDEA_ABANDON: 'You abandoned your plan after being challenged. This is the clearest sign of psychological step-back. An officer must defend and adapt their plan, not surrender it.',
            TONE_DROP: 'Your pitch dropped significantly after the challenge. A declining tone signals submission and is unconsciously read as "I\'m giving up" by assessors.',
            VOLUME_DROP: 'You got quieter after being challenged. Volume reduction under pressure is the most common indicator of psychological retreat.',
            CONFIDENCE_COLLAPSE: 'Multiple indicators fired simultaneously — your overall confidence score dropped sharply. This represents a full psychological step-back.',
        };
        return diagnoses[event.type] || 'Psychological pressure caused a measurable change in your vocal patterns.';
    }

    private generateIdealResponse(event: StepBackEvent): string {
        const responses: Record<string, string> = {
            VOICE_TREMOR: 'Take one deliberate breath. Then: "Sir, I stand by my approach. Here is why it works: [clear reason]." — maintain volume and eye contact.',
            HESITATION: '"Sir, to be precise: [restate your point in one sentence]. This is the best approach because [one reason]." — zero filler words.',
            IDEA_ABANDON: '"Sir, I understand your point. I\'ll modify my plan: instead of [X], we\'ll do [Y], which addresses your concern while maintaining our objective."',
            TONE_DROP: 'Consciously raise your pitch to baseline level. Start with: "Here\'s what we\'re doing:" — command voice, downward inflection.',
            VOLUME_DROP: 'Project your voice 10% louder than before: "Sir, my plan is clear. Step one: [X]. Step two: [Y]. We execute in [time]."',
            CONFIDENCE_COLLAPSE: 'STOP for 2 seconds. Breathe. Then: "Right. Here\'s the new plan. [Name], you do X. [Name], you do Y. I\'ll coordinate. We move NOW."',
        };
        return responses[event.type] || 'Pause, breathe, then restate your position with clear structure and maintained volume.';
    }

    private getPsychInsight(event: StepBackEvent): string {
        const insights: Record<string, string> = {
            VOICE_TREMOR: 'Voice tremor is an autonomic nervous system response. With practice, you can override it using diaphragmatic breathing before speaking.',
            HESITATION: 'Hesitation often stems from fear of saying the wrong thing. The cure: commit to ANY decision fast rather than seeking the perfect one.',
            IDEA_ABANDON: 'Idea abandonment reveals a need for external approval. Officers must develop internal conviction — your plan need not be perfect, it needs to be owned.',
            TONE_DROP: 'Tone drop is often unconscious. Record yourself practicing and you will become aware of the pattern.',
            VOLUME_DROP: 'Volume drop is the most common SSB failure indicator. SSB boards specifically train to notice it.',
            CONFIDENCE_COLLAPSE: 'Confidence collapse happens when multiple stressors stack. Build resilience by practicing with progressively harder challenges.',
        };
        return insights[event.type] || 'Awareness of the pattern is the first step to correcting it.';
    }

    private getImpactedOlqs(event: StepBackEvent): string[] {
        const olqMap: Record<string, string[]> = {
            VOICE_TREMOR: ['Self Confidence', 'Courage', 'Stamina'],
            HESITATION: ['Speed of Decision', 'Self Confidence', 'Effective Intelligence'],
            IDEA_ABANDON: ['Determination', 'Self Confidence', 'Initiative'],
            TONE_DROP: ['Power of Expression', 'Self Confidence', 'Ability to Influence'],
            VOLUME_DROP: ['Power of Expression', 'Courage', 'Self Confidence'],
            CONFIDENCE_COLLAPSE: ['Self Confidence', 'Courage', 'Determination', 'Stamina'],
        };
        return olqMap[event.type] || ['Self Confidence'];
    }
}
