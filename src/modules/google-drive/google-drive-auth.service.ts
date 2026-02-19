import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { google, Auth } from 'googleapis';

@Injectable()
export class GoogleDriveAuthService {
    private readonly logger = new Logger(GoogleDriveAuthService.name);
    private readonly oauth2Client: Auth.OAuth2Client;
    private readonly SCOPES = [
        'https://www.googleapis.com/auth/drive.file', // Only files created by this app
    ];

    constructor(
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
    ) {
        this.oauth2Client = new google.auth.OAuth2(
            this.config.get<string>('GOOGLE_DRIVE_CLIENT_ID'),
            this.config.get<string>('GOOGLE_DRIVE_CLIENT_SECRET'),
            this.config.get<string>('GOOGLE_DRIVE_REDIRECT_URI'),
        );
    }

    /**
     * Generate the Google OAuth2 authorization URL.
     * Uses `drive.file` scope (restricted to app-created files only).
     */
    getAuthorizationUrl(userId: string): string {
        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: this.SCOPES,
            prompt: 'consent', // Always get refresh token
            state: userId, // Pass userId through OAuth state for callback
        });
    }

    /**
     * Exchange authorization code for tokens and store in DB.
     */
    async handleCallback(code: string, userId: string): Promise<void> {
        const { tokens } = await this.oauth2Client.getToken(code);

        if (!tokens.access_token || !tokens.refresh_token) {
            throw new UnauthorizedException(
                'Failed to obtain tokens from Google. Please reconnect your Drive.',
            );
        }

        await this.prisma.googleDriveToken.upsert({
            where: { userId },
            update: {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresAt: tokens.expiry_date
                    ? new Date(tokens.expiry_date)
                    : new Date(Date.now() + 3600 * 1000),
                scope: tokens.scope || this.SCOPES.join(' '),
            },
            create: {
                userId,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresAt: tokens.expiry_date
                    ? new Date(tokens.expiry_date)
                    : new Date(Date.now() + 3600 * 1000),
                scope: tokens.scope || this.SCOPES.join(' '),
            },
        });

        this.logger.log(`✅ Google Drive connected for user: ${userId}`);
    }

    /**
     * Get authenticated OAuth2 client for a user.
     * Automatically refreshes expired tokens.
     */
    async getAuthenticatedClient(userId: string): Promise<Auth.OAuth2Client> {
        const stored = await this.prisma.googleDriveToken.findUnique({
            where: { userId },
        });

        if (!stored) {
            throw new UnauthorizedException(
                'Google Drive not connected. Please connect your Drive first.',
            );
        }

        const client = new google.auth.OAuth2(
            this.config.get<string>('GOOGLE_DRIVE_CLIENT_ID'),
            this.config.get<string>('GOOGLE_DRIVE_CLIENT_SECRET'),
            this.config.get<string>('GOOGLE_DRIVE_REDIRECT_URI'),
        );

        client.setCredentials({
            access_token: stored.accessToken,
            refresh_token: stored.refreshToken,
            expiry_date: stored.expiresAt.getTime(),
        });

        // Auto-refresh if expired
        if (stored.expiresAt <= new Date()) {
            this.logger.debug(`Refreshing expired Drive token for user: ${userId}`);
            const { credentials } = await client.refreshAccessToken();

            await this.prisma.googleDriveToken.update({
                where: { userId },
                data: {
                    accessToken: credentials.access_token!,
                    expiresAt: credentials.expiry_date
                        ? new Date(credentials.expiry_date)
                        : new Date(Date.now() + 3600 * 1000),
                },
            });

            client.setCredentials(credentials);
        }

        return client;
    }

    /**
     * Check if a user has connected their Google Drive.
     */
    async isConnected(userId: string): Promise<boolean> {
        const token = await this.prisma.googleDriveToken.findUnique({
            where: { userId },
        });
        return !!token;
    }

    /**
     * Disconnect a user's Google Drive (revoke + remove tokens).
     */
    async disconnect(userId: string): Promise<void> {
        const stored = await this.prisma.googleDriveToken.findUnique({
            where: { userId },
        });

        if (stored) {
            // Best-effort revoke
            try {
                await this.oauth2Client.revokeToken(stored.accessToken);
            } catch {
                this.logger.warn(`Token revocation failed for user ${userId} (non-blocking)`);
            }

            await this.prisma.googleDriveToken.delete({
                where: { userId },
            });
        }

        this.logger.log(`🔌 Google Drive disconnected for user: ${userId}`);
    }
}
