import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractedPdf } from './pdf-extractor.service';

// ── Output types ──────────────────────────────────────────────────────────────

export interface NotesOutput {
    sections: Array<{
        heading: string;
        content: string;
        keyPoints: string[];
        definitions: Array<{ term: string; meaning: string }>;
    }>;
    summary: string;
    importantFacts: string[];
    examTips: string[];
}

export interface QuizOutput {
    questions: Array<{
        id: number;
        question: string;
        options: { a: string; b: string; c: string; d: string };
        correctAnswer: 'a' | 'b' | 'c' | 'd';
        explanation: string;
        difficulty: 'EASY' | 'MEDIUM' | 'HARD';
        topic: string;
    }>;
    totalQuestions: number;
    estimatedTime: string;
}

export interface InterviewOutput {
    questions: Array<{
        id: number;
        question: string;
        idealAnswer: string;
        followUp: string;
        assessedSkill: string;
        difficulty: 'EASY' | 'MEDIUM' | 'HARD';
    }>;
    totalQuestions: number;
    interviewType: string;
}

export interface CapfAcOutput {
    questions: Array<{
        id: number;
        type: 'ANALYTICAL' | 'SITUATIONAL' | 'ESSAY';
        scenario?: string;
        question: string;
        approach: string;
        markingScheme: string;
        assessedSkills: string[];
    }>;
    totalQuestions: number;
}

export interface AudioOverviewOutput {
    script: string;
    durationEstimate: string;
    wordCount: number;
    sections: Array<{ title: string; text: string; durationSec: number }>;
    ttsConfig: {
        rate: number;
        pitch: number;
        voice: string;
    };
}

