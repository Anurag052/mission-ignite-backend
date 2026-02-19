import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, {
        logger: ['error', 'warn', 'log', 'debug'],
    });

    const configService = app.get(ConfigService);
    const port = configService.get<number>('PORT', 4000);
    const frontendUrl = configService.get<string>('FRONTEND_URL', 'http://localhost:3000');

    // Security
    app.use(helmet());
    app.use(compression());
    app.use(cookieParser());

    // CORS
    app.enableCors({
        origin: [frontendUrl, 'http://localhost:3000', 'http://localhost:4200'],
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
    });

    // Global prefix
    app.setGlobalPrefix('api/v1');

    // Versioning
    app.enableVersioning({ type: VersioningType.URI });

    // Validation
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: { enableImplicitConversion: true },
        }),
    );

    // WebSocket adapter
    app.useWebSocketAdapter(new IoAdapter(app));

    // Swagger
    if (configService.get<string>('SWAGGER_ENABLED') === 'true') {
        const config = new DocumentBuilder()
            .setTitle('Mission Ignite OTA SSB API')
            .setDescription('Production API for Mission Ignite — SSB, OTA, CAPF AC preparation platform')
            .setVersion('1.0')
            .addBearerAuth()
            .addTag('auth', 'Authentication & OAuth')
            .addTag('users', 'User management')
            .addTag('subjects', 'Subject & topic management')
            .addTag('mocks', 'Mock test engine')
            .addTag('pdf', 'PDF generation with daily limits')
            .addTag('gto', 'GTO real-time sessions')
            .addTag('analytics', 'Analytics & reporting')
            .addTag('admin', 'Admin operations')
            .build();
        const document = SwaggerModule.createDocument(app, config);
        SwaggerModule.setup('api/docs', app, document, {
            swaggerOptions: { persistAuthorization: true },
        });
    }

    await app.listen(port);
    console.log(`🚀 Mission Ignite Backend running on http://localhost:${port}/api/v1`);
    console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
