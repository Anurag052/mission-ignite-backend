import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Query,
    Req,
    Res,
    UseGuards,
    UseInterceptors,
    UploadedFile,
    HttpCode,
    HttpStatus,
    BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { GoogleDriveAuthService } from './google-drive-auth.service';
import { GoogleDriveStorageService } from './google-drive-storage.service';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { DRIVE_UPLOAD_QUEUE } from './drive-upload.processor';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@ApiTags('google-drive')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('drive')
export class GoogleDriveController {
    constructor(
        private readonly authService: GoogleDriveAuthService,
        private readonly storageService: GoogleDriveStorageService,
        private readonly config: ConfigService,
        @InjectQueue(DRIVE_UPLOAD_QUEUE) private readonly uploadQueue: Queue,
    ) { }

    // ── OAuth Connect ───────────────────────────────────────────────────────────

    @Get('connect')
    @ApiOperation({
        summary: 'Get Google Drive authorization URL',
        description: 'Returns a URL to redirect the user to Google OAuth consent screen. Scope: drive.file (app-only files).',
    })
    getConnectUrl(@CurrentUser() user: any) {
        const url = this.authService.getAuthorizationUrl(user.id);
        return { authorizationUrl: url };
    }

    @Get('callback')
    @ApiOperation({
        summary: 'OAuth callback — exchanges code for tokens',
        description: 'Called by Google after user consent. Exchanges auth code for access + refresh tokens.',
    })
    async handleCallback(
        @Query('code') code: string,
        @Query('state') state: string,
        @Res() res: Response,
    ) {
        if (!code || !state) {
            throw new BadRequestException('Missing code or state parameter');
        }

        await this.authService.handleCallback(code, state);

        // Redirect to frontend with success indicator
        const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
        res.redirect(`${frontendUrl}/settings/drive?connected=true`);
    }

    // ── Connection Management ───────────────────────────────────────────────────

    @Get('status')
    @ApiOperation({ summary: 'Check Google Drive connection status' })
    async getStatus(@CurrentUser() user: any) {
        const connected = await this.authService.isConnected(user.id);
        let quota = null;

        if (connected) {
            try {
                quota = await this.storageService.getStorageQuota(user.id);
            } catch {
                // Quota check may fail if tokens expired
            }
        }

        return { connected, quota };
    }

    @Delete('disconnect')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Disconnect Google Drive (revoke tokens)' })
    async disconnect(@CurrentUser() user: any) {
        await this.authService.disconnect(user.id);
        return { message: 'Google Drive disconnected successfully' };
    }

    // ── File Upload ─────────────────────────────────────────────────────────────

    @Post('upload')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Upload a file to user\'s Google Drive',
        description: 'Uploads directly to MissionIgnite/{folder} on user\'s Drive. Supported folders: PDFs, Notebooks, Audio, Reports.',
    })
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(FileInterceptor('file'))
    async uploadFile(
        @UploadedFile() file: Express.Multer.File,
        @Query('folder') folder: string,
        @CurrentUser() user: any,
    ) {
        if (!file) {
            throw new BadRequestException('No file provided');
        }
        if (!folder) {
            throw new BadRequestException('Folder parameter is required (PDFs, Notebooks, Audio, Reports)');
        }

        const validFolders = ['PDFs', 'Notebooks', 'Audio', 'Reports'];
        if (!validFolders.includes(folder)) {
            throw new BadRequestException(
                `Invalid folder: "${folder}". Must be one of: ${validFolders.join(', ')}`,
            );
        }

        const result = await this.storageService.uploadFile(
            user.id,
            folder,
            file.originalname,
            file.mimetype,
            file.buffer,
        );

        return result;
    }

    // ── Background Upload (Queue) ───────────────────────────────────────────────

    @Post('upload/queue')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Queue a file for background upload to Google Drive',
        description: 'Accepts a file and queues it for async upload via Bull. Returns job ID for tracking.',
    })
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(FileInterceptor('file'))
    async queueUpload(
        @UploadedFile() file: Express.Multer.File,
        @Query('folder') folder: string,
        @CurrentUser() user: any,
    ) {
        if (!file) throw new BadRequestException('No file provided');
        if (!folder) throw new BadRequestException('Folder parameter required');

        // Save to temp file for async processing
        const tempDir = path.join(os.tmpdir(), 'mission-ignite-uploads');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const tempPath = path.join(tempDir, `${Date.now()}-${file.originalname}`);
        fs.writeFileSync(tempPath, file.buffer);

        // Add to Bull queue
        const job = await this.uploadQueue.add('upload', {
            userId: user.id,
            folder,
            fileName: file.originalname,
            mimeType: file.mimetype,
            filePath: tempPath,
        }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: false,
        });

        return {
            jobId: job.id,
            message: 'File queued for background upload to Google Drive',
            fileName: file.originalname,
            folder,
        };
    }

    // ── File Listing ────────────────────────────────────────────────────────────

    @Get('files')
    @ApiOperation({ summary: 'List files in user\'s MissionIgnite Drive folder' })
    @ApiQuery({ name: 'folder', required: false, description: 'Subfolder: PDFs, Notebooks, Audio, Reports' })
    @ApiQuery({ name: 'pageSize', required: false, type: Number })
    @ApiQuery({ name: 'pageToken', required: false })
    async listFiles(
        @CurrentUser() user: any,
        @Query('folder') folder?: string,
        @Query('pageSize') pageSize?: number,
        @Query('pageToken') pageToken?: string,
    ) {
        return this.storageService.listFiles(
            user.id,
            folder,
            pageSize || 20,
            pageToken,
        );
    }

    // ── File Deletion ───────────────────────────────────────────────────────────

    @Delete('files')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete a file from user\'s Google Drive' })
    async deleteFile(
        @Query('fileId') fileId: string,
        @CurrentUser() user: any,
    ) {
        if (!fileId) throw new BadRequestException('fileId parameter required');
        await this.storageService.deleteFile(user.id, fileId);
        return { message: 'File deleted successfully', fileId };
    }

    // ── Folder Setup ────────────────────────────────────────────────────────────

    @Post('setup-folders')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Initialize MissionIgnite folder structure on user\'s Drive',
        description: 'Creates MissionIgnite/ with PDFs/, Notebooks/, Audio/, Reports/ subfolders.',
    })
    async setupFolders(@CurrentUser() user: any) {
        const rootFolderId = await this.storageService.ensureFolderStructure(user.id);
        return { rootFolderId, message: 'Folder structure created on Google Drive' };
    }
}
