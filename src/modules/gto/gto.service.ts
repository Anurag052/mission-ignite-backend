import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GTOSessionStatus, GTOTaskType } from '@prisma/client';

@Injectable()
export class GtoService {
    constructor(private readonly prisma: PrismaService) { }

    async getUserSessions(userId: string, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [sessions, total] = await Promise.all([
            this.prisma.gTOTestSession.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.gTOTestSession.count({ where: { userId } }),
        ]);
        return { sessions, total, page, limit };
    }

    async getSession(sessionId: string, userId: string) {
        return this.prisma.gTOTestSession.findFirst({
            where: { id: sessionId, userId },
        });
    }

    async getSessionStats(userId: string) {
        const stats = await this.prisma.gTOTestSession.groupBy({
            by: ['taskType', 'status'],
            where: { userId },
            _count: { id: true },
            _avg: { aiScore: true },
        });
        return stats;
    }
}
