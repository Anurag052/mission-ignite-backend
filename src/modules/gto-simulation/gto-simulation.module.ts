import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { VoiceAnalysisService } from './voice/voice-analysis.service';
import { PressureEngine } from './pressure/pressure.engine';
import { GtoSimulationGateway } from './gateway/gto-simulation.gateway';
import { PostTestAnalysisService } from './analysis/post-test-analysis.service';
import { VideoOverviewService } from './video/video-overview.service';
import { SimulationScenesService } from './scenes/simulation-scenes.service';
import { GtoSimulationController } from './gto-simulation.controller';

@Module({
    imports: [
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                secret: config.get<string>('JWT_SECRET'),
            }),
        }),
    ],
    providers: [
        // Core services
        VoiceAnalysisService,
        PressureEngine,
        PostTestAnalysisService,
        VideoOverviewService,
        SimulationScenesService,

        // WebSocket gateway
        GtoSimulationGateway,
    ],
    controllers: [GtoSimulationController],
    exports: [PostTestAnalysisService, VideoOverviewService, SimulationScenesService],
})
export class GtoSimulationModule { }
