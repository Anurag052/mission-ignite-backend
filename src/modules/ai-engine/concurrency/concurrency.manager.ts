import { Injectable, Logger } from '@nestjs/common';

/**
 * Semaphore-based concurrency manager for Ollama inference.
 * Prevents OOM by limiting concurrent model invocations.
 * Queue ensures FIFO ordering when slots are full.
 */
@Injectable()
export class ConcurrencyManager {
    private readonly logger = new Logger(ConcurrencyManager.name);
    private readonly maxConcurrent: number;
    private running = 0;
    private readonly queue: Array<{
        resolve: () => void;
        taskId: string;
        enqueuedAt: number;
    }> = [];

    constructor() {
        // Default: 2 concurrent inference slots (safe for 8 GB RAM)
        this.maxConcurrent = parseInt(process.env.AI_MAX_CONCURRENT || '2', 10);
        this.logger.log(`Concurrency limit: ${this.maxConcurrent} parallel inferences`);
    }

    async acquire(taskId: string): Promise<void> {
        if (this.running < this.maxConcurrent) {
            this.running++;
            this.logger.debug(`[${taskId}] Acquired slot (${this.running}/${this.maxConcurrent})`);
            return;
        }

        // Wait in queue
        this.logger.debug(`[${taskId}] Queued (${this.queue.length + 1} waiting)`);
        return new Promise<void>((resolve) => {
            this.queue.push({ resolve, taskId, enqueuedAt: Date.now() });
        });
    }

    release(taskId: string): void {
        this.running--;
        this.logger.debug(`[${taskId}] Released slot (${this.running}/${this.maxConcurrent})`);

        if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            this.running++;
            const waitMs = Date.now() - next.enqueuedAt;
            this.logger.debug(`[${next.taskId}] Dequeued after ${waitMs}ms`);
            next.resolve();
        }
    }

    getStatus() {
        return {
            running: this.running,
            maxConcurrent: this.maxConcurrent,
            queued: this.queue.length,
        };
    }
}
