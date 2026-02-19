import { Injectable, Logger } from '@nestjs/common';
import {
    MODEL_CATALOG,
    CatalogModel,
    ANDROID_MODEL_SIZE_LIMIT_MB,
    DEFAULT_MODELS,
} from './model-catalog';
import { DeviceProfile } from '../device-detection.service';

export interface RecommendedModel extends CatalogModel {
    /** Whether this is the top recommendation */
    recommended: boolean;
    /** Reason for recommendation or exclusion */
    reason: string;
}

@Injectable()
export class ModelCompatibilityService {
    private readonly logger = new Logger(ModelCompatibilityService.name);

    /**
     * Filter and rank models for a given device profile.
     *
     * Algorithm:
     * 1. Filter by device type compatibility
     * 2. Filter by Android model size cap (≤ 2GB for Android)
     * 3. Filter by RAM constraint (model.minRamMb ≤ deviceRAM)
     * 4. If storage info available, filter by download size ≤ free storage
     * 5. Rank by qualityScore descending (best quality that fits)
     * 6. Mark the top result as "recommended"
     */
    getRecommendedModels(profile: DeviceProfile): RecommendedModel[] {
        const { deviceType, ramMb, storageMb } = profile;

        const compatible = MODEL_CATALOG
            .filter((model) => {
                // Device type filter
                if (!model.devices.includes(deviceType as any)) return false;

                // Android hard cap
                if (deviceType === 'ANDROID' && model.sizeMb > ANDROID_MODEL_SIZE_LIMIT_MB) {
                    return false;
                }

                // RAM filter (if RAM info available)
                if (ramMb !== null && model.minRamMb > ramMb) return false;

                // Storage filter (if storage info available)
                if (storageMb !== null && model.sizeMb > storageMb) return false;

                return true;
            })
            // Sort by qualityScore descending
            .sort((a, b) => b.qualityScore - a.qualityScore);

        if (compatible.length === 0) {
            // Return fallback model
            const fallbackName = DEFAULT_MODELS[deviceType] || DEFAULT_MODELS.UNKNOWN;
            const fallback = MODEL_CATALOG.find((m) => m.name === fallbackName);
            if (fallback) {
                return [{
                    ...fallback,
                    recommended: true,
                    reason: 'Fallback: no models matched your device constraints.',
                }];
            }
            return [];
        }

        return compatible.map((model, index) => ({
            ...model,
            recommended: index === 0,
            reason: index === 0
                ? `Best quality model that fits your ${deviceType} device with ${ramMb ?? 'unknown'}MB RAM.`
                : `Compatible alternative (quality: ${model.qualityScore}/100).`,
        }));
    }

    /**
     * Get a single best model for this device profile.
     */
    getBestModel(profile: DeviceProfile): CatalogModel | null {
        const recommended = this.getRecommendedModels(profile);
        return recommended.find((m) => m.recommended) || recommended[0] || null;
    }

    /**
     * Validate whether a specific model name is compatible with a device.
     */
    isModelCompatible(modelName: string, profile: DeviceProfile): { compatible: boolean; reason: string } {
        const model = MODEL_CATALOG.find((m) => m.name === modelName);
        if (!model) {
            return { compatible: false, reason: `Model "${modelName}" not found in catalog.` };
        }

        if (!model.devices.includes(profile.deviceType as any)) {
            return { compatible: false, reason: `Model "${modelName}" is not compatible with ${profile.deviceType}.` };
        }

        if (profile.deviceType === 'ANDROID' && model.sizeMb > ANDROID_MODEL_SIZE_LIMIT_MB) {
            return { compatible: false, reason: `Model exceeds Android 2GB limit (${model.sizeMb}MB).` };
        }

        if (profile.ramMb !== null && model.minRamMb > profile.ramMb) {
            return { compatible: false, reason: `Insufficient RAM: need ${model.minRamMb}MB, device has ${profile.ramMb}MB.` };
        }

        if (profile.storageMb !== null && model.sizeMb > profile.storageMb) {
            return { compatible: false, reason: `Insufficient storage: need ${model.sizeMb}MB, device has ${profile.storageMb}MB free.` };
        }

        return { compatible: true, reason: 'Model is compatible with your device.' };
    }
}
