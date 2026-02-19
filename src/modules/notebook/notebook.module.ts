import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { join } from 'path';
import { NotebookController } from './notebook.controller';
import { NotebookService } from './notebook.service';
import { PdfExtractorService } from './pdf-extractor.service';
import { NotebookAiService } from './notebook-ai.service';
import { NotebookSearchService } from './notebook-search.service';
import { NotebookAnalyticsService } from './notebook-analytics.service';

@Module({
    imports: [
        MulterModule.register({
            dest: join(process.cwd(), 'uploads', 'notebooks'),
            limits: { fileSize: 20 * 1024 * 1024 },
        }),
    ],
    providers: [
        NotebookService,
        PdfExtractorService,
        NotebookAiService,
        NotebookSearchService,
        NotebookAnalyticsService,
    ],
    controllers: [NotebookController],
    exports: [NotebookService, NotebookAnalyticsService],
})
export class NotebookModule { }
