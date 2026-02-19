import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
    imports: [ConfigModule],
    providers: [
        {
            provide: REDIS_CLIENT,
            inject: [ConfigService],
            useFactory: (config: ConfigService): Redis => {
                // Upstash provides a full TLS URL (rediss://...)
                // Fall back to individual host/port/password for local dev
                const redisUrl = config.get<string>('REDIS_URL');

                let client: Redis;

                if (redisUrl) {
                    // Production: Upstash TLS URL
                    client = new Redis(redisUrl, {
                        tls: {}, // required for Upstash rediss:// URLs
                        maxRetriesPerRequest: 3,
                        retryStrategy: (times) => Math.min(times * 200, 5000),
                        lazyConnect: false,
                    });
                } else {
                    // Local dev: individual fields
                    client = new Redis({
                        host: config.get<string>('REDIS_HOST', 'localhost'),
                        port: config.get<number>('REDIS_PORT', 6379),
                        password: config.get<string>('REDIS_PASSWORD') || undefined,
                        retryStrategy: (times) => Math.min(times * 100, 3000),
                        lazyConnect: false,
                    });
                }

                client.on('connect', () => console.log('✅ Redis connected'));
                client.on('error', (err) => console.error('❌ Redis error:', err.message));
                return client;
            },
        },
    ],
    exports: [REDIS_CLIENT],
})
export class RedisModule { }
