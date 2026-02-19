import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { BehaviorAnalysisBridge } from './behavior-analysis.bridge';
import { BehaviorAnalysisGateway } from './behavior-analysis.gateway';
import { BehaviorAnalysisController } from './behavior-analysis.controller';

@Module({
    imports: [
        PrismaModule,
        ConfigModule,
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                secret: config.get<string>('JWT_SECRET'),
            }),
        }),
    ],
    controllers: [BehaviorAnalysisController],
    providers: [
        BehaviorAnalysisBridge,
        BehaviorAnalysisGateway,
    ],
    exports: [BehaviorAnalysisBridge],
})
export class BehaviorAnalysisModule { }
