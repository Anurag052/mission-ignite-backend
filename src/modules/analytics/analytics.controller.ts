import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { MenuType } from '@prisma/client';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
    constructor(private readonly analyticsService: AnalyticsService) { }

    @Get('dashboard')
    @ApiOperation({ summary: 'Get analytics dashboard summary' })
    getDashboard(@CurrentUser() user: any) {
        return this.analyticsService.getDashboard(user.id);
    }

    @Get('trend')
    @ApiOperation({ summary: 'Get performance trend over N days' })
    @ApiQuery({ name: 'menuType', enum: MenuType })
    @ApiQuery({ name: 'days', required: false, type: Number })
    getTrend(
        @CurrentUser() user: any,
        @Query('menuType') menuType: MenuType,
        @Query('days') days = 30,
    ) {
        return this.analyticsService.getPerformanceTrend(user.id, menuType, +days);
    }

    @Get('weak-areas')
    @ApiOperation({ summary: 'Get weak subject areas' })
    @ApiQuery({ name: 'menuType', enum: MenuType })
    getWeakAreas(@CurrentUser() user: any, @Query('menuType') menuType: MenuType) {
        return this.analyticsService.getWeakAreas(user.id, menuType);
    }

    @Get('weekly')
    @ApiOperation({ summary: 'Get weekly analytics report (last 12 weeks)' })
    getWeekly(@CurrentUser() user: any) {
        return this.analyticsService.getWeeklyReport(user.id);
    }

    @Get('vision')
    @ApiOperation({ summary: 'Get vision/OCR metrics' })
    getVision(@CurrentUser() user: any) {
        return this.analyticsService.getVisionMetrics(user.id);
    }

    @Get('voice')
    @ApiOperation({ summary: 'Get voice/STT metrics' })
    getVoice(@CurrentUser() user: any) {
        return this.analyticsService.getVoiceMetrics(user.id);
    }
}
