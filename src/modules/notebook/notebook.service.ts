import {
    Injectable,
    Logger,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfExtractorService } from './pdf-extractor.service';
import { NotebookAiService } from './notebook-ai.service';
import { NotebookAnalyticsService } from './notebook-analytics.service';
import { NotebookCategory, NotebookContentType } from '@prisma/client';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'notebooks');

export interface UploadNotebookDto {
    userId: string;
    title: string;
    category: NotebookCategory;
    tags?: string[];
    file: {
        originalname: string;
        path: string;
        size: number;
        mimetype: string;
    };
}

@Injectable()
export class NotebookService {
    private readonly logger = new Logger(NotebookService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly extractor: PdfExtractorService,
        private readonly ai: NotebookAiService,
        private readonly analytics: NotebookAnalyticsService,
    ) {
        this.extractor.ensureUploadDir(UPLOAD_DIR);
    }

    // ── Upload & Process ──────────────────────────────────────────────────────────

    async uploadAndProcess(dto: UploadNotebookDto): Promise<{ id: string; status: string }> {
        const { userId, title, category, tags = [], file } = dto;

        if (!file.mimetype.includes('pdf')) {
            throw new BadRequestException('Only PDF files are supported');
        }

        const fileSizeMb = file.size / (1024 * 1024);
        if (fileSizeMb > 20) {
            throw new BadRequestException('File size must not exceed 20MB');
        }

        // Create notebook record (PENDING)
        const notebook = await this.prisma.notebook.create({
            data: {
                userId,
                title,
                category,
                status: 'PENDING',
                fileName: file.originalname,
                filePath: file.path,
                fileSizeMb,
                tags,
            },
        });

        this.logger.log(`Notebook created: ${notebook.id} — starting processing pipeline`);

        // Run pipeline asynchronously (don't await — return immediately)
        this.runPipeline(notebook.id, file.path, title).catch(err => {
            this.logger.error(`Pipeline failed for ${notebook.id}: ${err.message}`);
        });

        return { id: notebook.id, status: 'PROCESSING' };
    }

    // ── Processing Pipeline ───────────────────────────────────────────────────────

    private async runPipeline(notebookId: string, filePath: string, title: string): Promise<void> {
        try {
            // Step 1: Mark as PROCESSING
            await this.prisma.notebook.update({
                where: { id: notebookId },
                data: { status: 'PROCESSING' },
            });

            // Step 2: Extract text from PDF
            this.logger.log(`[${notebookId}] Extracting PDF text...`);
            const extracted = await this.extractor.extract(filePath);

            // Step 3: Update notebook with extracted data
            await this.prisma.notebook.update({
                where: { id: notebookId },
                data: {
                    extractedText: extracted.text,
                    pageCount: extracted.pageCount,
                    wordCount: extracted.metadata.wordCount,
                    chunkCount: extracted.chunks.length,
                    pdfTitle: extracted.metadata.title,
                    pdfAuthor: extracted.metadata.author,
                    pdfCreatedAt: extracted.metadata.creationDate,
                    // searchVector = title + first 5000 chars of text (for PG FTS)
                    searchVector: `${title} ${extracted.text.slice(0, 5000)}`,
                },
            });

            // Step 4: Generate all AI content
            this.logger.log(`[${notebookId}] Generating AI content...`);
            const aiOutputs = await this.ai.generateAll(extracted, title);

            // Step 5: Save each content type
            for (const output of aiOutputs) {
                await this.prisma.notebookContent.upsert({
                    where: {
                        notebookId_contentType: {
                            notebookId,
                            contentType: output.type as NotebookContentType,
                        },
                    },
                    update: {
                        content: output.data as any,
                        generatedAt: new Date(),
                    },
                    create: {
                        notebookId,
                        contentType: output.type as NotebookContentType,
                        content: output.data as any,
                    },
                });
            }

            // Step 6: Mark as READY
            await this.prisma.notebook.update({
                where: { id: notebookId },
                data: { status: 'READY' },
            });

            // Step 7: Update weekly analytics
            const nb = await this.prisma.notebook.findUnique({
                where: { id: notebookId },
                select: { userId: true, pageCount: true, wordCount: true },
            });
            if (nb) {
                await this.analytics.trackNotebookCreated(nb.userId, nb.pageCount, nb.wordCount);
                for (const output of aiOutputs) {
                    await this.analytics.trackContentGenerated(nb.userId, output.type);
                }
            }

            this.logger.log(`[${notebookId}] Pipeline complete — ${aiOutputs.length} content types generated`);
        } catch (err) {
            this.logger.error(`[${notebookId}] Pipeline error: ${err.message}`);
            await this.prisma.notebook.update({
                where: { id: notebookId },
                data: { status: 'FAILED', errorMessage: err.message },
            }).catch(() => { });
        }
    }

