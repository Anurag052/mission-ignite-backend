
import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { RedisService } from '../../modules/redis/redis.service';
import { Reflector } from '@nestjs/core';

@Injectable()
export class UploadRateLimitGuard implements CanActivate {
    constructor(
        private readonly redis: RedisService,
        private readonly reflector: Reflector
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user) {
            return true; // Should be guarded by JwtAuthGuard first
        }

        const userId = user.id;
        const role = user.role;

        // Limits: Free = 10/day, Pro/Admin = 50/day
        // We can check entitlements, but hardcoding for now based on implementation plan
        const limit = role === 'FREE' ? 10 : 50;

        const key = `uploads:${userId}:today`;

        // Get current count
        const current = await this.redis.get(key);
        const count = current ? parseInt(current, 10) : 0;

        if (count >= limit) {
            throw new HttpException(
                `Daily upload limit reached (${limit}). Upgrade to Pro for more.`,
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        // Increment (TTL until midnight could be set, but 24h is easier for MVP)
        await this.redis.incr(key);
        if (count === 0) {
            await this.redis.expire(key, 86400); // 24 hours
        }

        return true;
    }
}
