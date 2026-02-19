import {
    Injectable,
    BadRequestException,
    PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadType, MenuType } from '@prisma/client';

const ALLOWED_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'video/mp4',
    'video/webm',
];

@Injectable()
export class UploadService {
    private readonly maxFileSizeBytes: number;

    constructor(
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
    ) {
        const maxMb = this.config.get<number>('MAX_FILE_SIZE_MB', 20);
        this.maxFileSizeBytes = maxMb * 1024 * 1024;

        // Configure Cloudinary
        cloudinary.config({
            cloud_name: this.config.get<string>('CLOUDINARY_CLOUD_NAME'),
            api_key: this.config.get<string>('CLOUDINARY_API_KEY'),
            api_secret: this.config.get<string>('CLOUDINARY_API_SECRET'),
            secure: true,
        });
    }

    async uploadFile(
        file: Express.Multer.File,
        uploadedById: string,
        uploadType: UploadType,
        menuType?: MenuType,
        subjectId?: string,
        description?: string,
    ) {
        // Validate MIME type
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            throw new BadRequestException(
                `File type ${file.mimetype} is not allowed. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
            );
        }

        // Validate file size
        if (file.size > this.maxFileSizeBytes) {
            throw new PayloadTooLargeException(
                `File size ${(file.size / 1024 / 1024).toFixed(2)} MB exceeds the ${this.config.get('MAX_FILE_SIZE_MB')} MB limit`,
            );
        }

        // Upload to Cloudinary
        const cloudinaryResult = await this.uploadToCloudinary(file);

        // Save record to DB
        const record = await this.prisma.adminUpload.create({
            data: {
                uploadedById,
                uploadType,
                fileName: file.originalname,
                fileUrl: cloudinaryResult.secure_url,
                fileSizeMb: parseFloat((file.size / 1024 / 1024).toFixed(2)),
                mimeType: file.mimetype,
                menuType,
                subjectId,
                description,
            },
        });

        return {
            id: record.id,
            url: cloudinaryResult.secure_url,
            publicId: cloudinaryResult.public_id,
            fileName: file.originalname,
            fileSizeMb: record.fileSizeMb,
            mimeType: file.mimetype,
        };
    }

    async deleteFile(publicId: string, uploadId: string) {
        await cloudinary.uploader.destroy(publicId);
        await this.prisma.adminUpload.update({
            where: { id: uploadId },
            data: { isActive: false },
        });
        return { message: 'File deleted successfully' };
    }

    private uploadToCloudinary(file: Express.Multer.File): Promise<UploadApiResponse> {
        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: 'mission-ignite',
                    upload_preset: this.config.get<string>('CLOUDINARY_UPLOAD_PRESET'),
                    resource_type: 'auto',
                    use_filename: true,
                    unique_filename: true,
                },
                (error, result) => {
                    if (error) return reject(error);
                    resolve(result!);
                },
            );

            const readable = new Readable();
            readable.push(file.buffer);
            readable.push(null);
            readable.pipe(uploadStream);
        });
    }
}