    // ── Regenerate a single content type ─────────────────────────────────────────

    async regenerateContent(notebookId: string, userId: string, contentType: string): Promise<{ queued: boolean }> {
        const notebook = await this.prisma.notebook.findFirst({
            where: { id: notebookId, userId },
        });
        if (!notebook) throw new NotFoundException('Notebook not found');
        if (!notebook.extractedText) throw new BadRequestException('Notebook text not extracted yet');

        const extracted = {
            text: notebook.extractedText,
            pageCount: notebook.pageCount,
            wordCount: notebook.wordCount,
            chunkCount: notebook.chunkCount,
            chunks: this.rechunk(notebook.extractedText),
            metadata: {
                title: notebook.pdfTitle || undefined,
                author: notebook.pdfAuthor || undefined,
                creationDate: notebook.pdfCreatedAt || undefined,
                wordCount: notebook.wordCount,
                charCount: notebook.extractedText.length,
            },
        };

        // Run async
        this.regenerateAsync(notebookId, userId, contentType, extracted, notebook.title).catch(err => {
            this.logger.error(`Regeneration failed: ${err.message}`);
        });

        return { queued: true };
    }

    private async regenerateAsync(
        notebookId: string,
        userId: string,
        contentType: string,
        extracted: any,
        title: string,
    ): Promise<void> {
        let output: any;

        switch (contentType) {
            case 'NOTES': output = await this.ai.generateNotes(extracted, title); break;
            case 'QUIZ': output = await this.ai.generateQuiz(extracted, title); break;
            case 'INTERVIEW': output = await this.ai.generateInterview(extracted, title); break;
            case 'CAPF_AC': output = await this.ai.generateCapfAc(extracted, title); break;
            case 'AUDIO_OVERVIEW': output = await this.ai.generateAudioOverview(extracted, title); break;
            default: throw new BadRequestException(`Unknown content type: ${contentType}`);
        }

        await this.prisma.notebookContent.upsert({
            where: {
                notebookId_contentType: {
                    notebookId,
                    contentType: contentType as NotebookContentType,
                },
            },
            update: { content: output, generatedAt: new Date() },
            create: {
                notebookId,
                contentType: contentType as NotebookContentType,
                content: output,
            },
        });

        await this.analytics.trackContentGenerated(userId, contentType);
    }

    // ── Delete ────────────────────────────────────────────────────────────────────

    async delete(notebookId: string, userId: string): Promise<void> {
        const notebook = await this.prisma.notebook.findFirst({
            where: { id: notebookId, userId },
        });
        if (!notebook) throw new NotFoundException('Notebook not found');

        // Delete file from disk
        this.extractor.deleteFile(notebook.filePath);

        // Cascade deletes NotebookContent too
        await this.prisma.notebook.delete({ where: { id: notebookId } });
        this.logger.log(`Notebook ${notebookId} deleted`);
    }

    // ── Status poll ───────────────────────────────────────────────────────────────

    async getStatus(notebookId: string, userId: string): Promise<any> {
        const notebook = await this.prisma.notebook.findFirst({
            where: { id: notebookId, userId },
            select: {
                id: true, title: true, status: true, errorMessage: true,
                pageCount: true, wordCount: true, chunkCount: true,
                contents: { select: { contentType: true, generatedAt: true } },
            },
        });
        if (!notebook) throw new NotFoundException('Notebook not found');
        return notebook;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────

    private rechunk(text: string): string[] {
        const MAX = 6000;
        if (text.length <= MAX) return [text];
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
        return chunks;
    }
}
