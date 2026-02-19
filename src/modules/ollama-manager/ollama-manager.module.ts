import { Module } from '@nestjs/common';
import { AiEngineModule } from '../ai-engine/ai-engine.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { OllamaManagerController } from './ollama-manager.controller';
import { DeviceDetectionService } from './device-detection.service';
import { ModelCompatibilityService } from './model-download/model-compatibility.service';
import { ModelDownloadService } from './model-download/model-download.service';
import { ModelDownloadGateway } from './model-download/model-download.gateway';
import { UserModelPreferenceService } from './user-model-preference.service';

@Module({
    imports: [AiEngineModule, PrismaModule],
    controllers: [OllamaManagerController],
    providers: [
        DeviceDetectionService,
        ModelCompatibilityService,
        ModelDownloadService,
        ModelDownloadGateway,
        UserModelPreferenceService,
    ],
    exports: [
        DeviceDetectionService,
        ModelCompatibilityService,
        ModelDownloadService,
        UserModelPreferenceService,
    ],
})
export class OllamaManagerModule { }
