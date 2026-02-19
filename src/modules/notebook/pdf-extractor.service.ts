import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface ExtractedPdf {
    text: string;
    pageCount: number;
    chunks: string[];           // 2000-token chunks for Ollama
    metadata: {
        title?: string;
        author?: string;
        creationDate?: string;
        wordCount: number;
        charCount: number;
    };
}

const MAX_CHUNK_CHARS = 6000;   // ~2000 tokens at ~3 chars/token
const MAX_FILE_SIZE_MB = 20;

@Injectable()
export class PdfExtractorService {
    private readonly logger = new Logger(PdfExtractorService.name);

    /**
     * Extract text from a PDF file path.
     * Uses pdf-parse (pure JS) — no Puppeteer, no external binaries.
     */
    async extract(filePath: string): Promise<ExtractedPdf> {
        // Validate file exists and size
        const stat = fs.statSync(filePath);
        const sizeMb = stat.size / (1024 * 1024);
        if (sizeMb > MAX_FILE_SIZE_MB) {
            throw new BadRequestException(`PDF exceeds ${MAX_FILE_SIZE_MB}MB limit`);
        }

        this.logger.log(`Extracting PDF: ${path.basename(filePath)} (${sizeMb.toFixed(2)}MB)`);

        let rawText = '';
        let pageCount = 0;
        let metadata: ExtractedPdf['metadata'] = { wordCount: 0, charCount: 0 };

        try {
            // Dynamic import — pdf-parse may not be installed yet
            const pdfParse = await import('pdf-parse').then(m => m.default || m);
            const dataBuffer = fs.readFileSync(filePath);
            const result = await pdfParse(dataBuffer);

            rawText = result.text || '';
            pageCount = result.numpages || 1;
            metadata = {
                title: result.info?.Title || undefined,
                author: result.info?.Author || undefined,
                creationDate: result.info?.CreationDate || undefined,
                wordCount: 0,
                charCount: rawText.length,
            };
        } catch (err) {
            this.logger.warn(`pdf-parse unavailable or failed: ${err.message}. Using filename as placeholder.`);
            rawText = `[PDF content from: ${path.basename(filePath)}]\n\nThis PDF could not be parsed automatically. Please ensure pdf-parse is installed: npm install pdf-parse`;
            pageCount = 1;
            metadata = { wordCount: 0, charCount: rawText.length };
        }

        // Clean text
        const cleanedText = this.cleanText(rawText);
        metadata.wordCount = cleanedText.split(/\s+/).filter(Boolean).length;

        // Split into chunks
        const chunks = this.chunkText(cleanedText);

        this.logger.log(`Extracted: ${pageCount} pages, ${metadata.wordCount} words, ${chunks.length} chunks`);

        return {
            text: cleanedText,
            pageCount,
            chunks,
            metadata,
        };
    }

    // ── Text cleaning ─────────────────────────────────────────────────────────────

    private cleanText(raw: string): string {
        return raw
            // Normalize line endings
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            // Remove excessive whitespace within lines
            .replace(/[ \t]{3,}/g, '  ')
            // Collapse 3+ blank lines to 2
            .replace(/\n{4,}/g, '\n\n\n')
            // Remove common PDF artifacts (page numbers, headers)
            .replace(/^\s*\d+\s*$/gm, '')
            // Remove null bytes
            .replace(/\x00/g, '')
            .trim();
    }

    // ── Chunking ──────────────────────────────────────────────────────────────────

    private chunkText(text: string): string[] {
        if (text.length <= MAX_CHUNK_CHARS) return [text];

        const chunks: string[] = [];
        // Try to split on paragraph boundaries
        const paragraphs = text.split(/\n\n+/);
        let current = '';

        for (const para of paragraphs) {
            if ((current + '\n\n' + para).length > MAX_CHUNK_CHARS && current.length > 0) {
                chunks.push(current.trim());
                current = para;
            } else {
                current = current ? current + '\n\n' + para : para;
            }
        }

        if (current.trim()) chunks.push(current.trim());

        // If any chunk is still too large, hard-split it
        const result: string[] = [];
        for (const chunk of chunks) {
            if (chunk.length <= MAX_CHUNK_CHARS) {
                result.push(chunk);
            } else {
                for (let i = 0; i < chunk.length; i += MAX_CHUNK_CHARS) {
                    result.push(chunk.slice(i, i + MAX_CHUNK_CHARS));
                }
            }
        }

        return result;
    }

    // ── File management ───────────────────────────────────────────────────────────

    ensureUploadDir(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    deleteFile(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
            this.logger.warn(`Could not delete file ${filePath}: ${err.message}`);
        }
    }
}
