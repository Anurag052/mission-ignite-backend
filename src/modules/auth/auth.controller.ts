import {
    Controller,
    Post,
    Body,
    Get,
    UseGuards,
    Req,
    Res,
    HttpCode,
    HttpStatus,
    UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Response, Request } from 'express';
import { ConfigService } from '@nestjs/config';

@ApiTags('auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly config: ConfigService,
    ) { }

    @Post('register')
    @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 attempts per minute
    @ApiOperation({ summary: 'Register a new user' })
    async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
        const result = await this.authService.register(dto);
        this.setRefreshTokenCookie(res, result.refreshToken);
        return { user: result.user, accessToken: result.accessToken };
    }

    @Post('login')
    @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 attempts per minute
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Login with email and password' })
    async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
        const result = await this.authService.login(dto);
        this.setRefreshTokenCookie(res, result.refreshToken);
        return { user: result.user, accessToken: result.accessToken };
    }

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Refresh access token' })
    async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        const refreshToken = req.cookies['refresh_token'];
        if (!refreshToken) throw new UnauthorizedException('Refresh token not found');

        const result = await this.authService.refreshTokens(refreshToken);
        this.setRefreshTokenCookie(res, result.refreshToken);
        return { accessToken: result.accessToken };
    }

    @Post('logout')
    @HttpCode(HttpStatus.OK)
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Logout and invalidate refresh token' })
    async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        const refreshToken = req.cookies['refresh_token'];
        if (refreshToken) {
            await this.authService.logout(refreshToken);
        }
        res.clearCookie('refresh_token');
        return { message: 'Logged out successfully' };
    }

    @Get('me')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get current authenticated user' })
    async me(@CurrentUser() user: any) {
        const fullUser = await this.authService.validateUser(user.id);
        return fullUser;
    }

    // ── Google OAuth ─────────────────────────────────────────────────────────────

    @Get('google')
    @UseGuards(AuthGuard('google'))
    @ApiOperation({ summary: 'Initiate Google OAuth login' })
    googleAuth() {
        // Passport redirects automatically
    }

    @Get('google/callback')
    @UseGuards(AuthGuard('google'))
    @ApiOperation({ summary: 'Google OAuth callback' })
    async googleCallback(@Req() req: any, @Res() res: Response) {
        const tokens = await this.authService.handleGoogleOAuth(req.user);

        // precise cookie setting for OAuth redirect flow
        this.setRefreshTokenCookie(res, tokens.refreshToken);

        const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
        res.redirect(`${frontendUrl}/auth/callback?accessToken=${tokens.accessToken}`);
    }

    private setRefreshTokenCookie(res: Response, token: string) {
        res.cookie('refresh_token', token, {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'strict',
            path: '/api/v1/auth', // lock to auth routes
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });
    }
}
