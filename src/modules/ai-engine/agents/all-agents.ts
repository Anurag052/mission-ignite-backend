import { Injectable } from '@nestjs/common';
import { BaseAgent, AgentExecutionResult } from './base.agent';
import { OllamaClient } from '../ollama/ollama.client';
import { ConcurrencyManager } from '../concurrency/concurrency.manager';
import { AiCacheService } from '../cache/ai-cache.service';

// ═══════════════════════════════════════════════════════════════════════════════
// Input/Output types for each agent
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlannerInput {
    studentName: string;
    menuType: string;
    weakAreas: string;
    avgScore: string;
    hoursPerDay: string;
    weeksRemaining: string;
}

export interface PlannerOutput {
    planTitle: string;
    totalWeeks: number;
    weeklyPlans: Array<{
        week: number;
        focusAreas: string[];
        dailyTasks: Array<{ day: string; tasks: string[]; durationMin: number }>;
        milestones: string[];
    }>;
    recommendations: string[];
}

export interface PsychAnalystInput {
    testType: string;
    response: string;
    timeTaken: string;
}

export interface PsychAnalystOutput {
    testType: string;
    personalityTraits: Array<{ trait: string; score: number; evidence: string }>;
    olqMapping: Array<{ quality: string; strength: string; observation: string }>;
    strengths: string[];
    improvements: string[];
    overallAssessment: string;
}

export interface OlqScorerInput {
    gtoPerformance: string;
    interviewResponses: string;
    psychSummary: string;
}

export interface OlqScorerOutput {
    candidateSummary: string;
    olqScores: Array<{ id: number; name: string; score: number; justification: string }>;
    totalScore: number;
    percentile: number;
    recommendation: string;
}

export interface InterviewInput {
    candidateProfile: string;
    stage: string;
    previousResponses: string;
    focusArea: string;
}

export interface InterviewOutput {
    mode: 'question' | 'evaluation';
    question?: string;
    followUp?: string;
    evaluation?: {
        responseQuality: number;
        olqsDisplayed: string[];
        feedback: string;
        improvementTips: string[];
    };
}

export interface GtoInput {
    taskType: string;
    candidateAction: string;
    groupContext: string;
    timeTaken: string;
}

export interface GtoOutput {
    taskType: string;
    scores: Record<string, number>;
    overallScore: number;
    feedback: string;
    tacticalSuggestions: string[];
    olqsObserved: string[];
}

export interface QuestionGenInput {
    count: string;
    subject: string;
    topic: string;
    difficulty: string;
    menuType: string;
    format: string;
}

export interface QuestionGenOutput {
    subject: string;
    topic: string;
    questions: Array<{
        id: number;
        question: string;
        options: string[] | null;
        correctAnswer: string;
        explanation: string;
        difficulty: string;
        marks: number;
    }>;
}

export interface NotebookInput {
    action: string;
    subject: string;
    content: string;
    studentNotes: string;
}

export interface NotebookOutput {
    action: string;
    output: {
        title: string;
        content: string | any[];
        flashcards?: Array<{ front: string; back: string }>;
        keyPoints?: string[];
        mnemonics?: string[];
    };
}

export interface PdfGenInput {
    reportType: string;
    studentName: string;
    data: string;
    sections: string;
}

export interface PdfGenOutput {
    title: string;
    subtitle: string;
    generatedAt: string;
    sections: Array<{
        heading: string;
        content: string;
        tableData?: Array<{ label: string; value: string }>;
    }>;
    footer: string;
}

export interface QcInput {
    sourceAgent: string;
    agentOutput: string;
    expectedSchema: string;
}

export interface QcOutput {
    sourceAgent: string;
    qualityScore: number;
    isValid: boolean;
    issues: Array<{
        field: string;
        severity: string;
        description: string;
        suggestion: string;
    }>;
    correctedOutput: any | null;
    summary: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent Implementations
// ═══════════════════════════════════════════════════════════════════════════════

@Injectable()
export class PlannerAgent extends BaseAgent<PlannerInput, PlannerOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('planner', o, c, ch, { maxRetries: 3, timeoutMs: 90000 });
    }
}

@Injectable()
export class PsychologicalAnalystAgent extends BaseAgent<PsychAnalystInput, PsychAnalystOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('psychologicalAnalyst', o, c, ch, { maxRetries: 3, timeoutMs: 60000 });
    }

    protected async validate(output: PsychAnalystOutput): Promise<PsychAnalystOutput> {
        // Ensure scores are clamped 1-10
        if (output.personalityTraits) {
            output.personalityTraits = output.personalityTraits.map((t) => ({
                ...t,
                score: Math.max(1, Math.min(10, Math.round(t.score))),
            }));
        }
        return output;
    }
}

@Injectable()
export class OlqScorerAgent extends BaseAgent<OlqScorerInput, OlqScorerOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('olqScorer', o, c, ch, { maxRetries: 3, timeoutMs: 90000 });
    }

    protected async validate(output: OlqScorerOutput): Promise<OlqScorerOutput> {
        // Ensure exactly 15 OLQs and scores are 1-10
        if (output.olqScores) {
            output.olqScores = output.olqScores.map((s) => ({
                ...s,
                score: Math.max(1, Math.min(10, Math.round(s.score))),
            }));
            output.totalScore = output.olqScores.reduce((sum, s) => sum + s.score, 0);
            output.percentile = Math.round((output.totalScore / 150) * 100);
        }
        return output;
    }
}

@Injectable()
export class InterviewOfficerAgent extends BaseAgent<InterviewInput, InterviewOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('interviewOfficer', o, c, ch, { maxRetries: 2, timeoutMs: 45000 });
    }
}

@Injectable()
export class GtoOfficerAgent extends BaseAgent<GtoInput, GtoOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('gtoOfficer', o, c, ch, { maxRetries: 3, timeoutMs: 60000 });
    }

    protected async validate(output: GtoOutput): Promise<GtoOutput> {
        if (output.scores) {
            for (const key of Object.keys(output.scores)) {
                output.scores[key] = Math.max(1, Math.min(10, Math.round(output.scores[key])));
            }
            const vals = Object.values(output.scores);
            output.overallScore = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
        }
        return output;
    }
}

@Injectable()
export class QuestionGeneratorAgent extends BaseAgent<QuestionGenInput, QuestionGenOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('questionGenerator', o, c, ch, { maxRetries: 3, timeoutMs: 90000 });
    }
}

@Injectable()
export class NotebookAgent extends BaseAgent<NotebookInput, NotebookOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('notebook', o, c, ch, { maxRetries: 2, timeoutMs: 60000 });
    }
}

@Injectable()
export class PdfGeneratorAgent extends BaseAgent<PdfGenInput, PdfGenOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('pdfGenerator', o, c, ch, { maxRetries: 2, timeoutMs: 45000 });
    }
}

@Injectable()
export class QualityControlAgent extends BaseAgent<QcInput, QcOutput> {
    constructor(o: OllamaClient, c: ConcurrencyManager, ch: AiCacheService) {
        super('qualityControl', o, c, ch, { maxRetries: 2, timeoutMs: 30000 });
    }
}
