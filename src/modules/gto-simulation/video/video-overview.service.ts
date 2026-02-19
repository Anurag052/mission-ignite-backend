import { Injectable, Logger } from '@nestjs/common';
import { OllamaClient } from '../../ai-engine/ollama/ollama.client';
import { ConcurrencyManager } from '../../ai-engine/concurrency/concurrency.manager';
import { TacticalBreakdown, MiniClassTopic, StepBackBreakdown } from '../analysis/post-test-analysis.service';

/**
 * NotebookLM-Style Video Overview System
 *
 * Generates structured slide decks from post-test analysis and mini-class content,
 * then provides data for the frontend to:
 *   1. Render slides with synchronized TTS narration
 *   2. Export frames as a playable lesson video
 *
 * Architecture:
 *   - Backend generates slide data (structured JSON with speaker notes)
 *   - Backend generates TTS audio chunks via local TTS (espeak/piper)
 *   - Frontend renders slides + plays audio in sequence
 *   - Frontend can capture frames via canvas and export as WebM/MP4
 */

export interface Slide {
    id: number;
    type: 'TITLE' | 'CONTENT' | 'DIAGRAM' | 'TABLE' | 'CODE_EXAMPLE' | 'COMPARISON' | 'SUMMARY' | 'EXERCISE';
    title: string;
    subtitle?: string;
    content: string[];                       // Bullet points or paragraphs
    tableData?: Array<{ label: string; value: string }>;
    comparisonData?: { left: { title: string; items: string[] }; right: { title: string; items: string[] } };
    diagramData?: { nodes: Array<{ id: string; label: string; type: string }>; edges: Array<{ from: string; to: string; label?: string }> };
    speakerNotes: string;                    // TTS narration text
    durationSec: number;                     // How long this slide shows
    background: 'DARK' | 'LIGHT' | 'GRADIENT' | 'ACCENT';
    animation: 'FADE_IN' | 'SLIDE_LEFT' | 'ZOOM' | 'NONE';
}

export interface VideoOverviewPlan {
    title: string;
    subtitle: string;
    totalSlides: number;
    estimatedDurationSec: number;
    slides: Slide[];
    ttsConfig: {
        engine: 'LOCAL_PIPER' | 'LOCAL_ESPEAK' | 'BROWSER_SPEECH_API';
        voice: string;
        rate: number;
        pitch: number;
    };
}

@Injectable()
export class VideoOverviewService {
    private readonly logger = new Logger(VideoOverviewService.name);

    constructor(
        private readonly ollamaClient: OllamaClient,
        private readonly concurrency: ConcurrencyManager,
    ) { }

    // ── Generate full video plan from tactical breakdown ──────────────────────────