export type NotebookAiOutput =
    | { type: 'NOTES'; data: NotesOutput }
    | { type: 'QUIZ'; data: QuizOutput }
    | { type: 'INTERVIEW'; data: InterviewOutput }
    | { type: 'CAPF_AC'; data: CapfAcOutput }
    | { type: 'AUDIO_OVERVIEW'; data: AudioOverviewOutput };

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class NotebookAiService {
    private readonly logger = new Logger(NotebookAiService.name);
    private readonly ollamaUrl: string;
    private readonly model: string;

    constructor(private readonly config: ConfigService) {
        this.ollamaUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
        this.model = this.config.get<string>('OLLAMA_MODEL', 'gemma2:2b');
    }

    /**
     * Generate all 5 content types in parallel.
     */
    async generateAll(extracted: ExtractedPdf, topic: string): Promise<NotebookAiOutput[]> {
        this.logger.log(`Generating all content types for: ${topic}`);

        const [notes, quiz, interview, capf, audio] = await Promise.allSettled([
            this.generateNotes(extracted, topic),
            this.generateQuiz(extracted, topic),
            this.generateInterview(extracted, topic),
            this.generateCapfAc(extracted, topic),
            this.generateAudioOverview(extracted, topic),
        ]);

        const results: NotebookAiOutput[] = [];

        if (notes.status === 'fulfilled') results.push({ type: 'NOTES', data: notes.value });
        else this.logger.error(`Notes generation failed: ${notes.reason}`);

        if (quiz.status === 'fulfilled') results.push({ type: 'QUIZ', data: quiz.value });
        else this.logger.error(`Quiz generation failed: ${quiz.reason}`);

        if (interview.status === 'fulfilled') results.push({ type: 'INTERVIEW', data: interview.value });
        else this.logger.error(`Interview generation failed: ${interview.reason}`);

        if (capf.status === 'fulfilled') results.push({ type: 'CAPF_AC', data: capf.value });
        else this.logger.error(`CAPF AC generation failed: ${capf.reason}`);

        if (audio.status === 'fulfilled') results.push({ type: 'AUDIO_OVERVIEW', data: audio.value });
        else this.logger.error(`Audio overview generation failed: ${audio.reason}`);

        return results;
    }

    // ── Notes ─────────────────────────────────────────────────────────────────────

    async generateNotes(extracted: ExtractedPdf, topic: string): Promise<NotesOutput> {
        this.logger.log(`Generating notes for: ${topic}`);

        // Summarize each chunk, then synthesize
        const chunkSummaries: string[] = [];
        for (const chunk of extracted.chunks.slice(0, 8)) {  // max 8 chunks
            const summary = await this.callOllama(
                `You are an expert study notes creator for Indian defence exams (CAPF AC, SSB, OTA).

Extract and structure the key information from this text into concise study notes.
Focus on: definitions, key facts, important concepts, dates, and exam-relevant points.

TEXT:
${chunk}

Respond with a JSON object:
{
  "heading": "section title",
  "content": "2-3 sentence summary",
  "keyPoints": ["point 1", "point 2", "point 3"],
  "definitions": [{"term": "...", "meaning": "..."}]
}`,
                { format: 'json' },
            );

            try {
                chunkSummaries.push(summary);
            } catch {
                chunkSummaries.push(JSON.stringify({ heading: 'Section', content: chunk.slice(0, 200), keyPoints: [], definitions: [] }));
            }
        }

        // Synthesize into final notes
        const synthesis = await this.callOllama(
            `You are creating comprehensive study notes for: "${topic}"

Based on these section summaries, create a final structured notes document.

SUMMARIES:
${chunkSummaries.join('\n\n')}

Respond with JSON:
{
  "sections": [{"heading": "...", "content": "...", "keyPoints": ["..."], "definitions": [{"term": "...", "meaning": "..."}]}],
  "summary": "2-3 sentence executive summary",
  "importantFacts": ["fact 1", "fact 2", ...],
  "examTips": ["tip 1", "tip 2", ...]
}`,
            { format: 'json' },
        );

        return this.parseJsonOrFallback<NotesOutput>(synthesis, this.fallbackNotes(topic, extracted));
    }

    // ── Quiz ──────────────────────────────────────────────────────────────────────

    async generateQuiz(extracted: ExtractedPdf, topic: string): Promise<QuizOutput> {
        this.logger.log(`Generating quiz for: ${topic}`);

        const textSample = extracted.chunks.slice(0, 3).join('\n\n').slice(0, 8000);

        const response = await this.callOllama(
            `You are an expert question setter for CAPF AC, SSB, and OTA examinations.

Create 20 multiple-choice questions based on this content about "${topic}".
Mix difficulty: 7 EASY, 8 MEDIUM, 5 HARD.
Each question must have 4 options with exactly one correct answer.

CONTENT:
${textSample}

Respond with JSON:
{
  "questions": [
    {
      "id": 1,
      "question": "...",
      "options": {"a": "...", "b": "...", "c": "...", "d": "..."},
      "correctAnswer": "b",
      "explanation": "...",
      "difficulty": "EASY",
      "topic": "sub-topic name"
    }
  ],
  "totalQuestions": 20,
  "estimatedTime": "25 minutes"
}`,
            { format: 'json' },
        );

        return this.parseJsonOrFallback<QuizOutput>(response, this.fallbackQuiz(topic));
    }

    // ── Interview Questions ───────────────────────────────────────────────────────

    async generateInterview(extracted: ExtractedPdf, topic: string): Promise<InterviewOutput> {
        this.logger.log(`Generating interview questions for: ${topic}`);

        const textSample = extracted.chunks[0]?.slice(0, 6000) || '';

        const response = await this.callOllama(
            `You are an SSB/CAPF AC interview board member.

Generate 15 interview questions based on this content about "${topic}".
Questions should test depth of knowledge, analytical thinking, and application.
Include follow-up questions to probe deeper.

CONTENT:
${textSample}

Respond with JSON:
{
  "questions": [
    {
      "id": 1,
      "question": "...",
      "idealAnswer": "comprehensive ideal answer...",
      "followUp": "follow-up question to probe deeper",
      "assessedSkill": "Critical Thinking / Knowledge Depth / Application",
      "difficulty": "MEDIUM"
    }
  ],
  "totalQuestions": 15,
  "interviewType": "Knowledge & Application"
}`,
            { format: 'json' },
        );

        return this.parseJsonOrFallback<InterviewOutput>(response, this.fallbackInterview(topic));
    }

    // ── CAPF AC Questions ─────────────────────────────────────────────────────────

    async generateCapfAc(extracted: ExtractedPdf, topic: string): Promise<CapfAcOutput> {
        this.logger.log(`Generating CAPF AC questions for: ${topic}`);

        const textSample = extracted.chunks.slice(0, 2).join('\n\n').slice(0, 8000);

        const response = await this.callOllama(
            `You are a UPSC CAPF AC paper setter.

Generate 10 CAPF AC-style questions based on this content about "${topic}".
Mix: 4 analytical, 4 situational, 2 essay-type.
Situational questions should involve law enforcement, border security, or civil administration scenarios.

CONTENT:
${textSample}

Respond with JSON:
{
  "questions": [
    {
      "id": 1,
      "type": "ANALYTICAL",
      "scenario": null,
      "question": "...",
      "approach": "How to structure the answer...",
      "markingScheme": "Content 40% | Analysis 30% | Clarity 20% | Examples 10%",
      "assessedSkills": ["Critical Analysis", "Reasoning"]
    }
  ],
  "totalQuestions": 10
}`,
            { format: 'json' },
        );

        return this.parseJsonOrFallback<CapfAcOutput>(response, this.fallbackCapfAc(topic));
    }

    // ── Audio Overview ────────────────────────────────────────────────────────────

    async generateAudioOverview(extracted: ExtractedPdf, topic: string): Promise<AudioOverviewOutput> {
        this.logger.log(`Generating audio overview for: ${topic}`);

        const textSample = extracted.chunks.slice(0, 4).join('\n\n').slice(0, 10000);

        const response = await this.callOllama(
            `You are creating a 5-minute audio overview script (like a podcast/lecture) about "${topic}".

Write a natural, engaging narration script that covers the key points.
Target: ~700 words, conversational tone, suitable for text-to-speech.
Structure: Introduction → 3-4 main sections → Conclusion with exam tips.

CONTENT TO SUMMARIZE:
${textSample}

Respond with JSON:
{
  "script": "Full narration script here...",
  "durationEstimate": "5 minutes",
  "wordCount": 700,
  "sections": [
    {"title": "Introduction", "text": "...", "durationSec": 30},
    {"title": "Main Point 1", "text": "...", "durationSec": 60}
  ],
  "ttsConfig": {"rate": 0.95, "pitch": 0.9, "voice": "en-IN"}
}`,
            { format: 'json' },
        );

        return this.parseJsonOrFallback<AudioOverviewOutput>(response, this.fallbackAudioOverview(topic, extracted));
    }

    // ── Ollama HTTP client ────────────────────────────────────────────────────────

    private async callOllama(prompt: string, options: { format?: string } = {}): Promise<string> {
        try {
            const body: any = {
                model: this.model,
                prompt,
                stream: false,
                options: { temperature: 0.3, num_predict: 2048 },
            };
            if (options.format === 'json') body.format = 'json';

            const res = await fetch(`${this.ollamaUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120_000),  // 2 min timeout
            });

            if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
            const data: any = await res.json();
            return data.response || '';
        } catch (err) {
            this.logger.warn(`Ollama call failed: ${err.message}`);
            return '{}';
        }
    }

    private parseJsonOrFallback<T>(raw: string, fallback: T): T {
        try {
            // Extract JSON from response (Ollama sometimes wraps it)
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]) as T;
            return JSON.parse(raw) as T;
        } catch {
            this.logger.warn('JSON parse failed, using fallback');
            return fallback;
        }
    }

    // ── Fallbacks (template-based when Ollama unavailable) ────────────────────────

    private fallbackNotes(topic: string, extracted: ExtractedPdf): NotesOutput {
        return {
            sections: [
                {
                    heading: `Overview — ${topic}`,
                    content: extracted.text.slice(0, 500),
                    keyPoints: ['Key concept 1', 'Key concept 2', 'Key concept 3'],
                    definitions: [],
                },
            ],
            summary: `Study notes for ${topic} extracted from uploaded PDF (${extracted.pageCount} pages, ${extracted.metadata.wordCount} words).`,
            importantFacts: ['Fact 1 from the document', 'Fact 2 from the document'],
            examTips: ['Focus on key definitions', 'Practice application questions'],
        };
    }

    private fallbackQuiz(topic: string): QuizOutput {
        return {
            questions: Array.from({ length: 20 }, (_, i) => ({
                id: i + 1,
                question: `Question ${i + 1} about ${topic}`,
                options: { a: 'Option A', b: 'Option B (Correct)', c: 'Option C', d: 'Option D' },
                correctAnswer: 'b' as const,
                explanation: `Explanation for question ${i + 1}`,
                difficulty: (['EASY', 'MEDIUM', 'HARD'] as const)[i % 3],
                topic,
            })),
            totalQuestions: 20,
            estimatedTime: '25 minutes',
        };
    }

    private fallbackInterview(topic: string): InterviewOutput {
        return {
            questions: Array.from({ length: 15 }, (_, i) => ({
                id: i + 1,
                question: `Interview question ${i + 1} about ${topic}`,
                idealAnswer: `Comprehensive answer covering key aspects of ${topic}`,
                followUp: `Can you elaborate on the practical implications?`,
                assessedSkill: 'Knowledge Depth',
                difficulty: (['EASY', 'MEDIUM', 'HARD'] as const)[i % 3],
            })),
            totalQuestions: 15,
            interviewType: 'Knowledge & Application',
        };
    }

    private fallbackCapfAc(topic: string): CapfAcOutput {
        return {
            questions: Array.from({ length: 10 }, (_, i) => ({
                id: i + 1,
                type: (['ANALYTICAL', 'SITUATIONAL', 'ESSAY'] as const)[i % 3],
                scenario: i % 3 === 1 ? `Scenario related to ${topic}` : undefined,
                question: `CAPF AC question ${i + 1} about ${topic}`,
                approach: 'Structure: identify → analyze → conclude → recommend',
                markingScheme: 'Content 40% | Analysis 30% | Clarity 20% | Examples 10%',
                assessedSkills: ['Critical Analysis', 'Reasoning'],
            })),
            totalQuestions: 10,
        };
    }

    private fallbackAudioOverview(topic: string, extracted: ExtractedPdf): AudioOverviewOutput {
        const intro = `Welcome to this audio overview of ${topic}. This material covers ${extracted.pageCount} pages of content with approximately ${extracted.metadata.wordCount} words.`;
        const body = `Let's explore the key concepts. ${extracted.text.slice(0, 400).replace(/\n/g, ' ')}`;
        const conclusion = `That concludes our overview of ${topic}. Focus on the key points and practice the quiz questions for exam preparation.`;
        const script = `${intro}\n\n${body}\n\n${conclusion}`;

        return {
            script,
            durationEstimate: '5 minutes',
            wordCount: script.split(/\s+/).length,
            sections: [
                { title: 'Introduction', text: intro, durationSec: 30 },
                { title: 'Key Concepts', text: body, durationSec: 240 },
                { title: 'Conclusion', text: conclusion, durationSec: 30 },
            ],
            ttsConfig: { rate: 0.95, pitch: 0.9, voice: 'en-IN' },
        };
    }
}
