import {
    Controller,
    Post,
    Delete,
    Get,
    Param,
    Body,
    UseGuards,
    UseInterceptors,
    UploadedFile,
    Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role, UploadType, MenuType } from '@prisma/client';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('upload')
export class UploadController {
    constructor(private readonly uploadService: UploadService) { }

    @Post()
    @Roles(Role.ADMIN, Role.INSTRUCTOR)
    @UseInterceptors(
        FileInterceptor('file', {
            storage: memoryStorage(), // Buffer in memory → stream to Cloudinary
            limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB hard limit at Multer level
        }),
    )
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                file: { type: 'string', format: 'binary' },
                uploadType: { type: 'string', enum: Object.values(UploadType) },
                menuType: { type: 'string', enum: Object.values(MenuType) },
                subjectId: { type: 'string' },
                description: { type: 'string' },
            },
            required: ['file', 'uploadType'],
        },
    })
    @ApiOperation({ summary: 'Upload a file to Cloudinary (Admin/Instructor only, max 20 MB)' })
    async upload(
        @UploadedFile() file: Express.Multer.File,
        @CurrentUser() user: any,
        @Body('uploadType') uploadType: UploadType,
        @Body('menuType') menuType?: MenuType,
        @Body('subjectId') subjectId?: string,
        @Body('description') description?: string,
    ) {
        return this.uploadService.uploadFile(
            file,
            user.id,
            uploadType,
            menuType,
            subjectId,
            description,
        );
    }

    @Delete(':publicId')
    @Roles(Role.ADMIN)
    @ApiOperation({ summary: 'Delete a file from Cloudinary (Admin only)' })
    async delete(
        @Param('publicId') publicId: string,
        @Query('uploadId') uploadId: string,
    ) {
        return this.uploadService.deleteFile(publicId, uploadId);
    }
}
