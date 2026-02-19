import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../prisma/prisma.module';
import { GoogleDriveController } from './google-drive.controller';
import { GoogleDriveAuthService } from './google-drive-auth.service';
import { GoogleDriveStorageService } from './google-drive-storage.service';
import { DriveUploadProcessor, DRIVE_UPLOAD_QUEUE } from './drive-upload.processor';

@Module({
    imports: [
        PrismaModule,
        BullModule.registerQueue({
            name: DRIVE_UPLOAD_QUEUE,
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: true,
            },
        }),
    ],
    controllers: [GoogleDriveController],
    providers: [
        GoogleDriveAuthService,
        GoogleDriveStorageService,
        DriveUploadProcessor,
    ],
    exports: [
        GoogleDriveAuthService,
        GoogleDriveStorageService,
    ],
})
export class GoogleDriveModule { }
