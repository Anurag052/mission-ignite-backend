import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotebookCategory } from '@prisma/client';

export interface SearchNotebooksQuery {
    userId: string;
    search?: string;
    category?: NotebookCategory;
    tags?: string[];
    dateFrom?: Date;
    dateTo?: Date;
    page?: number;
    limit?: number;
    sortBy?: 'relevance' | 'date' | 'title';
}

export interface SearchResult {
    notebooks: any[];
    total: number;
    page: number;
    totalPages: number;
    hasNext: boolean;
}

@Injectable()
export class NotebookSearchService {
    private readonly logger = new Logger(NotebookSearchService.name);

    constructor(private readonly prisma: PrismaService) { }

    async search(query: SearchNotebooksQuery): Promise<SearchResult> {
        const {
            userId,
            search,
            category,
            tags,
            dateFrom,
            dateTo,
            page = 1,
            limit = 10,
            sortBy = 'date',
        } = query;

        const skip = (page - 1) * limit;

        // Build Prisma where clause
        const where: any = {
            userId,
            status: 'READY',
        };

        if (category) where.category = category;
        if (tags?.length) where.tags = { hasSome: tags };
        if (dateFrom || dateTo) {
            where.createdAt = {};
            if (dateFrom) where.createdAt.gte = dateFrom;
            if (dateTo) where.createdAt.lte = dateTo;
        }

        // Full-text search via PostgreSQL
        if (search && search.trim()) {
            const searchTerm = search.trim();

            // Use raw SQL for tsvector full-text search
            try {
                const [results, countResult] = await Promise.all([
                    this.prisma.$queryRaw`
            SELECT
              n.id, n.title, n.category, n.status, n."fileName",
              n."fileSizeMb", n."pageCount", n."wordCount", n.tags,
              n."createdAt", n."updatedAt",
              ts_rank(
                to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n."searchVector", '')),
                plainto_tsquery('english', ${searchTerm})
              ) AS rank
            FROM notebooks n
            WHERE n."userId" = ${userId}
              AND n.status = 'READY'
              ${category ? this.prisma.$queryRaw`AND n.category = ${category}::"NotebookCategory"` : this.prisma.$queryRaw``}
              AND to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n."searchVector", ''))
                  @@ plainto_tsquery('english', ${searchTerm})
            ORDER BY rank DESC
            LIMIT ${limit} OFFSET ${skip}
          `,
                    this.prisma.$queryRaw`
            SELECT COUNT(*) as count FROM notebooks n
            WHERE n."userId" = ${userId}
              AND n.status = 'READY'
              AND to_tsvector('english', coalesce(n.title, '') || ' ' || coalesce(n."searchVector", ''))
                  @@ plainto_tsquery('english', ${searchTerm})
          `,
                ]);

                const total = Number((countResult as any[])[0]?.count || 0);
                return {
                    notebooks: results as any[],
                    total,
                    page,
                    totalPages: Math.ceil(total / limit),
                    hasNext: skip + limit < total,
                };
            } catch (err) {
                this.logger.warn(`Full-text search failed, falling back to LIKE: ${err.message}`);
                // Fallback: simple LIKE search
                where.OR = [
                    { title: { contains: search, mode: 'insensitive' } },
                    { searchVector: { contains: search, mode: 'insensitive' } },
                ];
            }
        }

        // Standard Prisma query (no FTS or fallback)
        const orderBy: any =
            sortBy === 'title'
                ? { title: 'asc' }
                : sortBy === 'relevance'
                    ? { updatedAt: 'desc' }
                    : { createdAt: 'desc' };

        const [notebooks, total] = await Promise.all([
            this.prisma.notebook.findMany({
                where,
                skip,
                take: limit,
                orderBy,
                select: {
                    id: true,
                    title: true,
                    category: true,
                    status: true,
                    fileName: true,
                    fileSizeMb: true,
                    pageCount: true,
                    wordCount: true,
                    tags: true,
                    createdAt: true,
                    updatedAt: true,
                    contents: {
                        select: { contentType: true, generatedAt: true },
                    },
                },
            }),
            this.prisma.notebook.count({ where }),
        ]);

        return {
            notebooks,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            hasNext: skip + limit < total,
        };
    }

    async getById(id: string, userId: string): Promise<any> {
        return this.prisma.notebook.findFirst({
            where: { id, userId },
            include: {
                contents: {
                    orderBy: { generatedAt: 'desc' },
                },
            },
        });
    }

    async getContentByType(notebookId: string, userId: string, contentType: string): Promise<any> {
        const notebook = await this.prisma.notebook.findFirst({
            where: { id: notebookId, userId },
            select: { id: true },
        });
        if (!notebook) return null;

        return this.prisma.notebookContent.findFirst({
            where: { notebookId, contentType: contentType as any },
        });
    }
}
