import {
    Controller,
    Get,
    Post,
    Body,
    Req,
    UseGuards,
    HttpCode,
    HttpStatus,
    BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsInt, Min } from 'class-validator';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DeviceDetectionService, DeviceProfile } from './device-detection.service';
import { ModelCompatibilityService } from './model-download/model-compatibility.service';
import { ModelDownloadService } from './model-download/model-download.service';
import { UserModelPreferenceService } from './user-model-preference.service';
import { OllamaClient } from '../ai-engine/ollama/ollama.client';
import { MODEL_CATALOG } from './model-download/model-catalog';
import { DeviceType } from '@prisma/client';

// ── DTOs ────────────────────────────────────────────────────────────────────────

class SelectModelDto {
    @IsString()
    modelName: string;

    @IsIn(['server', 'local'])
    ollamaMode: 'server' | 'local';

    @IsOptional()
    @IsString()
    ollamaUrl?: string;

    @IsOptional()
    @IsIn(['ANDROID', 'DESKTOP', 'TABLET', 'UNKNOWN'])
    deviceType?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    deviceRamMb?: number;
}

class DownloadModelDto {
    @IsString()
    modelName: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    freeStorageMb?: number;
}

// ── Controller ──────────────────────────────────────────────────────────────────

@ApiTags('ollama-manager')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ollama')
export class OllamaManagerController {
    constructor(
        private readonly deviceDetection: DeviceDetectionService,
        private readonly compatibility: ModelCompatibilityService,
        private readonly downloadService: ModelDownloadService,
        private readonly preferenceService: UserModelPreferenceService,
        private readonly ollamaClient: OllamaClient,
    ) { }

    // ── Device Profile ──────────────────────────────────────────────────────────

    @Get('device-profile')
    @ApiOperation({
        summary: 'Detect device type, RAM, and compatibility',
        description: 'Reads User-Agent + custom headers (X-Device-Type, X-Device-RAM, X-Device-Storage) to determine device profile.',
    })
    @ApiHeader({ name: 'X-Device-Type', required: false, description: 'ANDROID | DESKTOP | TABLET' })
    @ApiHeader({ name: 'X-Device-RAM', required: false, description: 'Device RAM in MB' })
    @ApiHeader({ name: 'X-Device-Storage', required: false, description: 'Free storage in MB' })
    detectDevice(@Req() req: Request) {
        return this.deviceDetection.detect(req);
    }

    // ── Model Recommendations ───────────────────────────────────────────────────

    @Get('models/recommended')
    @ApiOperation({
        summary: 'Get recommended models for this device',
        description: 'Filters and ranks models by device type, RAM, and storage. Android capped at 2GB.',
    })
    @ApiHeader({ name: 'X-Device-Type', required: false })
    @ApiHeader({ name: 'X-Device-RAM', required: false })
    @ApiHeader({ name: 'X-Device-Storage', required: false })
    getRecommendedModels(@Req() req: Request) {
        const profile = this.deviceDetection.detect(req);
        const models = this.compatibility.getRecommendedModels(profile);
        return {
            deviceProfile: profile,
            models,
            totalCatalogModels: MODEL_CATALOG.length,
        };
    }

    @Get('models/catalog')
    @ApiOperation({ summary: 'Get full model catalog (all models regardless of compatibility)' })
    getFullCatalog() {
        return { models: MODEL_CATALOG };
    }

    // ── Model Selection & Preference ────────────────────────────────────────────

    @Post('models/select')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Select a model and save preference',
        description: 'Validates compatibility, stores preference in DB, and optionally triggers model download.',
    })
    async selectModel(
        @Body() dto: SelectModelDto,
        @CurrentUser() user: any,
        @Req() req: Request,
    ) {
        const profile = this.deviceDetection.detect(req);
        const deviceType = (dto.deviceType || profile.deviceType) as DeviceType;

        // Validate compatibility
        const check = this.compatibility.isModelCompatible(dto.modelName, {
            ...profile,
            deviceType: deviceType as any,
            ramMb: dto.deviceRamMb || profile.ramMb,
        });

        if (!check.compatible) {
            throw new BadRequestException(check.reason);
        }

        // Find model size from catalog
        const catalogModel = MODEL_CATALOG.find((m) => m.name === dto.modelName);
        const modelSizeMb = catalogModel?.sizeMb || 0;

        // Save preference
        const preference = await this.preferenceService.setPreference({
            userId: user.id,
            deviceType,
            deviceRamMb: dto.deviceRamMb || (profile.ramMb ?? undefined),
            selectedModel: dto.modelName,
            modelSizeMb,
            ollamaMode: dto.ollamaMode,
            ollamaUrl: dto.ollamaUrl,
        });

        return {
            preference,
            model: catalogModel,
            compatibility: check,
        };
    }

    @Get('models/preference')
    @ApiOperation({ summary: 'Get current user model preferences (all devices)' })
    async getPreferences(@CurrentUser() user: any) {
        const preferences = await this.preferenceService.getAllPreferences(user.id);
        return { preferences };
    }

    // ── Model Download ──────────────────────────────────────────────────────────

    @Post('models/download')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Download a model to server-side Ollama',
        description: 'Triggers model pull on the server Ollama instance. For real-time progress, use the /model-download WebSocket.',
    })
    async downloadModel(@Body() dto: DownloadModelDto) {
        const catalogModel = MODEL_CATALOG.find((m) => m.name === dto.modelName);

        // Storage validation
        if (catalogModel && dto.freeStorageMb !== undefined) {
            const storageCheck = this.downloadService.validateStorage(
                catalogModel.sizeMb,
                dto.freeStorageMb,
            );
            if (!storageCheck.valid) {
                throw new BadRequestException(storageCheck.reason);
            }
        }

        // Start download (non-streaming response — use WebSocket for progress)
        const result = await this.downloadService.downloadModel(dto.modelName);
        return result;
    }

    @Get('models/downloads/active')
    @ApiOperation({ summary: 'Get all active model downloads and their progress' })
    getActiveDownloads() {
        return { downloads: this.downloadService.getAllActive() };
    }

    // ── Status ──────────────────────────────────────────────────────────────────

    @Get('status')
    @ApiOperation({ summary: 'Get Ollama manager status (health, active model, server info)' })
    async getStatus() {
        const healthy = this.ollamaClient.getIsHealthy();
        const activeModel = this.ollamaClient.getActiveModel();
        const localModels = healthy ? await this.ollamaClient.listLocalModels() : [];

        return {
            ollama: {
                healthy,
                baseUrl: this.ollamaClient.getBaseUrl(),
                activeModel,
                localModels: localModels.map((m) => ({
                    name: m.name,
                    sizeMb: Math.round(m.size / 1024 / 1024),
                })),
            },
            catalog: {
                totalModels: MODEL_CATALOG.length,
            },
            downloads: {
                active: this.downloadService.getAllActive(),
            },
        };
    }
}
