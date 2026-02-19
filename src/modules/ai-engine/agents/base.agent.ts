import { Logger } from '@nestjs/common';
import { OllamaClient, OllamaChatMessage } from '../ollama/ollama.client';
import { ConcurrencyManager } from '../concurrency/concurrency.manager';
import { AiCacheService } from '../cache/ai-cache.service';
import {
    PromptTemplate,
    PROMPT_TEMPLATES,
    renderPrompt,
} from '../prompts/prompt-templates';
import { v4 as uuidv4 } from 'uuid';

export interface AgentExecutionResult<T = any> {
    success: boolean;
    agentName: string;
    taskId: string;
    data: T | null;
    rawResponse: string;
    durationMs: number;
    fromCache: boolean;
    retries: number;
    error?: string;
}

/**
 * Abstract base class for all AI agents.
 * Provides: retry logic, timeout, JSON parsing, caching, concurrency.
 */
export abstract class BaseAgent<TInput extends Record<string, any> = Record<string, string>, TOutput = any> {
    protected readonly logger: Logger;
    protected readonly maxRetries: number;
    protected readonly timeoutMs: number;
    protected readonly template: PromptTemplate;

    constructor(
        protected readonly agentName: string,
        protected readonly ollamaClient: OllamaClient,
        protected readonly concurrency: ConcurrencyManager,
        protected readonly cache: AiCacheService,
        options?: { maxRetries?: number; timeoutMs?: number },
    ) {
        this.logger = new Logger(`Agent:${agentName}`);
        this.maxRetries = options?.maxRetries ?? 3;
        this.timeoutMs = options?.timeoutMs ?? 60000;
        this.template = PROMPT_TEMPLATES[agentName];

        if (!this.template) {
            throw new Error(`No prompt template found for agent: ${agentName}`);
        }
    }

    /**
     * Run the agent with the given input variables.
     * Handles: cache check → concurrency slot → retry loop → JSON parse → cache set.
     */
    async execute(input: TInput): Promise<AgentExecutionResult<TOutput>> {
        const taskId = uuidv4().slice(0, 8);
        const startTime = Date.now();

        // ── 1. Cache check ──────────────────────────────────────────────────
        const inputHash = this.cache.hashInput(JSON.stringify(input));
        const cached = await this.cache.get<TOutput>(this.agentName, inputHash);
        if (cached) {
            return {
                success: true,
                agentName: this.agentName,
                taskId,
                data: cached,
                rawResponse: '',
                durationMs: Date.now() - startTime,
                fromCache: true,
                retries: 0,
            };
        }

        // ── 2. Acquire concurrency slot ─────────────────────────────────────
        await this.concurrency.acquire(taskId);

        let lastError = '';
        let retries = 0;

        try {
            // ── 3. Retry loop ───────────────────────────────────────────────────
            for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
                try {
                    retries = attempt - 1;

                    const systemPrompt = this.template.system;
                    const userPrompt = renderPrompt(this.template.user, input);

                    const messages: OllamaChatMessage[] = [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ];

                    // If JSON format is expected, add a reminder
                    if (this.template.jsonSchema) {
                        messages.push({
                            role: 'user',
                            content: `IMPORTANT: Respond ONLY with valid JSON matching this schema:\n${this.template.jsonSchema}`,
                        });
                    }

                    this.logger.debug(`[${taskId}] Attempt ${attempt}/${this.maxRetries}`);

                    const response = await this.ollamaClient.chat({
                        model: this.ollamaClient.getActiveModel()!,
                        messages,
                        format: 'json',
                        temperature: this.template.temperature,
                        maxTokens: this.template.maxTokens,
                        timeoutMs: this.timeoutMs,
                    });

                    const raw = response.message.content;

                    // ── 4. Parse JSON ───────────────────────────────────────────────
                    const parsed = this.parseJson<TOutput>(raw);

                    // ── 5. Validate output (subclasses can override) ────────────────
                    const validated = await this.validate(parsed);

                    // ── 6. Cache result ─────────────────────────────────────────────
                    await this.cache.set(
                        this.agentName,
                        inputHash,
                        validated,
                        this.template.cacheTtlSec,
                    );

                    return {
                        success: true,
                        agentName: this.agentName,
                        taskId,
                        data: validated,
                        rawResponse: raw,
                        durationMs: Date.now() - startTime,
                        fromCache: false,
                        retries,
                    };
                } catch (err: any) {
                    lastError = err.message;
                    this.logger.warn(
                        `[${taskId}] Attempt ${attempt} failed: ${lastError}`,
                    );

                    // Wait before retry (exponential backoff)
                    if (attempt < this.maxRetries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
                        await this.sleep(delay);
                    }
                }
            }

            // All retries exhausted
            return {
                success: false,
                agentName: this.agentName,
                taskId,
                data: null,
                rawResponse: '',
                durationMs: Date.now() - startTime,
                fromCache: false,
                retries,
                error: `All ${this.maxRetries} retries exhausted. Last error: ${lastError}`,
            };
        } finally {
            this.concurrency.release(taskId);
        }
    }

    // ── JSON parsing with fallback cleanup ──────────────────────────────────────

    protected parseJson<T>(raw: string): T {
        try {
            return JSON.parse(raw) as T;
        } catch {
            // Attempt to extract JSON from markdown code blocks
            const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1].trim()) as T;
            }

            // Attempt to find JSON object/array
            const braceMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
            if (braceMatch) {
                return JSON.parse(braceMatch[1]) as T;
            }

            throw new Error(`Could not parse JSON from agent response`);
        }
    }

    // ── Validation hook (override in subclasses) ────────────────────────────────

    protected async validate(output: TOutput): Promise<TOutput> {
        return output;
    }

    // ── Utility ─────────────────────────────────────────────────────────────────

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
