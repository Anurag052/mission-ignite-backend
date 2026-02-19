
import {
    Controller,
    Post,
    UseInterceptors,
    UploadedFile,
    Body,
    Get,
    Query,
    Param,
    Delete,
    UseGuards,
    Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { NotebookService } from './notebook.service';
import { CreateNotebookDto } from './dto/create-notebook.dto';
import { NotebookSearchService } from './notebook-search.service';
import { NotebookAnalyticsService } from './notebook-analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FileValidationPipe } from '../../common/pipes/file-validation.pipe';
import { UploadRateLimitGuard } from '../../common/guards/upload-rate-limit.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('notebooks')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@Controller('notebooks')
export class NotebookController {
    constructor(
        private readonly notebookService: NotebookService,
        private readonly searchService: NotebookSearchService,
        private readonly analyticsService: NotebookAnalyticsService,
    ) { }

    @Post('upload')
    @UseGuards(UploadRateLimitGuard)
    @UseInterceptors(FileInterceptor('file'))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({ summary: 'Upload PDF and generate AI notebook' })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                },
                category: {
                    type: 'string',
                    enum: ['SSB', 'OTA', 'CAPF_AC', 'GENERAL'],
                },
            },
        },
    })
    async uploadNotebook(
        @UploadedFile(new FileValidationPipe()) file: Express.Multer.File,
        @Body() dto: CreateNotebookDto,
        @CurrentUser() user: any,
    ) {
        return this.notebookService.processNotebook(file, dto, user.id);
    }

    @Get()
    @ApiOperation({ summary: 'List user notebooks' })
    async getUserNotebooks(
        @CurrentUser() user: any,
        @Query('category') category?: string,
    ) {
        return this.notebookService.getUserNotebooks(user.id, category);
    }

    @Get('search')
    @ApiOperation({ summary: 'Search within notebooks' })
    async search(
        @CurrentUser() user: any,
        @Query('q') query: string,
        @Query('category') category?: string,
    ) {
        return this.searchService.search(user.id, query, category);
    }

    @Get('analytics')
    @ApiOperation({ summary: 'Get weekly analytics' })
    async getAnalytics(@CurrentUser() user: any) {
        return this.analyticsService.getWeeklyStats(user.id);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get notebook details' })
    async getNotebook(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.notebookService.getNotebook(id, user.id);
    }

    @Get(':id/status')
    @ApiOperation({ summary: 'Check processing status' })
    async getStatus(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.notebookService.getStatus(id, user.id);
    }

    @Post(':id/regenerate')
    @ApiOperation({ summary: 'Regenerate specific content' })
    async regenerateContent(
        @Param('id') id: string,
        @Body('contentType') contentType: string,
        @CurrentUser() user: any,
    ) {
        return this.notebookService.regenerateContent(id, user.id, contentType);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete notebook' })
    async deleteNotebook(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.notebookService.deleteNotebook(id, user.id);
    }
}
