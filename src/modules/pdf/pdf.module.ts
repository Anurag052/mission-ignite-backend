import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { PdfController } from './pdf.controller';
import { SmartNotebookGenerator } from './generators/smart-notebook.generator';
import { IllustratedNotesGenerator } from './generators/illustrated-notes.generator';
import { PdfRendererService } from './generators/pdf-renderer.service';

@Module({
    providers: [
        PdfService,
        SmartNotebookGenerator,
        IllustratedNotesGenerator,
        PdfRendererService,
    ],
    controllers: [PdfController],
    exports: [PdfService, SmartNotebookGenerator, IllustratedNotesGenerator, PdfRendererService],
})
export class PdfModule { }
