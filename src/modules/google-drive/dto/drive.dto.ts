import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DriveConnectResponseDto {
    @ApiProperty()
    authorizationUrl: string;
}

export class DriveCallbackDto {
    @ApiProperty()
    @IsString()
    code: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    state?: string;
}

export class DriveUploadDto {
    @ApiProperty({ description: 'Target subfolder: PDFs, Notebooks, Audio, Reports' })
    @IsString()
    folder: string;

    @ApiProperty({ description: 'Original file name' })
    @IsString()
    fileName: string;

    @ApiProperty({ description: 'MIME type of the file' })
    @IsString()
    mimeType: string;
}

export class DriveUploadQueueDto {
    userId: string;
    folder: string;
    fileName: string;
    mimeType: string;
    filePath: string; // local temp path or buffer reference
}
