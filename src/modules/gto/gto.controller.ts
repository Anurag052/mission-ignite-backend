import { Controller, Get, Param, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { GtoService } from './gto.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('gto')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('gto')
export class GtoController {
    constructor(private readonly gtoService: GtoService) { }

    @Get('sessions')
    @ApiOperation({ summary: 'Get user GTO sessions (paginated)' })
    getSessions(
        @CurrentUser() user: any,
        @Query('page') page = 1,
        @Query('limit') limit = 20,
    ) {
        return this.gtoService.getUserSessions(user.id, +page, +limit);
    }

    @Get('sessions/:id')
    @ApiOperation({ summary: 'Get a specific GTO session' })
    getSession(@Param('id') id: string, @CurrentUser() user: any) {
        return this.gtoService.getSession(id, user.id);
    }

    @Get('stats')
    @ApiOperation({ summary: 'Get GTO performance stats for current user' })
    getStats(@CurrentUser() user: any) {
        return this.gtoService.getSessionStats(user.id);
    }
}
