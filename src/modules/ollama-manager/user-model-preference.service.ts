import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DeviceType } from '@prisma/client';

export interface SetPreferenceInput {
    userId: string;
    deviceType: DeviceType;
    deviceRamMb?: number;
    selectedModel: string;
    modelSizeMb: number;
    ollamaMode: 'server' | 'local';
    ollamaUrl?: string;
}

@Injectable()
export class UserModelPreferenceService {
    private readonly logger = new Logger(UserModelPreferenceService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Upsert user model preference (one per user per device type).
     */
    async setPreference(input: SetPreferenceInput) {
        const preference = await this.prisma.userModelPreference.upsert({
            where: {
                userId_deviceType: {
                    userId: input.userId,
                    deviceType: input.deviceType,
                },
            },
            update: {
                selectedModel: input.selectedModel,
                modelSizeMb: input.modelSizeMb,
                ollamaMode: input.ollamaMode,
                ollamaUrl: input.ollamaUrl || null,
                deviceRamMb: input.deviceRamMb || null,
                isActive: true,
            },
            create: {
                userId: input.userId,
                deviceType: input.deviceType,
                deviceRamMb: input.deviceRamMb || null,
                selectedModel: input.selectedModel,
                modelSizeMb: input.modelSizeMb,
                ollamaMode: input.ollamaMode,
                ollamaUrl: input.ollamaUrl || null,
            },
        });

        this.logger.log(
            `Model preference set: user=${input.userId}, ` +
            `device=${input.deviceType}, model=${input.selectedModel}, ` +
            `mode=${input.ollamaMode}`,
        );

        return preference;
    }

    /**
     * Get user's active preference for a device type.
     */
    async getPreference(userId: string, deviceType: DeviceType) {
        return this.prisma.userModelPreference.findUnique({
            where: {
                userId_deviceType: {
                    userId,
                    deviceType,
                },
            },
        });
    }

    /**
     * Get all preferences for a user (across devices).
     */
    async getAllPreferences(userId: string) {
        return this.prisma.userModelPreference.findMany({
            where: { userId, isActive: true },
            orderBy: { updatedAt: 'desc' },
        });
    }

    /**
     * Deactivate a preference (e.g. when switching modes).
     */
    async deactivatePreference(userId: string, deviceType: DeviceType) {
        const existing = await this.prisma.userModelPreference.findUnique({
            where: {
                userId_deviceType: { userId, deviceType },
            },
        });

        if (!existing) {
            throw new NotFoundException(
                `No preference found for device type ${deviceType}`,
            );
        }

        return this.prisma.userModelPreference.update({
            where: { id: existing.id },
            data: { isActive: false },
        });
    }

    /**
     * Get the Ollama base URL for a user request.
     * Returns the user's custom local URL or the server default.
     */
    async resolveOllamaUrl(userId: string, deviceType: DeviceType, serverDefault: string): Promise<string> {
        const pref = await this.getPreference(userId, deviceType);
        if (pref && pref.ollamaMode === 'local' && pref.ollamaUrl) {
            return pref.ollamaUrl;
        }
        return serverDefault;
    }
}
