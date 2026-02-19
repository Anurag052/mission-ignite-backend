import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from '../pdf/pdf.service';
import { subDays, startOfWeek, endOfWeek } from 'date-fns';

@Injectable()
export class CronService {
    private readonly logger = new Logger(CronService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly pdfService: PdfService,
    ) { }

    // ── Midnight PDF limit reset (IST = UTC+5:30 → 18:30 UTC) ───────────────────
    @Cron('30 18 * * *', { name: 'pdf-daily-reset', timeZone: 'Asia/Kolkata' })
    async resetPdfLimits() {
        this.logger.log('[CRON] Running midnight PDF usage reset...');
        try {
            const deleted = await this.pdfService.resetAllDailyUsage();
            this.logger.log(`[CRON] PDF reset complete. Cleared ${deleted} records.`);
        } catch (err) {
            this.logger.error('[CRON] PDF reset failed', err);
        }
    }

    // ── Auto-delete weekly GD (Group Discussion) records ─────────────────────────
    // Runs every Sunday at 23:55 IST
    @Cron('55 23 * * 0', { name: 'gd-weekly-cleanup', timeZone: 'Asia/Kolkata' })
    async deleteWeeklyGDRecords() {
        this.logger.log('[CRON] Running weekly GD session cleanup...');
        try {
            const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
            const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 });

            const { count } = await this.prisma.gTOTestSession.deleteMany({
                where: {
                    isGD: true,
                    createdAt: { gte: weekStart, lte: weekEnd },
                },
            });

            this.logger.log(`[CRON] GD cleanup complete. Deleted ${count} GD sessions.`);
        } catch (err) {
            this.logger.error('[CRON] GD cleanup failed', err);
        }
    }

    // ── Weekly analytics aggregation (every Monday 00:05 IST) ────────────────────
    @Cron('5 0 * * 1', { name: 'weekly-analytics', timeZone: 'Asia/Kolkata' })
    async aggregateWeeklyAnalytics() {
        this.logger.log('[CRON] Aggregating weekly analytics...');
        try {
            const lastWeekStart = startOfWeek(subDays(new Date(), 7), { weekStartsOn: 1 });
            const lastWeekEnd = endOfWeek(subDays(new Date(), 7), { weekStartsOn: 1 });

            const users = await this.prisma.user.findMany({
                where: { isActive: true },
                select: { id: true },
            });

            const menuTypes = ['SSB', 'OTA', 'CAPF_AC'] as const;

            for (const user of users) {
                for (const menuType of menuTypes) {
                    const [capfMocks, otaMocks, psychTests, aiOutputs] = await Promise.all([
                        this.prisma.cAPFMock.findMany({
                            where: {
                                userId: user.id,
                                completedAt: { gte: lastWeekStart, lte: lastWeekEnd },
                            },
                            select: { score: true, maxScore: true },
                        }),
                        this.prisma.oTAMock.findMany({
                            where: {
                                userId: user.id,
                                completedAt: { gte: lastWeekStart, lte: lastWeekEnd },
                            },
                            select: { score: true, maxScore: true },
                        }),
                        this.prisma.psychologicalTest.count({
                            where: {
                                userId: user.id,
                                menuType,
                                completedAt: { gte: lastWeekStart, lte: lastWeekEnd },
                            },
                        }),
                        this.prisma.aIOutput.count({
                            where: {
                                userId: user.id,
                                menuType,
                                createdAt: { gte: lastWeekStart, lte: lastWeekEnd },
                            },
                        }),
                    ]);

                    const allMocks = menuType === 'CAPF_AC' ? capfMocks : otaMocks;
                    const scores = allMocks
                        .filter((m) => m.score !== null && m.maxScore !== null)
                        .map((m) => (m.score! / m.maxScore!) * 100);
                    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

                    const testsAttempted = allMocks.length + psychTests;

                    if (testsAttempted === 0 && aiOutputs === 0) continue;

                    await this.prisma.weeklyAnalytic.upsert({
                        where: {
                            userId_weekStart_menuType: {
                                userId: user.id,
                                weekStart: lastWeekStart,
                                menuType,
                            },
                        },
                        update: { testsAttempted, avgScore, aiInteractions: aiOutputs },
                        create: {
                            userId: user.id,
                            weekStart: lastWeekStart,
                            weekEnd: lastWeekEnd,
                            menuType,
                            testsAttempted,
                            avgScore,
                            aiInteractions: aiOutputs,
                        },
                    });
                }
            }

            this.logger.log('[CRON] Weekly analytics aggregation complete.');
        } catch (err) {
            this.logger.error('[CRON] Weekly analytics aggregation failed', err);
        }
    }

    // ── Purge old agent logs (older than 30 days) — daily at 02:00 IST ───────────
    @Cron('0 2 * * *', { name: 'agent-log-cleanup', timeZone: 'Asia/Kolkata' })
    async purgeOldAgentLogs() {
        this.logger.log('[CRON] Purging agent logs older than 30 days...');
        try {
            const cutoff = subDays(new Date(), 30);
            const { count } = await this.prisma.agentLog.deleteMany({
                where: { createdAt: { lt: cutoff } },
            });
            this.logger.log(`[CRON] Purged ${count} old agent log entries.`);
        } catch (err) {
            this.logger.error('[CRON] Agent log purge failed', err);
        }
    }
}
