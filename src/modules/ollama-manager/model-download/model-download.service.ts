import { Injectable, Logger } from '@nestjs/common';
import { OllamaClient } from '../../ai-engine/ollama/ollama.client';
import { MODEL_CATALOG, CatalogModel } from './model-catalog';

export interface DownloadProgress {
    modelName: string;
    status: 'queued' | 'downloading' | 'verifying' | 'completed' | 'failed';
    completedBytes: number;
    totalBytes: number;
    percentComplete: number;
    speedMbps: number;
    error?: string;
}

@Injectable()
export class ModelDownloadService {
    private readonly logger = new Logger(ModelDownloadService.name);
    private activeDownloads = new Map<string, DownloadProgress>();

    constructor(private readonly ollamaClient: OllamaClient) { }

    /**
     * Get current download progress for a model.
     */
    getProgress(modelName: string): DownloadProgress | null {
        return this.activeDownloads.get(modelName) || null;
    }

    /**
     * Get all active downloads.
     */
    getAllActive(): DownloadProgress[] {
        return Array.from(this.activeDownloads.values());
    }

    /**
     * Start a model download with progress tracking.
     * Uses Ollama's streaming pull API to report progress.
     *
     * @param modelName Ollama model tag (e.g. "gemma2:2b")
     * @param onProgress Callback for real-time progress updates
     * @returns Final download result
     */
    async downloadModel(
        modelName: string,
        onProgress?: (progress: DownloadProgress) => void,
    ): Promise<DownloadProgress> {
        // Validate model exists in catalog
        const catalogEntry = MODEL_CATALOG.find((m) => m.name === modelName);
        if (!catalogEntry) {
            this.logger.warn(`Model "${modelName}" not in catalog, proceeding anyway`);
        }

        // Check if already downloading
        const existing = this.activeDownloads.get(modelName);
        if (existing && existing.status === 'downloading') {
            return existing;
        }

        // Initialize progress
        const progress: DownloadProgress = {
            modelName,
            status: 'downloading',
            completedBytes: 0,
            totalBytes: (catalogEntry?.sizeMb || 0) * 1024 * 1024,
            percentComplete: 0,
            speedMbps: 0,
        };
        this.activeDownloads.set(modelName, progress);
        onProgress?.(progress);

        const startTime = Date.now();

        try {
            // Use streaming pull endpoint
            const baseUrl = this.ollamaClient.getBaseUrl();
            const res = await fetch(`${baseUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: modelName, stream: true }),
            });

            if (!res.ok) {
                throw new Error(`Ollama pull failed: ${res.status} ${res.statusText}`);
            }

            const reader = res.body?.getReader();
            if (!reader) {
                throw new Error('No response body stream available');
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Ollama streams newline-delimited JSON
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const chunk = JSON.parse(line);
                        this.updateProgress(progress, chunk, startTime);
                        onProgress?.(progress);
                    } catch {
                        // Skip malformed lines
                    }
                }
            }

            // Mark completed
            progress.status = 'completed';
            progress.percentComplete = 100;
            this.activeDownloads.set(modelName, progress);
            onProgress?.(progress);

            this.logger.log(
                `✅ Model "${modelName}" downloaded successfully ` +
                `(${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
            );

            return progress;
        } catch (err: any) {
            progress.status = 'failed';
            progress.error = err.message;
            this.activeDownloads.set(modelName, progress);
            onProgress?.(progress);

            this.logger.error(`❌ Model download failed: ${modelName} — ${err.message}`);
            return progress;
        }
    }

    /**
     * Validate sufficient storage before download.
     */
    validateStorage(modelSizeMb: number, freeStorageMb: number | null): {
        valid: boolean;
        reason: string;
    } {
        if (freeStorageMb === null) {
            return { valid: true, reason: 'Storage info not available, proceeding with download.' };
        }

        // Require 1.5x model size for safety margin
        const requiredMb = modelSizeMb * 1.5;
        if (freeStorageMb < requiredMb) {
            return {
                valid: false,
                reason: `Insufficient storage: need ${requiredMb.toFixed(0)}MB ` +
                    `(1.5x model size), have ${freeStorageMb}MB free.`,
            };
        }

        return { valid: true, reason: `Sufficient storage: ${freeStorageMb}MB free, ${requiredMb.toFixed(0)}MB required.` };
    }

    /**
     * Retry a failed download (resume logic — Ollama handles partial state internally).
     */
    async retryDownload(
        modelName: string,
        onProgress?: (progress: DownloadProgress) => void,
    ): Promise<DownloadProgress> {
        this.logger.log(`🔄 Retrying download for "${modelName}"...`);
        this.activeDownloads.delete(modelName);
        return this.downloadModel(modelName, onProgress);
    }

    /**
     * Cancel an active download (best-effort — Ollama doesn't support cancel natively).
     */
    cancelDownload(modelName: string): boolean {
        const progress = this.activeDownloads.get(modelName);
        if (progress && progress.status === 'downloading') {
            progress.status = 'failed';
            progress.error = 'Download cancelled by user';
            this.activeDownloads.set(modelName, progress);
            return true;
        }
        return false;
    }

    private updateProgress(
        progress: DownloadProgress,
        chunk: any,
        startTime: number,
    ): void {
        if (chunk.total) {
            progress.totalBytes = chunk.total;
        }
        if (chunk.completed) {
            progress.completedBytes = chunk.completed;
        }
        if (progress.totalBytes > 0) {
            progress.percentComplete = Math.round(
                (progress.completedBytes / progress.totalBytes) * 100,
            );
        }

        // Calculate speed
        const elapsedSec = (Date.now() - startTime) / 1000;
        if (elapsedSec > 0) {
            progress.speedMbps = parseFloat(
                ((progress.completedBytes / 1024 / 1024) / elapsedSec).toFixed(2),
            );
        }

        if (chunk.status === 'verifying sha256 digest') {
            progress.status = 'verifying';
        }
    }
}
