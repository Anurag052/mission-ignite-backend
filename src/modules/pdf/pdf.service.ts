import {
    Injectable,
    ForbiddenException,
    NotFoundException,
    Inject,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../../redis/redis.module';
import Redis from 'ioredis';
import { startOfDay } from 'date-fns';

@Injectable()
export class PdfService {
    private readonly dailyLimit: number;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
    ) {
        this.dailyLimit = this.config.get<number>('PDF_DAILY_LIMIT', 5);
    }

    // ── Check & Increment daily PDF usage ────────────────────────────────────────

    async checkAndIncrementUsage(userId: string, gmailEmail: string): Promise<void> {
        const today = startOfDay(new Date());
        const redisKey = `pdf:limit:${userId}:${today.toISOString().split('T')[0]}`;

        // Fast path via Redis
        const cached = await this.redis.get(redisKey);
        const currentCount = cached ? parseInt(cached, 10) : 0;

        if (currentCount >= this.dailyLimit) {
            throw new ForbiddenException(
                `Daily PDF limit of ${this.dailyLimit} reached. Resets at midnight.`,
            );
        }

        // Upsert in DB
        const record = await this.prisma.pDFUsageTracking.upsert({
            where: { userId_date: { userId, date: today } },
            update: { count: { increment: 1 } },
            create: { userId, gmailEmail, date: today, count: 1, dailyLimit: this.dailyLimit },
        });

        if (record.count > this.dailyLimit) {
            // Rollback increment
            await this.prisma.pDFUsageTracking.update({
                where: { userId_date: { userId, date: today } },
                data: { count: { decrement: 1 } },
            });
            throw new ForbiddenException(
                `Daily PDF limit of ${this.dailyLimit} reached. Resets at midnight.`,
            );
        }

        // Update Redis cache — TTL until end of day
        const secondsUntilMidnight = this.getSecondsUntilMidnight();
        await this.redis.set(redisKey, record.count, 'EX', secondsUntilMidnight);
    }

    async getUsage(userId: string) {
        const today = startOfDay(new Date());
        const record = await this.prisma.pDFUsageTracking.findUnique({
            where: { userId_date: { userId, date: today } },
        });
        return {
            used: record?.count ?? 0,
            limit: this.dailyLimit,
            remaining: this.dailyLimit - (record?.count ?? 0),
            resetsAt: this.getMidnightIST(),
        };
    }

    // ── Midnight reset (called by cron) ──────────────────────────────────────────

    async resetAllDailyUsage(): Promise<number> {
        const yesterday = startOfDay(new Date());
        yesterday.setDate(yesterday.getDate() - 1);

        // Delete yesterday's records (today's will accumulate fresh)
        const { count } = await this.prisma.pDFUsageTracking.deleteMany({
            where: { date: { lt: startOfDay(new Date()) } },
        });

        // Flush Redis PDF keys
        const keys = await this.redis.keys('pdf:limit:*');
        if (keys.length > 0) await this.redis.del(...keys);

        return count;
    }

    private getSecondsUntilMidnight(): number {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        return Math.floor((midnight.getTime() - now.getTime()) / 1000);
    }

    private getMidnightIST(): string {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        return midnight.toISOString();
    }
}
