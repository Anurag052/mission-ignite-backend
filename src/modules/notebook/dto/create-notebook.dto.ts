
import { IsString, IsEnum, IsOptional, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotebookCategory } from '@prisma/client';

export class CreateNotebookDto {
    @ApiProperty({ example: 'Indian Geography — Physical Features' })
    @IsString()
    title: string;

    @ApiProperty({ enum: NotebookCategory, default: 'GENERAL' })
    @IsEnum(NotebookCategory)
    @IsOptional()
    category?: NotebookCategory = NotebookCategory.GENERAL;

    @ApiPropertyOptional({ example: ['geography', 'capf', 'physical-features'] })
    @IsArray()
    @IsOptional()
    tags?: string[];
}
