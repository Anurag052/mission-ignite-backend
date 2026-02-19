import { Injectable, Logger } from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';
import { Auth } from 'googleapis';
import { PrismaService } from '../../prisma/prisma.service';
import { GoogleDriveAuthService } from './google-drive-auth.service';
import { Readable } from 'stream';

/** Standard folder structure under user's Drive */
const FOLDER_STRUCTURE = {
    ROOT: 'MissionIgnite',
    PDFS: 'PDFs',
    NOTEBOOKS: 'Notebooks',
    AUDIO: 'Audio',
    REPORTS: 'Reports',
} as const;

export type DriveFolderName = keyof typeof FOLDER_STRUCTURE;

export interface DriveUploadResult {
    fileId: string;
    fileName: string;
    mimeType: string;
    webViewLink: string;
    size: number;
    folderId: string;
}

@Injectable()
export class GoogleDriveStorageService {
    private readonly logger = new Logger(GoogleDriveStorageService.name);

    constructor(
        private readonly authService: GoogleDriveAuthService,
        private readonly prisma: PrismaService,
    ) { }

    /**
     * Ensure the MissionIgnite folder structure exists on user's Drive.
     * Creates: MissionIgnite/ → { PDFs/, Notebooks/, Audio/, Reports/ }
     */
    async ensureFolderStructure(userId: string): Promise<string> {
        const authClient = await this.authService.getAuthenticatedClient(userId);
        const drive = google.drive({ version: 'v3', auth: authClient });

        // Check for existing root folder stored in DB
        const stored = await this.prisma.googleDriveToken.findUnique({
            where: { userId },
        });

        if (stored?.rootFolderId) {
            // Verify it still exists on Drive
            try {
                await drive.files.get({
                    fileId: stored.rootFolderId,
                    fields: 'id,trashed',
                });
                // If not trashed, reuse
                const file = await drive.files.get({
                    fileId: stored.rootFolderId,
                    fields: 'id,trashed',
                });
                if (!(file.data as any).trashed) {
                    return stored.rootFolderId;
                }
            } catch {
                // Folder deleted or inaccessible — recreate
            }
        }

        // Create root folder
        const rootFolderId = await this.createFolder(drive, FOLDER_STRUCTURE.ROOT, null);

        // Create subfolders
        await Promise.all([
            this.createFolder(drive, FOLDER_STRUCTURE.PDFS, rootFolderId),
            this.createFolder(drive, FOLDER_STRUCTURE.NOTEBOOKS, rootFolderId),
            this.createFolder(drive, FOLDER_STRUCTURE.AUDIO, rootFolderId),
            this.createFolder(drive, FOLDER_STRUCTURE.REPORTS, rootFolderId),
        ]);

        // Store root folder ID in DB
        await this.prisma.googleDriveToken.update({
            where: { userId },
            data: { rootFolderId },
        });

        this.logger.log(`📁 Created Drive folder structure for user: ${userId}`);
        return rootFolderId;
    }

    /**
     * Upload a file to the user's Drive within the MissionIgnite folder.
     *
     * @param userId — User ID
     * @param folderName — Subfolder name (PDFs, Notebooks, Audio, Reports)
     * @param fileName — File name
     * @param mimeType — MIME type
     * @param content — File content (Buffer or Readable stream)
     */
    async uploadFile(
        userId: string,
        folderName: string,
        fileName: string,
        mimeType: string,
        content: Buffer | Readable,
    ): Promise<DriveUploadResult> {
        const authClient = await this.authService.getAuthenticatedClient(userId);
        const drive = google.drive({ version: 'v3', auth: authClient });

        // Ensure folder structure exists
        const rootFolderId = await this.ensureFolderStructure(userId);

        // Find the target subfolder
        const targetFolderId = await this.getSubfolderId(
            drive,
            rootFolderId,
            folderName,
        );

        // Upload file
        const media = {
            mimeType,
            body: content instanceof Buffer
                ? Readable.from(content)
                : content,
        };

        const res = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [targetFolderId],
                mimeType,
            },
            media,
            fields: 'id,name,mimeType,webViewLink,size',
        });

        const result: DriveUploadResult = {
            fileId: res.data.id!,
            fileName: res.data.name!,
            mimeType: res.data.mimeType!,
            webViewLink: res.data.webViewLink || '',
            size: parseInt(res.data.size as string, 10) || 0,
            folderId: targetFolderId,
        };

        this.logger.log(
            `📤 Uploaded "${fileName}" to Drive/${folderName} for user ${userId}`,
        );

        return result;
    }

    /**
     * List files in a specific subfolder.
     */
    async listFiles(
        userId: string,
        folderName?: string,
        pageSize: number = 20,
        pageToken?: string,
    ): Promise<{ files: drive_v3.Schema$File[]; nextPageToken?: string }> {
        const authClient = await this.authService.getAuthenticatedClient(userId);
        const drive = google.drive({ version: 'v3', auth: authClient });

        const rootFolderId = await this.ensureFolderStructure(userId);
        let parentId = rootFolderId;

        if (folderName) {
            parentId = await this.getSubfolderId(drive, rootFolderId, folderName);
        }

        const res = await drive.files.list({
            q: `'${parentId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)',
            pageSize,
            pageToken,
            orderBy: 'modifiedTime desc',
        });

        return {
            files: res.data.files || [],
            nextPageToken: res.data.nextPageToken || undefined,
        };
    }

    /**
     * Delete a file from user's Drive.
     */
    async deleteFile(userId: string, fileId: string): Promise<void> {
        const authClient = await this.authService.getAuthenticatedClient(userId);
        const drive = google.drive({ version: 'v3', auth: authClient });
        await drive.files.delete({ fileId });
        this.logger.log(`🗑️ Deleted file ${fileId} from Drive for user ${userId}`);
    }

    /**
     * Get Drive storage quota info for the user.
     */
    async getStorageQuota(userId: string): Promise<{
        limit: number;
        usage: number;
        usageInDrive: number;
    }> {
        const authClient = await this.authService.getAuthenticatedClient(userId);
        const drive = google.drive({ version: 'v3', auth: authClient });
        const res = await drive.about.get({ fields: 'storageQuota' });
        const quota = res.data.storageQuota;
        return {
            limit: parseInt(quota?.limit || '0', 10),
            usage: parseInt(quota?.usage || '0', 10),
            usageInDrive: parseInt(quota?.usageInDrive || '0', 10),
        };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private async createFolder(
        drive: drive_v3.Drive,
        name: string,
        parentId: string | null,
    ): Promise<string> {
        const metadata: drive_v3.Schema$File = {
            name,
            mimeType: 'application/vnd.google-apps.folder',
        };
        if (parentId) metadata.parents = [parentId];

        const res = await drive.files.create({
            requestBody: metadata,
            fields: 'id',
        });
        return res.data.id!;
    }

    private async getSubfolderId(
        drive: drive_v3.Drive,
        parentId: string,
        folderName: string,
    ): Promise<string> {
        // Search for existing subfolder
        const res = await drive.files.list({
            q: `'${parentId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id)',
            pageSize: 1,
        });

        if (res.data.files && res.data.files.length > 0) {
            return res.data.files[0].id!;
        }

        // Create if not found
        return this.createFolder(drive, folderName, parentId);
    }
}
