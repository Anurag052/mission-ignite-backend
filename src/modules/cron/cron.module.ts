import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PdfModule } from '../pdf/pdf.module';

@Module({
    imports: [PdfModule],
    providers: [CronService],
})
export class CronModule { }
