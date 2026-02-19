import {
    Controller,
    Post,
    Get,
    Body,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsArray, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AgentOrchestrator, AgentName } from './orchestrator/agent.orchestrator';
import { OllamaClient } from './ollama/ollama.client';
import { ConcurrencyManager } from './concurrency/concurrency.manager';

// ── DTOs ────────────────────────────────────────────────────────────────────────

const AGENT_NAMES = [
    'planner', 'psychologicalAnalyst', 'olqScorer', 'interviewOfficer',
    'gtoOfficer', 'questionGenerator', 'notebook', 'pdfGenerator', 'qualityControl',
] as const;

class RunAgentDto {
    @ApiProperty({ enum: AGENT_NAMES })
    @IsIn(AGENT_NAMES)
    agentName: AgentName;

    @ApiProperty({ type: 'object', example: { studentName: 'John', menuType: 'SSB' } })
    input: Record<string, string>;

    @ApiProperty({ required: false, default: false })
    @IsOptional()
    @IsBoolean()
    enableQC?: boolean;
}

class ChainStep {
    @ApiProperty({ enum: AGENT_NAMES })
    @IsIn(AGENT_NAMES)
    agentName: AgentName;
}

class ChainAgentsDto {
    @ApiProperty({ type: [ChainStep] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ChainStep)
    steps: ChainStep[];

    @ApiProperty({ type: 'object' })
    initialInput: Record<string, string>;
}

class ParallelDto {
    @ApiProperty({
        type: 'array',
        items: { type: 'object', properties: { agentName: { type: 'string' }, input: { type: 'object' } } },
    })
    @IsArray()
    tasks: Array<{ agentName: AgentName; input: Record<string, string> }>;
}

// ── Controller ──────────────────────────────────────────────────────────────────

@ApiTags('ai-engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiEngineController {
    constructor(
        private readonly orchestrator: AgentOrchestrator,
        private readonly ollamaClient: OllamaClient,
        private readonly concurrency: ConcurrencyManager,
    ) { }

    @Post('run')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Run a single AI agent' })
    async runAgent(@Body() dto: RunAgentDto, @CurrentUser() user: any) {
        return this.orchestrator.runAgent(dto.agentName, dto.input, dto.enableQC);
    }

    @Post('chain')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Chain multiple agents sequentially (output → input pipeline)' })
    async chainAgents(@Body() dto: ChainAgentsDto) {
        const steps = dto.steps.map((s) => ({
            agentName: s.agentName,
            inputTransformer: (prevOutput: any) => {
                // Default: pass entire JSON-stringified output as "data" key
                return { data: JSON.stringify(prevOutput) };
            },
        }));
        return this.orchestrator.chainAgents(steps, dto.initialInput);
    }

    @Post('parallel')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Run multiple agents in parallel' })
    async runParallel(@Body() dto: ParallelDto) {
        return this.orchestrator.runParallel(dto.tasks);
    }

    @Get('status')
    @ApiOperation({ summary: 'Get AI engine status (Ollama health, active model, concurrency)' })
    getStatus() {
        return this.orchestrator.getStatus();
    }

    @Get('models')
    @ApiOperation({ summary: 'List locally available Ollama models' })
    async listModels() {
        return this.ollamaClient.listLocalModels();
    }

    @Post('models/pull')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Pull/download a model from Ollama' })
    async pullModel(@Body() body: { modelName: string }) {
        const success = await this.ollamaClient.pullModel(body.modelName);
        return { success, model: body.modelName };
    }

    @Post('health-check')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Re-check Ollama connectivity and refresh model detection' })
    async healthCheck() {
        const healthy = await this.ollamaClient.healthCheck();
        let model: string | null = null;
        if (healthy) {
            model = await this.ollamaClient.detectOrDownloadModel();
        }
        return { healthy, activeModel: model };
    }
}
