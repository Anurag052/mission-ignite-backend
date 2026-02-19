import {
    Injectable,
    UnauthorizedException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { addDays } from 'date-fns';
import { Role } from '@prisma/client';

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly config: ConfigService,
    ) { }

    async register(dto: RegisterDto) {
        const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
        if (existing) throw new ConflictException('Email already registered');

        const passwordHash = await bcrypt.hash(dto.password, 12);
        const user = await this.prisma.user.create({
            data: { email: dto.email, name: dto.name, passwordHash },
            select: { id: true, email: true, name: true, role: true, createdAt: true },
        });

        const tokens = await this.generateTokens(user.id, user.email, user.role);
        return { user, ...tokens };
    }

    async login(dto: LoginDto) {
        const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
        if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials');
        if (!user.isActive) throw new UnauthorizedException('Account is deactivated');

        const valid = await bcrypt.compare(dto.password, user.passwordHash);
        if (!valid) throw new UnauthorizedException('Invalid credentials');

        await this.prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
        });

        const tokens = await this.generateTokens(user.id, user.email, user.role);
        return {
            user: { id: user.id, email: user.email, name: user.name, role: user.role },
            ...tokens,
        };
    }

    async refreshTokens(refreshToken: string) {
        const stored = await this.prisma.refreshToken.findUnique({ where: { token: refreshToken } });
        if (!stored || stored.expiresAt < new Date()) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }

        const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
        if (!user || !user.isActive) throw new UnauthorizedException('User not found or inactive');

        // Rotate refresh token
        await this.prisma.refreshToken.delete({ where: { token: refreshToken } });
        const tokens = await this.generateTokens(user.id, user.email, user.role);
        return tokens;
    }

    async logout(refreshToken: string) {
        await this.prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
        return { message: 'Logged out successfully' };
    }

    async handleGoogleOAuth(googleUser: {
        googleId: string;
        email: string;
        name: string;
        avatarUrl?: string;
    }) {
        let user = await this.prisma.user.findFirst({
            where: { OR: [{ googleId: googleUser.googleId }, { email: googleUser.email }] },
        });

        if (!user) {
            user = await this.prisma.user.create({
                data: {
                    googleId: googleUser.googleId,
                    email: googleUser.email,
                    name: googleUser.name,
                    avatarUrl: googleUser.avatarUrl,
                    isEmailVerified: true,
                },
            });
        } else if (!user.googleId) {
            user = await this.prisma.user.update({
                where: { id: user.id },
                data: { googleId: googleUser.googleId, isEmailVerified: true },
            });
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
        });

        return this.generateTokens(user.id, user.email, user.role);
    }

    async validateUser(userId: string) {
        return this.prisma.user.findUnique({
            where: { id: userId, isActive: true },
            select: { id: true, email: true, name: true, role: true, isActive: true },
        });
    }

    private async generateTokens(userId: string, email: string, role: Role) {
        const payload = { sub: userId, email, role };

        const accessToken = this.jwtService.sign(payload, {
            secret: this.config.get<string>('JWT_SECRET'),
            expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '15m'),
        });

        const rawRefresh = uuidv4();
        const expiresAt = addDays(new Date(), 7);

        await this.prisma.refreshToken.create({
            data: { token: rawRefresh, userId, expiresAt },
        });

        return { accessToken, refreshToken: rawRefresh };
    }
}