    generateFromAnalysis(analysis: TacticalBreakdown, sessionTaskType: string): VideoOverviewPlan {
        this.logger.log('Generating video overview from analysis');

        const slides: Slide[] = [];
        let slideId = 0;

        // ── 1. Title slide ────────────────────────────────────────────────
        slides.push({
            id: slideId++,
            type: 'TITLE',
            title: 'GTO Simulation — Performance Review',
            subtitle: `Task: ${sessionTaskType} | Grade: ${analysis.overallGrade} | Score: ${analysis.overallScore}/100`,
            content: [],
            speakerNotes: `Welcome to your GTO simulation performance review. You completed a ${sessionTaskType} task and received a grade of ${analysis.overallGrade} with an overall score of ${analysis.overallScore} out of 100. Let's break down your performance in detail.`,
            durationSec: 8,
            background: 'DARK',
            animation: 'FADE_IN',
        });

        // ── 2. Score overview ─────────────────────────────────────────────
        slides.push({
            id: slideId++,
            type: 'TABLE',
            title: 'Performance Scores',
            content: ['Your scores across the four key assessment areas:'],
            tableData: [
                { label: 'Command Presence', value: `${analysis.commandPresenceScore}/100` },
                { label: 'Voice Projection', value: `${analysis.voiceProjectionScore}/100` },
                { label: 'Planning Structure', value: `${analysis.planningStructureScore}/100` },
                { label: 'Interruption Handling', value: `${analysis.interruptionHandlingScore}/100` },
                { label: 'Overall', value: `${analysis.overallScore}/100 (${analysis.overallGrade})` },
            ],
            speakerNotes: `Here are your detailed scores. Command presence: ${analysis.commandPresenceScore}. Voice projection: ${analysis.voiceProjectionScore}. Planning structure: ${analysis.planningStructureScore}. Interruption handling: ${analysis.interruptionHandlingScore}. Your weakest area needs the most attention going forward.`,
            durationSec: 12,
            background: 'GRADIENT',
            animation: 'SLIDE_LEFT',
        });

        // ── 3. Summary ────────────────────────────────────────────────────
        slides.push({
            id: slideId++,
            type: 'CONTENT',
            title: 'Assessment Summary',
            content: [analysis.summary],
            speakerNotes: analysis.summary,
            durationSec: 10,
            background: 'LIGHT',
            animation: 'FADE_IN',
        });

        // ── 4. Step-back analysis slides ──────────────────────────────────
        if (analysis.stepBackAnalysis.length > 0) {
            slides.push({
                id: slideId++,
                type: 'TITLE',
                title: 'Where You Stepped Back',
                subtitle: `${analysis.stepBackAnalysis.length} psychological pressure point(s) detected`,
                content: [],
                speakerNotes: `Now let's examine the ${analysis.stepBackAnalysis.length} moments where you showed psychological step-back. Understanding these moments is the key to improving.`,
                durationSec: 6,
                background: 'ACCENT',
                animation: 'ZOOM',
            });

            for (const sb of analysis.stepBackAnalysis) {
                slides.push(this.buildStepBackSlide(slideId++, sb));
            }
        }

        // ── 5. Corrected responses ────────────────────────────────────────
        if (analysis.correctResponses.length > 0) {
            slides.push({
                id: slideId++,
                type: 'TITLE',
                title: 'What To Say Instead',
                subtitle: 'Real-time illustrated corrections',
                content: [],
                speakerNotes: 'Here are the corrected responses. For each moment where you stepped back, I will show you exactly what to say instead.',
                durationSec: 5,
                background: 'DARK',
                animation: 'FADE_IN',
            });

            for (const cr of analysis.correctResponses) {
                slides.push({
                    id: slideId++,
                    type: 'COMPARISON',
                    title: 'Correct Execution',
                    content: [],
                    comparisonData: {
                        left: {
                            title: '❌ Your Response',
                            items: [
                                `AI challenged: "${cr.aiChallenge}"`,
                                `You reacted: ${cr.candidateReaction}`,
                                `Transcript: "${cr.originalTranscript}"`,
                            ],
                        },
                        right: {
                            title: '✅ Ideal Response',
                            items: [
                                `Say this: "${cr.idealResponse}"`,
                                `Why: ${cr.tacticalNote}`,
                                `Recovery: ${cr.confidenceRecoveryTip}`,
                            ],
                        },
                    },
                    speakerNotes: `When the AI said "${cr.aiChallenge}", you ${cr.candidateReaction}. Instead, you should have said: "${cr.idealResponse}". ${cr.tacticalNote}.`,
                    durationSec: 15,
                    background: 'LIGHT',
                    animation: 'SLIDE_LEFT',
                });
            }
        }

        // ── 6. Execution diagram ──────────────────────────────────────────
        if (analysis.executionDiagram.length > 0) {
            slides.push({
                id: slideId++,
                type: 'DIAGRAM',
                title: 'Execution Timeline',
                subtitle: 'Visual diagram of your session',
                content: ['Green = confident moments | Red = step-back points | Blue = recovery'],
                diagramData: {
                    nodes: analysis.executionDiagram.map((n) => ({
                        id: String(n.id),
                        label: `${n.label}\nConfidence: ${n.confidenceAt}`,
                        type: n.wasStepBack ? 'FAILURE' : n.phase === 'PLANNING' ? 'START' : 'NORMAL',
                    })),
                    edges: analysis.executionDiagram
                        .filter((n) => n.children.length > 0)
                        .flatMap((n) => n.children.map((childId) => ({
                            from: String(n.id),
                            to: String(childId),
                        }))),
                },
                speakerNotes: 'This diagram shows your session timeline. Each node represents a key moment. Red nodes are where you stepped back. Notice how your confidence changed over time.',
                durationSec: 12,
                background: 'DARK',
                animation: 'ZOOM',
            });
        }

        // ── 7. Mini-class slides ──────────────────────────────────────────
        slides.push({
            id: slideId++,
            type: 'TITLE',
            title: 'Mini Coaching Class',
            subtitle: 'Targeted lessons based on your performance',
            content: [],
            speakerNotes: 'Now let me walk you through targeted coaching lessons based on your specific areas of improvement.',
            durationSec: 5,
            background: 'GRADIENT',
            animation: 'FADE_IN',
        });

        for (const topic of analysis.miniClassTopics) {
            slides.push(...this.buildMiniClassSlides(slideId, topic));
            slideId += 3; // Each topic generates ~3 slides
        }

        // ── 8. Closing slide ──────────────────────────────────────────────
        slides.push({
            id: slideId++,
            type: 'SUMMARY',
            title: 'Next Steps',
            content: [
                'Practice the corrected responses daily (5 minutes)',
                'Record yourself and compare volume/pitch before and after',
                'Do another GTO simulation in 2-3 days',
                'Focus on your weakest score area first',
                `Target: improve your ${analysis.overallGrade === 'F' ? 'overall confidence' : 'weakest metric'} by at least 15 points`,
            ],
            speakerNotes: 'Here are your next steps. Practice the corrected responses daily for 5 minutes. Record yourself and compare your volume and pitch. Do another simulation in 2 to 3 days. Focus on your weakest score first. You can do this.',
            durationSec: 10,
            background: 'DARK',
            animation: 'FADE_IN',
        });

        const estimatedDuration = slides.reduce((sum, s) => sum + s.durationSec, 0);

        return {
            title: `GTO ${sessionTaskType} — Performance Review`,
            subtitle: `Grade: ${analysis.overallGrade} | Score: ${analysis.overallScore}/100`,
            totalSlides: slides.length,
            estimatedDurationSec: estimatedDuration,
            slides,
            ttsConfig: {
                engine: 'BROWSER_SPEECH_API',
                voice: 'en-IN',
                rate: 0.95,
                pitch: 0.9,
            },
        };
    }

