
import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class FileValidationPipe implements PipeTransform {
    transform(file: Express.Multer.File) {
        if (!file) {
            throw new BadRequestException('File is required');
        }

        // 1. Check MIME type (trusting extension/header isn't enough, but it's a start)
        if (file.mimetype !== 'application/pdf') {
            throw new BadRequestException('Only PDF files are allowed');
        }

        // 2. Magic Bytes Validation for PDF (%PDF)
        // PDF files start with %PDF (Hex: 25 50 44 46)
        const buffer = file.buffer;
        if (!buffer || buffer.length < 4) {
            throw new BadRequestException('Invalid file content');
        }

        // Check first 4 bytes
        if (
            buffer[0] !== 0x25 || // %
            buffer[1] !== 0x50 || // P
            buffer[2] !== 0x44 || // D
            buffer[3] !== 0x46    // F
        ) {
            throw new BadRequestException('Invalid PDF file signature');
        }

        // 3. Size check (Max 20MB) - redundantly checked here for safety
        const maxSize = 20 * 1024 * 1024;
        if (file.size > maxSize) {
            throw new BadRequestException('File size must not exceed 20MB');
        }

        return file;
    }
}
