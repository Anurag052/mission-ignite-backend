import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    ConnectedSocket,
    MessageBody,
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ModelDownloadService, DownloadProgress } from './model-download.service';
import { ModelCompatibilityService } from './model-compatibility.service';
import { DeviceProfile } from '../device-detection.service';

@WebSocketGateway({
    namespace: '/model-download',
    cors: { origin: '*' },
})
export class ModelDownloadGateway
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(ModelDownloadGateway.name);

    constructor(
        private readonly downloadService: ModelDownloadService,
        private readonly compatibilityService: ModelCompatibilityService,
    ) { }

    afterInit() {
        this.logger.log('🔌 Model Download WebSocket gateway initialized');
    }

    handleConnection(client: Socket) {
        this.logger.debug(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        this.logger.debug(`Client disconnected: ${client.id}`);
    }

    /**
     * Client sends: { modelName: "gemma2:2b", deviceProfile: { ... } }
     * Server streams back progress events.
     */
    @SubscribeMessage('start-download')
    async handleStartDownload(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { modelName: string; deviceProfile?: Partial<DeviceProfile> },
    ) {
        const { modelName, deviceProfile } = data;

        this.logger.log(`📥 Download requested: ${modelName} from client ${client.id}`);

        // Optional: validate compatibility
        if (deviceProfile) {
            const profile: DeviceProfile = {
                deviceType: deviceProfile.deviceType || 'UNKNOWN',
                ramMb: deviceProfile.ramMb || null,
                storageMb: deviceProfile.storageMb || null,
                userAgent: '',
                isLocalOllamaCapable: deviceProfile.isLocalOllamaCapable ?? false,
            };

            const check = this.compatibilityService.isModelCompatible(modelName, profile);
            if (!check.compatible) {
                client.emit('download-error', {
                    modelName,
                    error: check.reason,
                });
                return;
            }
        }

        // Start download with progress streaming
        const result = await this.downloadService.downloadModel(
            modelName,
            (progress: DownloadProgress) => {
                client.emit('download-progress', progress);
            },
        );

        if (result.status === 'completed') {
            client.emit('download-complete', result);
        } else {
            client.emit('download-error', result);
        }
    }

    /**
     * Client requests retry of a failed download.
     */
    @SubscribeMessage('retry-download')
    async handleRetryDownload(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { modelName: string },
    ) {
        this.logger.log(`🔄 Retry requested: ${data.modelName} from client ${client.id}`);

        const result = await this.downloadService.retryDownload(
            data.modelName,
            (progress: DownloadProgress) => {
                client.emit('download-progress', progress);
            },
        );

        if (result.status === 'completed') {
            client.emit('download-complete', result);
        } else {
            client.emit('download-error', result);
        }
    }

    /**
     * Client requests cancellation.
     */
    @SubscribeMessage('cancel-download')
    handleCancelDownload(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { modelName: string },
    ) {
        const cancelled = this.downloadService.cancelDownload(data.modelName);
        client.emit('download-cancelled', {
            modelName: data.modelName,
            cancelled,
        });
    }

    /**
     * Client requests status of all active downloads.
     */
    @SubscribeMessage('get-active-downloads')
    handleGetActive(@ConnectedSocket() client: Socket) {
        const active = this.downloadService.getAllActive();
        client.emit('active-downloads', active);
    }
}
