import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { GoogleDriveStorageService } from './google-drive-storage.service';
import { DriveUploadQueueDto } from './dto/drive.dto';
import * as fs from 'fs';

export const DRIVE_UPLOAD_QUEUE = 'drive-upload';

@Processor(DRIVE_UPLOAD_QUEUE)
export class DriveUploadProcessor {
    private readonly logger = new Logger(DriveUploadProcessor.name);

    constructor(
        private readonly storageService: GoogleDriveStorageService,
    ) { }

    /**
     * Process a background Drive upload job.
     * Reads file from local temp path, uploads to user's Drive, then cleans up.
     */
    @Process('upload')
    async handleUpload(job: Job<DriveUploadQueueDto>): Promise<any> {
        const { userId, folder, fileName, mimeType, filePath } = job.data;

        this.logger.log(
            `📤 Processing Drive upload: "${fileName}" → ${folder} for user ${userId}`,
        );

        try {
            // Read file from temp path
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }

            const fileContent = fs.readFileSync(filePath);

            // Upload to Drive
            const result = await this.storageService.uploadFile(
                userId,
                folder,
                fileName,
                mimeType,
                fileContent,
            );

            // Clean up temp file
            try {
                fs.unlinkSync(filePath);
            } catch {
                this.logger.warn(`Could not delete temp file: ${filePath}`);
            }

            this.logger.log(
                `✅ Drive upload complete: "${fileName}" → ${result.webViewLink}`,
            );

            return result;
        } catch (err: any) {
            this.logger.error(
                `❌ Drive upload failed: "${fileName}" — ${err.message}`,
            );
            throw err; // Bull will retry based on queue config
        }
    }

    /**
     * Handle batch uploads (e.g. weekly report generation).
     */
    @Process('batch-upload')
    async handleBatchUpload(
        job: Job<{ uploads: DriveUploadQueueDto[] }>,
    ): Promise<any[]> {
        const { uploads } = job.data;
        const results: any[] = [];

        this.logger.log(`📦 Processing batch upload: ${uploads.length} files`);

        for (const upload of uploads) {
            try {
                if (!fs.existsSync(upload.filePath)) {
                    results.push({ fileName: upload.fileName, error: 'File not found' });
                    continue;
                }

                const fileContent = fs.readFileSync(upload.filePath);
                const result = await this.storageService.uploadFile(
                    upload.userId,
                    upload.folder,
                    upload.fileName,
                    upload.mimeType,
                    fileContent,
                );

                try {
                    fs.unlinkSync(upload.filePath);
                } catch { }

                results.push(result);
            } catch (err: any) {
                results.push({ fileName: upload.fileName, error: err.message });
            }
        }

        this.logger.log(`✅ Batch upload complete: ${results.length}/${uploads.length} succeeded`);
        return results;
    }
}
