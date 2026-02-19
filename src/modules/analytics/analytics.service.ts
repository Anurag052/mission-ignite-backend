import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MenuType } from '@prisma/client';
import { subDays, startOfDay } from 'date-fns';

@Injectable()
export class AnalyticsService {
    constructor(private readonly prisma: PrismaService) { }

    async getDashboard(userId: string) {
        const [
            totalMocks,
            totalPsychTests,
            totalGtoSessions,
            totalAiOutputs,
            recentWeekly,
        ] = await Promise.all([
            this.prisma.cAPFMock.count({ where: { userId } }) +
            (await this.prisma.oTAMock.count({ where: { userId } })),
            this.prisma.psychologicalTest.count({ where: { userId } }),
            this.prisma.gTOTestSession.count({ where: { userId } }),
            this.prisma.aIOutput.count({ where: { userId } }),
            this.prisma.weeklyAnalytic.findMany({
                where: { userId },
                orderBy: { weekStart: 'desc' },
                take: 4,
            }),
        ]);

        return {
            totalMocks,
            totalPsychTests,
            totalGtoSessions,
            totalAiOutputs,
            recentWeekly,
        };
    }

    async getPerformanceTrend(userId: string, menuType: MenuType, days = 30) {
        const since = subDays(new Date(), days);

        const [capfMocks, otaMocks] = await Promise.all([
            menuType === 'CAPF_AC'
                ? this.prisma.cAPFMock.findMany({
                    where: { userId, completedAt: { gte: since } },
                    select: { score: true, maxScore: true, completedAt: true },
                    orderBy: { completedAt: 'asc' },
                })
                : Promise.resolve([]),
            menuType === 'OTA'
                ? this.prisma.oTAMock.findMany({
                    where: { userId, completedAt: { gte: since } },
                    select: { score: true, maxScore: true, completedAt: true, subject: true },
                    orderBy: { completedAt: 'asc' },
                })
                : Promise.resolve([]),
        ]);

        const mocks = menuType === 'CAPF_AC' ? capfMocks : otaMocks;
        return mocks.map((m: any) => ({
            date: m.completedAt,
            percentage: m.score && m.maxScore ? Math.round((m.score / m.maxScore) * 100) : null,
            subject: m.subject ?? null,
        }));
    }

    async getWeakAreas(userId: string, menuType: MenuType) {
        const otaMocks = await this.prisma.oTAMock.findMany({
            where: { userId },
            select: { subject: true, score: true, maxScore: true },
        });

        const subjectMap: Record<string, { total: number; count: number }> = {};
        for (const m of otaMocks) {
            if (!m.score || !m.maxScore) continue;
            if (!subjectMap[m.subject]) subjectMap[m.subject] = { total: 0, count: 0 };
            subjectMap[m.subject].total += (m.score / m.maxScore) * 100;
            subjectMap[m.subject].count += 1;
        }

        return Object.entries(subjectMap)
            .map(([subject, { total, count }]) => ({
                subject,
                avgScore: Math.round(total / count),
            }))
            .sort((a, b) => a.avgScore - b.avgScore)
            .slice(0, 5);
    }

    async getWeeklyReport(userId: string) {
        return this.prisma.weeklyAnalytic.findMany({
            where: { userId },
            orderBy: { weekStart: 'desc' },
            take: 12,
        });
    }

    async getVisionMetrics(userId: string) {
        return this.prisma.visionMetric.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 20,
        });
    }

    async getVoiceMetrics(userId: string) {
        return this.prisma.voiceMetric.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 20,
        });
    }
}
