import { Module } from '@nestjs/common';
import { GtoGateway } from './gto.gateway';
import { GtoService } from './gto.service';
import { GtoController } from './gto.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [AuthModule],
    providers: [GtoGateway, GtoService],
    controllers: [GtoController],
})
export class GtoModule { }
