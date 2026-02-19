import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';

export interface DeviceProfile {
    deviceType: 'ANDROID' | 'DESKTOP' | 'TABLET' | 'UNKNOWN';
    ramMb: number | null;
    storageMb: number | null;
    userAgent: string;
    isLocalOllamaCapable: boolean;
}

@Injectable()
export class DeviceDetectionService {
    private readonly logger = new Logger(DeviceDetectionService.name);

    /**
     * Detect device type and hardware from request headers.
     *
     * Expected custom headers (set by frontend / mobile app):
     *   X-Device-Type: ANDROID | DESKTOP | TABLET
     *   X-Device-RAM: <megabytes as integer>
     *   X-Device-Storage: <free storage in MB>
     *
     * Falls back to User-Agent parsing if custom headers are absent.
     */
    detect(req: Request): DeviceProfile {
        const userAgent = req.headers['user-agent'] || '';
        const headerType = (req.headers['x-device-type'] as string || '').toUpperCase();
        const headerRam = parseInt(req.headers['x-device-ram'] as string, 10) || null;
        const headerStorage = parseInt(req.headers['x-device-storage'] as string, 10) || null;

        let deviceType: DeviceProfile['deviceType'] = 'UNKNOWN';

        // Priority 1: Explicit header
        if (['ANDROID', 'DESKTOP', 'TABLET'].includes(headerType)) {
            deviceType = headerType as DeviceProfile['deviceType'];
        }
        // Priority 2: User-Agent parsing
        else {
            deviceType = this.parseUserAgent(userAgent);
        }

        // Android devices with < 3GB RAM cannot run Ollama locally
        const isLocalOllamaCapable = this.checkLocalCapability(deviceType, headerRam);

        const profile: DeviceProfile = {
            deviceType,
            ramMb: headerRam,
            storageMb: headerStorage,
            userAgent,
            isLocalOllamaCapable,
        };

        this.logger.debug(
            `Device detected: type=${profile.deviceType}, RAM=${profile.ramMb}MB, ` +
            `storage=${profile.storageMb}MB, localCapable=${profile.isLocalOllamaCapable}`,
        );

        return profile;
    }

    private parseUserAgent(ua: string): DeviceProfile['deviceType'] {
        const lower = ua.toLowerCase();

        // Android detection
        if (lower.includes('android')) {
            // Tablets often have "android" but NOT "mobile"
            if (!lower.includes('mobile')) return 'TABLET';
            return 'ANDROID';
        }

        // iPad / tablet detection
        if (lower.includes('ipad') || lower.includes('tablet')) {
            return 'TABLET';
        }

        // Desktop browsers
        if (
            lower.includes('windows') ||
            lower.includes('macintosh') ||
            lower.includes('linux') && !lower.includes('android')
        ) {
            return 'DESKTOP';
        }

        return 'UNKNOWN';
    }

    private checkLocalCapability(
        deviceType: DeviceProfile['deviceType'],
        ramMb: number | null,
    ): boolean {
        // Android < 3GB RAM cannot run Ollama
        if (deviceType === 'ANDROID') {
            return ramMb !== null && ramMb >= 3072;
        }
        // Tablets need at least 3GB
        if (deviceType === 'TABLET') {
            return ramMb !== null && ramMb >= 3072;
        }
        // Desktops with 4GB+ can run Ollama locally
        if (deviceType === 'DESKTOP') {
            return ramMb === null || ramMb >= 4096;
        }
        return false;
    }
}
