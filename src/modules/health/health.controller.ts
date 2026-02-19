import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { Inject } from '@nestjs/common';
import { REDIS_CLIENT } from '../../redis/redis.module';
import Redis from 'ioredis';

@ApiTags('health')
@Controller('health')
export class HealthController {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
    ) { }

    @Get()
    @ApiOperation({ summary: 'Health check — checks DB and Redis connectivity' })
    async check() {
        const checks: Record<string, string> = {};

        // PostgreSQL check
        try {
            await this.prisma.$queryRaw`SELECT 1`;
            checks.database = 'ok';
        } catch {
            checks.database = 'error';
        }

        // Redis check
        try {
            await this.redis.ping();
            checks.redis = 'ok';
        } catch {
            checks.redis = 'error';
        }

        const allOk = Object.values(checks).every((v) => v === 'ok');

        return {
            status: allOk ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            checks,
        };
    }
}
