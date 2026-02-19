import {
    Controller,
    Get,
    Post,
    UseGuards,
    Body,
    Res,
    HttpCode,
    HttpStatus,
    Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { PdfService } from './pdf.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
    IsEmail,
    IsString,
    IsEnum,
    IsBoolean,
    IsOptional,
    IsArray,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SmartNotebookGenerator, SmartNotebookRequest } from './generators/smart-notebook.generator';
import { IllustratedNotesGenerator, IllustratedRequest } from './generators/illustrated-notes.generator';
import { PdfRendererService } from './generators/pdf-renderer.service';

// ── DTOs ─────────────────────────────────────────────────────────────────────────

class GeneratePdfDto {
    @ApiProperty({ example: 'john@gmail.com' })
    @IsEmail()
    gmailEmail: string;

    @ApiProperty({ example: 'score-report' })
    @IsString()
    reportType: string;

    @ApiProperty()
    payload: Record<string, any>;
}

class SmartNotebookDto {
    @ApiProperty({ example: 'john@gmail.com' })
    @IsEmail()
    gmailEmail: string;

    @ApiProperty({ example: 'Indian Geography — Physical Features' })
    @IsString()
    topic: string;

    @ApiProperty({ example: 'Geography', enum: ['Geography', 'History', 'Polity', 'Economy', 'Defence', 'Science', 'GK', 'Current Affairs'] })
    @IsString()
    subject: string;

    @ApiProperty({ enum: ['CONCISE', 'STANDARD', 'DETAILED'], default: 'STANDARD' })
    @IsEnum(['CONCISE', 'STANDARD', 'DETAILED'])
    depth: 'CONCISE' | 'STANDARD' | 'DETAILED' = 'STANDARD';

    @ApiProperty({ example: ['CAPF_AC', 'SSB', 'OTA'], enum: ['CAPF_AC', 'SSB', 'OTA', 'NDA', 'CDS'] })
    @IsArray()
    examFocus: ('CAPF_AC' | 'SSB' | 'OTA' | 'NDA' | 'CDS')[];

    @ApiPropertyOptional({ default: true })
    @IsBoolean()
    @IsOptional()
    includeTestSection?: boolean = true;

    @ApiPropertyOptional()
    @IsString()
    @IsOptional()
    additionalNotes?: string;
}

class IllustratedNotesDto {
    @ApiProperty({ example: 'john@gmail.com' })
    @IsEmail()
    gmailEmail: string;

    @ApiProperty({ example: 'Fundamental Rights & DPSP' })
    @IsString()
    topic: string;

    @ApiProperty({ example: 'Polity' })
    @IsString()
    subject: string;

    @ApiPropertyOptional({ example: ['Article 14-18', 'Article 19', 'Article 21', 'DPSP Classification'] })
    @IsArray()
    @IsOptional()
    subtopics?: string[];

    @ApiProperty({ enum: ['MINIMAL', 'COLORFUL', 'PROFESSIONAL'], default: 'PROFESSIONAL' })
    @IsEnum(['MINIMAL', 'COLORFUL', 'PROFESSIONAL'])
    diagramStyle: 'MINIMAL' | 'COLORFUL' | 'PROFESSIONAL' = 'PROFESSIONAL';
}

// ── Controller ──────────────────────────────────────────────────────────────────

@ApiTags('PDF Generation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/pdf')
export class PdfController {
    constructor(
        private readonly pdfService: PdfService,
        private readonly smartNotebook: SmartNotebookGenerator,
        private readonly illustratedNotes: IllustratedNotesGenerator,
        private readonly renderer: PdfRendererService,
    ) { }

    // ── Usage & Limits ──────────────────────────────────────────────────────────

    @Get('usage')
    @ApiOperation({ summary: 'Get daily PDF usage (used/limit/remaining/reset time)' })
    async getUsage(@CurrentUser() user: any) {
        return this.pdfService.getUsage(user.id);
    }

    // ── Mode 1: Smart Notebook AI ───────────────────────────────────────────────

    @Post('generate/smart-notebook')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Mode 1: Generate Smart Notebook AI PDF',
        description: 'Agent-driven deep notes with chapters, MCQs, CAPF AC/SSB/OTA questions, and practice test.',
    })
    async generateSmartNotebook(
        @CurrentUser() user: any,
        @Body() dto: SmartNotebookDto,
        @Query('format') format: 'pdf' | 'html' = 'html',
        @Res() res: Response,
    ) {
        // Enforce daily limit
        await this.pdfService.checkAndIncrementUsage(user.id, dto.gmailEmail);

        // Generate content
        const content = await this.smartNotebook.generate({
            topic: dto.topic,
            subject: dto.subject,
            depth: dto.depth,
            examFocus: dto.examFocus,
            includeTestSection: dto.includeTestSection ?? true,
            additionalNotes: dto.additionalNotes,
        });

        // Render
        const html = this.renderer.renderSmartNotebook(content);

        if (format === 'pdf') {
            const pdfBuffer = await this.renderer.generatePdfBuffer(html);
            const filename = `smart-notebook-${dto.subject}-${Date.now()}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(pdfBuffer);
        } else {
            res.json({
                mode: 'SMART_NOTEBOOK',
                topic: dto.topic,
                subject: dto.subject,
                content,
                html,
                usage: await this.pdfService.getUsage(user.id),
            });
        }
    }

    // ── Mode 2: Standard Illustrated ────────────────────────────────────────────

    @Post('generate/illustrated')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Mode 2: Generate Standard Illustrated Notes PDF',
        description: 'Bullet notes with auto-generated SVG diagrams, mind maps, tables, 20 MCQs, and 10 analytical CAPF AC questions.',
    })
    async generateIllustrated(
        @CurrentUser() user: any,
        @Body() dto: IllustratedNotesDto,
        @Query('format') format: 'pdf' | 'html' = 'html',
        @Res() res: Response,
    ) {
        // Enforce daily limit
        await this.pdfService.checkAndIncrementUsage(user.id, dto.gmailEmail);

        // Generate content
        const content = await this.illustratedNotes.generate({
            topic: dto.topic,
            subject: dto.subject,
            subtopics: dto.subtopics,
            diagramStyle: dto.diagramStyle,
        });

        // Render
        const html = this.renderer.renderIllustratedNotes(content);

        if (format === 'pdf') {
            const pdfBuffer = await this.renderer.generatePdfBuffer(html);
            const filename = `illustrated-notes-${dto.subject}-${Date.now()}.pdf`;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(pdfBuffer);
        } else {
            res.json({
                mode: 'ILLUSTRATED',
                topic: dto.topic,
                subject: dto.subject,
                content,
                html,
                usage: await this.pdfService.getUsage(user.id),
            });
        }
    }

    // ── Legacy generate endpoint ────────────────────────────────────────────────

    @Post('generate')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Legacy: Generate a PDF (enforces daily limit per Gmail account)' })
    async generate(
        @CurrentUser() user: any,
        @Body() dto: GeneratePdfDto,
        @Res() res: Response,
    ) {
        await this.pdfService.checkAndIncrementUsage(user.id, dto.gmailEmail);

        res.json({
            message: 'PDF generation queued',
            reportType: dto.reportType,
            gmailEmail: dto.gmailEmail,
            usage: await this.pdfService.getUsage(user.id),
        });
    }
}
