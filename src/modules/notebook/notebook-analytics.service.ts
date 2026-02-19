import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { startOfWeek, endOfWeek, subWeeks } from 'date-fns';

export interface WeeklyAnalyticsSummary {
    currentWeek: WeekData;
    trend: WeekData[];   // last 4 weeks
    allTime: AllTimeStats;
}

interface WeekData {
    weekStart: Date;
    weekEnd: Date;
    notebooksCreated: number;
    totalPagesProcessed: number;
    totalWordsProcessed: number;
    quizAttempts: number;
    avgQuizScore: number | null;
    contentTypesGenerated: Record<string, number>;
}

interface AllTimeStats {
    totalNotebooks: number;
    totalPages: number;
    totalWords: number;
    categoryCounts: Record<string, number>;
    mostUsedCategory: string;
}

@Injectable()
export class NotebookAnalyticsService {
    private readonly logger = new Logger(NotebookAnalyticsService.name);

    constructor(private readonly prisma: PrismaService) { }

    // ── Increment counters when a notebook is created ─────────────────────────────

    async trackNotebookCreated(userId: string, pageCount: number, wordCount: number): Promise<void> {
        const { weekStart, weekEnd } = this.getCurrentWeekRange();

        await this.prisma.notebookAnalytic.upsert({
            where: { userId_weekStart: { userId, weekStart } },
            update: {
                notebooksCreated: { increment: 1 },
                totalPagesProcessed: { increment: pageCount },
                totalWordsProcessed: { increment: wordCount },
            },
            create: {
                userId,
                weekStart,
                weekEnd,
                notebooksCreated: 1,
                totalPagesProcessed: pageCount,
                totalWordsProcessed: wordCount,
            },
        });
    }

    // ── Track content type generation ─────────────────────────────────────────────

    async trackContentGenerated(userId: string, contentType: string): Promise<void> {
        const { weekStart, weekEnd } = this.getCurrentWeekRange();

        const existing = await this.prisma.notebookAnalytic.findUnique({
            where: { userId_weekStart: { userId, weekStart } },
            select: { contentTypesGenerated: true },
        });

        const current = (existing?.contentTypesGenerated as Record<string, number>) || {};
        current[contentType] = (current[contentType] || 0) + 1;

        await this.prisma.notebookAnalytic.upsert({
            where: { userId_weekStart: { userId, weekStart } },
            update: { contentTypesGenerated: current },
            create: {
                userId,
                weekStart,
                weekEnd,
                contentTypesGenerated: current,
            },
        });
    }

    // ── Track quiz attempt ────────────────────────────────────────────────────────

    async trackQuizAttempt(userId: string, score: number): Promise<void> {
        const { weekStart, weekEnd } = this.getCurrentWeekRange();

        const existing = await this.prisma.notebookAnalytic.findUnique({
            where: { userId_weekStart: { userId, weekStart } },
            select: { quizAttempts: true, avgQuizScore: true },
        });

        const attempts = (existing?.quizAttempts || 0) + 1;
        const prevAvg = existing?.avgQuizScore || 0;
        const newAvg = (prevAvg * (attempts - 1) + score) / attempts;

        await this.prisma.notebookAnalytic.upsert({
            where: { userId_weekStart: { userId, weekStart } },
            update: {
                quizAttempts: { increment: 1 },
                avgQuizScore: newAvg,
            },
            create: {
                userId,
                weekStart,
                weekEnd,
                quizAttempts: 1,
                avgQuizScore: score,
            },
        });
    }

    // ── Get weekly analytics summary ──────────────────────────────────────────────

    async getWeeklySummary(userId: string): Promise<WeeklyAnalyticsSummary> {
        const { weekStart } = this.getCurrentWeekRange();

        // Last 4 weeks
        const weekStarts = Array.from({ length: 4 }, (_, i) =>
            startOfWeek(subWeeks(new Date(), i), { weekStartsOn: 1 }),
        );

        const [analyticsRows, allTimeNotebooks] = await Promise.all([
            this.prisma.notebookAnalytic.findMany({
                where: {
                    userId,
                    weekStart: { gte: weekStarts[3] },
                },
                orderBy: { weekStart: 'desc' },
            }),
            this.prisma.notebook.findMany({
                where: { userId, status: 'READY' },
                select: { category: true, pageCount: true, wordCount: true },
            }),
        ]);

        // Build trend data
        const trend: WeekData[] = weekStarts.map(ws => {
            const row = analyticsRows.find(r => r.weekStart.toISOString() === ws.toISOString());
            return {
                weekStart: ws,
                weekEnd: endOfWeek(ws, { weekStartsOn: 1 }),
                notebooksCreated: row?.notebooksCreated || 0,
                totalPagesProcessed: row?.totalPagesProcessed || 0,
                totalWordsProcessed: row?.totalWordsProcessed || 0,
                quizAttempts: row?.quizAttempts || 0,
                avgQuizScore: row?.avgQuizScore || null,
                contentTypesGenerated: (row?.contentTypesGenerated as Record<string, number>) || {},
            };
        });

        // All-time stats
        const categoryCounts: Record<string, number> = {};
        let totalPages = 0;
        let totalWords = 0;

        for (const nb of allTimeNotebooks) {
            categoryCounts[nb.category] = (categoryCounts[nb.category] || 0) + 1;
            totalPages += nb.pageCount;
            totalWords += nb.wordCount;
        }

        const mostUsedCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'GENERAL';

        return {
            currentWeek: trend[0],
            trend,
            allTime: {
                totalNotebooks: allTimeNotebooks.length,
                totalPages,
                totalWords,
                categoryCounts,
                mostUsedCategory,
            },
        };
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────

    private getCurrentWeekRange(): { weekStart: Date; weekEnd: Date } {
        const now = new Date();
        const weekStart = startOfWeek(now, { weekStartsOn: 1 });  // Monday
        const weekEnd = endOfWeek(now, { weekStartsOn: 1 });       // Sunday
        return { weekStart, weekEnd };
    }
}