    // ── Generate standalone lesson video plan ─────────────────────────────────────

    generateLessonPlan(topic: MiniClassTopic): VideoOverviewPlan {
        const slides = this.buildMiniClassSlides(0, topic);

        return {
            title: topic.title,
            subtitle: topic.category.replace(/_/g, ' '),
            totalSlides: slides.length,
            estimatedDurationSec: slides.reduce((sum, s) => sum + s.durationSec, 0),
            slides,
            ttsConfig: {
                engine: 'BROWSER_SPEECH_API',
                voice: 'en-IN',
                rate: 0.95,
                pitch: 0.9,
            },
        };
    }

    // ── AI-generated slides for custom topics ─────────────────────────────────────

    async generateCustomSlides(topic: string, context: string): Promise<Slide[]> {
        const taskId = `video-${Date.now()}`;
        await this.concurrency.acquire(taskId);

        try {
            const model = this.ollamaClient.getActiveModel();
            if (!model) return [];

            const response = await this.ollamaClient.chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: 'You generate structured slide presentations for military training. Output valid JSON: { "slides": [{ "title": string, "bullets": string[], "speakerNotes": string, "durationSec": number }] }',
                    },
                    {
                        role: 'user',
                        content: `Create a 5-7 slide presentation on: "${topic}"\nContext: ${context}\nKeep it practical and military-focused.`,
                    },
                ],
                format: 'json',
                temperature: 0.4,
                timeoutMs: 60000,
            });

            const parsed = JSON.parse(response.message.content);
            return (parsed.slides || []).map((s: any, i: number) => ({
                id: i,
                type: 'CONTENT' as const,
                title: s.title,
                content: s.bullets || [],
                speakerNotes: s.speakerNotes || '',
                durationSec: s.durationSec || 10,
                background: i % 2 === 0 ? 'DARK' : 'LIGHT' as const,
                animation: 'FADE_IN' as const,
            }));
        } catch (err) {
            this.logger.error('Custom slide gen failed', err);
            return [];
        } finally {
            this.concurrency.release(taskId);
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────────

    private buildStepBackSlide(id: number, sb: StepBackBreakdown): Slide {
        return {
            id,
            type: 'CONTENT',
            title: `Step-Back: ${sb.event.type.replace(/_/g, ' ')}`,
            subtitle: `Severity: ${sb.event.severity} | Confidence: ${sb.event.confidenceBefore} → ${sb.event.confidenceAfter}`,
            content: [
                `**What happened:** ${sb.whatHappened}`,
                `**Why:** ${sb.whyItHappened}`,
                `**OLQs impacted:** ${sb.olqImpacted.join(', ')}`,
                `**Psychological insight:** ${sb.psychologicalInsight}`,
            ],
            speakerNotes: `${sb.whatHappened}. ${sb.whyItHappened}. This impacted your ${sb.olqImpacted.join(' and ')} scores. ${sb.psychologicalInsight}`,
            durationSec: 15,
            background: 'ACCENT',
            animation: 'SLIDE_LEFT',
        };
    }

    private buildMiniClassSlides(startId: number, topic: MiniClassTopic): Slide[] {
        const slides: Slide[] = [];

        // Topic title
        slides.push({
            id: startId,
            type: 'TITLE',
            title: topic.title,
            subtitle: `Category: ${topic.category.replace(/_/g, ' ')} | Duration: ${topic.duration}`,
            content: [],
            speakerNotes: `Let's talk about ${topic.title}. This is a ${topic.duration} lesson that will help you improve.`,
            durationSec: 5,
            background: 'GRADIENT',
            animation: 'ZOOM',
        });

        // Content (split markdown into slides)
        const sections = topic.content.split(/^## /m).filter(Boolean);
        for (let i = 0; i < Math.min(sections.length, 3); i++) {
            const lines = sections[i].split('\n').filter(Boolean);
            const title = lines[0] || topic.title;
            const bullets = lines.slice(1).map((l) => l.replace(/^[-*] /, '').trim()).filter(Boolean).slice(0, 5);

            slides.push({
                id: startId + 1 + i,
                type: 'CONTENT',
                title,
                content: bullets,
                speakerNotes: bullets.join('. '),
                durationSec: 12,
                background: i % 2 === 0 ? 'LIGHT' : 'DARK',
                animation: 'FADE_IN',
            });
        }

        // Key takeaways + exercises
        slides.push({
            id: startId + sections.length + 1,
            type: 'EXERCISE',
            title: 'Key Takeaways & Practice',
            content: [
                ...topic.keyTakeaways.map((t) => `✅ ${t}`),
                '',
                ...topic.practiceExercises.map((e) => `📝 ${e}`),
            ],
            speakerNotes: `Key takeaways: ${topic.keyTakeaways.join('. ')}. Your practice exercises are: ${topic.practiceExercises.join('. ')}.`,
            durationSec: 10,
            background: 'GRADIENT',
            animation: 'SLIDE_LEFT',
        });

        return slides;
    }
}
