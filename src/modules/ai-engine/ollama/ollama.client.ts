import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OllamaModel {
    name: string;
    size: number;
    digest: string;
    modifiedAt: string;
}

export interface OllamaChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface OllamaGenerateOptions {
    model: string;
    messages: OllamaChatMessage[];
    format?: 'json';
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
}

export interface OllamaResponse {
    model: string;
    message: { role: string; content: string };
    totalDuration: number;
    evalCount: number;
}

// Models ranked by preference — smallest first (for mobile / low-RAM)
const MODEL_PRIORITY = [
    { name: 'qwen2.5:1.5b', size: 950 },     // ~950 MB
    { name: 'gemma2:2b', size: 1600 },        // ~1.6 GB
    { name: 'phi3:mini', size: 2300 },         // ~2.3 GB
    { name: 'llama3.2:3b', size: 2000 },       // ~2 GB
    { name: 'tinyllama:1.1b', size: 640 },     // ~640 MB
];

@Injectable()
export class OllamaClient implements OnModuleInit {
    private readonly logger = new Logger(OllamaClient.name);
    private baseUrl: string;
    private activeModel: string | null = null;
    private isHealthy = false;

    constructor(private readonly config: ConfigService) {
        this.baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
    }

    async onModuleInit() {
        await this.healthCheck();
        if (this.isHealthy) {
            await this.detectOrDownloadModel();
        }
    }

    // ── Health check ──────────────────────────────────────────────────────────────

    async healthCheck(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(5000),
            });
            this.isHealthy = res.ok;
            if (this.isHealthy) this.logger.log('✅ Ollama is reachable');
            else this.logger.warn('⚠️ Ollama returned non-OK status');
            return this.isHealthy;
        } catch {
            this.isHealthy = false;
            this.logger.warn('⚠️ Ollama is not reachable — AI features will be disabled');
            return false;
        }
    }

    // ── Model auto-detection ──────────────────────────────────────────────────────

    async listLocalModels(): Promise<OllamaModel[]> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tags`);
            const data = (await res.json()) as { models: OllamaModel[] };
            return data.models || [];
        } catch {
            return [];
        }
    }

    async detectOrDownloadModel(): Promise<string | null> {
        const localModels = await this.listLocalModels();
        const localNames = localModels.map((m) => m.name.split(':')[0] + ':' + (m.name.split(':')[1] || 'latest'));

        this.logger.log(`Found ${localModels.length} local models: ${localNames.join(', ') || 'none'}`);

        // Try to find an existing model in priority order
        for (const preferred of MODEL_PRIORITY) {
            const match = localNames.find((n) => n.startsWith(preferred.name.split(':')[0]));
            if (match) {
                this.activeModel = match;
                this.logger.log(`🎯 Using existing model: ${this.activeModel}`);
                return this.activeModel;
            }
        }

        // No suitable model found — auto-download the smallest one
        const target = MODEL_PRIORITY[MODEL_PRIORITY.length - 1]; // tinyllama (smallest)
        this.logger.log(`📥 No models found. Auto-downloading ${target.name} (~${target.size} MB)...`);

        const success = await this.pullModel(target.name);
        if (success) {
            this.activeModel = target.name;
            this.logger.log(`✅ Downloaded and activated: ${this.activeModel}`);
        }
        return this.activeModel;
    }

    // ── Model download ────────────────────────────────────────────────────────────

    async pullModel(modelName: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: modelName, stream: false }),
            });
            if (!res.ok) {
                this.logger.error(`Failed to pull model ${modelName}: ${res.statusText}`);
                return false;
            }
            return true;
        } catch (err: any) {
            this.logger.error(`Failed to pull model ${modelName}: ${err.message}`);
            return false;
        }
    }

    // ── Chat completion ───────────────────────────────────────────────────────────

    async chat(options: OllamaGenerateOptions): Promise<OllamaResponse> {
        const timeout = options.timeoutMs ?? 60000;
        const model = options.model || this.activeModel;

        if (!model) throw new Error('No AI model available. Run Ollama and pull a model.');

        const body: Record<string, any> = {
            model,
            messages: options.messages,
            stream: false,
            options: {
                temperature: options.temperature ?? 0.3,
                num_predict: options.maxTokens ?? 1024,
            },
        };

        if (options.format === 'json') {
            body.format = 'json';
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const res = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Ollama API error (${res.status}): ${errText}`);
            }

            const data = (await res.json()) as OllamaResponse;
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    // ── Per-request routing (for user-local Ollama instances) ────────────────────

    /**
     * Send chat request to a specific Ollama URL (e.g. user's local instance).
     * Falls back to server Ollama if the custom URL fails.
     */
    async chatWithUrl(customUrl: string, options: OllamaGenerateOptions): Promise<OllamaResponse> {
        const timeout = options.timeoutMs ?? 60000;
        const model = options.model || this.activeModel;

        if (!model) throw new Error('No AI model available.');

        const body: Record<string, any> = {
            model,
            messages: options.messages,
            stream: false,
            options: {
                temperature: options.temperature ?? 0.3,
                num_predict: options.maxTokens ?? 1024,
            },
        };
        if (options.format === 'json') body.format = 'json';

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const res = await fetch(`${customUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Ollama API error at ${customUrl} (${res.status}): ${errText}`);
            }

            return (await res.json()) as OllamaResponse;
        } catch (err: any) {
            this.logger.warn(
                `⚠️ Custom Ollama at ${customUrl} failed: ${err.message}. Falling back to server.`,
            );
            // Fallback to server Ollama
            return this.chat(options);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Check health of a specific Ollama URL.
     */
    async healthCheckUrl(url: string): Promise<boolean> {
        try {
            const res = await fetch(`${url}/api/tags`, {
                signal: AbortSignal.timeout(5000),
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    // ── Dynamic URL management ────────────────────────────────────────────────────

    setBaseUrl(url: string): void {
        this.baseUrl = url;
        this.logger.log(`Ollama base URL changed to: ${url}`);
    }

    // ── Getters ───────────────────────────────────────────────────────────────────

    getActiveModel(): string | null {
        return this.activeModel;
    }

    getIsHealthy(): boolean {
        return this.isHealthy;
    }

    getBaseUrl(): string {
        return this.baseUrl;
    }
}
