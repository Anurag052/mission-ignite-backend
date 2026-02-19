import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { MocksModule } from './modules/mocks/mocks.module';
import { PdfModule } from './modules/pdf/pdf.module';
import { GtoModule } from './modules/gto/gto.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AdminModule } from './modules/admin/admin.module';
import { AgentLogsModule } from './modules/agent-logs/agent-logs.module';
import { CronModule } from './modules/cron/cron.module';
import { UploadModule } from './modules/upload/upload.module';
import { AiEngineModule } from './modules/ai-engine/ai-engine.module';
import { HealthModule } from './modules/health/health.module';
import { GtoSimulationModule } from './modules/gto-simulation/gto-simulation.module';
import { BehaviorAnalysisModule } from './modules/behavior-analysis/behavior-analysis.module';
import { NotebookModule } from './modules/notebook/notebook.module';
import { OllamaManagerModule } from './modules/ollama-manager/ollama-manager.module';
import { GoogleDriveModule } from './modules/google-drive/google-drive.module';

@Module({
    imports: [
        // Config
        ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

        // Rate limiting
        ThrottlerModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => [
                {
                    ttl: config.get<number>('THROTTLE_TTL', 60) * 1000,
                    limit: config.get<number>('THROTTLE_LIMIT', 100),
                },
            ],
        }),

        // Cron jobs
        ScheduleModule.forRoot(),

        // Bull queue (Redis-backed)
        BullModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const redisUrl = config.get<string>('REDIS_URL');
                if (redisUrl) {
                    return { url: redisUrl };
                }
                return {
                    redis: {
                        host: config.get<string>('REDIS_HOST', 'localhost'),
                        port: config.get<number>('REDIS_PORT', 6379),
                        password: config.get<string>('REDIS_PASSWORD') || undefined,
                    },
                };
            },
        }),

        // Core
        PrismaModule,
        RedisModule,

        // Feature modules
        AuthModule,
        UsersModule,
        SubjectsModule,
        MocksModule,
        PdfModule,
        GtoModule,
        AnalyticsModule,
        AdminModule,
        AgentLogsModule,
        CronModule,
        UploadModule,
        AiEngineModule,
        HealthModule,
        GtoSimulationModule,
        BehaviorAnalysisModule,
        NotebookModule,
        OllamaManagerModule,
        GoogleDriveModule,
    ],
})
export class AppModule { }
