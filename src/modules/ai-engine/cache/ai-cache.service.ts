import { Injectable, Logger, Inject } from '@nestjs/common';
import { REDIS_CLIENT } from '../../../redis/redis.module';
import Redis from 'ioredis';

/**
 * Redis-backed caching layer for AI responses.
 * Keys are hashed from (agentName + promptHash) to avoid duplicate inference.
 * TTL is configurable per agent.
 */
@Injectable()
export class AiCacheService {
    private readonly logger = new Logger(AiCacheService.name);
    private readonly defaultTtl = 3600; // 1 hour

    constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) { }

    private buildKey(agentName: string, inputHash: string): string {
        return `ai:cache:${agentName}:${inputHash}`;
    }

    async get<T = any>(agentName: string, inputHash: string): Promise<T | null> {
        const key = this.buildKey(agentName, inputHash);
        const cached = await this.redis.get(key);
        if (cached) {
            this.logger.debug(`Cache HIT: ${key}`);
            return JSON.parse(cached) as T;
        }
        return null;
    }

    async set(agentName: string, inputHash: string, value: any, ttlSec?: number): Promise<void> {
        const key = this.buildKey(agentName, inputHash);
        const ttl = ttlSec ?? this.defaultTtl;
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
        this.logger.debug(`Cache SET: ${key} (TTL ${ttl}s)`);
    }

    async invalidate(agentName: string, inputHash: string): Promise<void> {
        const key = this.buildKey(agentName, inputHash);
        await this.redis.del(key);
    }

    async invalidateAgent(agentName: string): Promise<number> {
        const keys = await this.redis.keys(`ai:cache:${agentName}:*`);
        if (keys.length === 0) return 0;
        return this.redis.del(...keys);
    }

    /**
     * Simple hash for cache key generation.
     * Deterministic: same input always produces same key.
     */
    hashInput(input: string): string {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            const char = input.charCodeAt(i);
            hash = ((hash << 5) - hash + char) | 0;
        }
        return Math.abs(hash).toString(36);
    }
}
