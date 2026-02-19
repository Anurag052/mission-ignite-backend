import { Module } from '@nestjs/common';
import { OllamaClient } from './ollama/ollama.client';
import { ConcurrencyManager } from './concurrency/concurrency.manager';
import { AiCacheService } from './cache/ai-cache.service';
import {
    PlannerAgent,
    PsychologicalAnalystAgent,
    OlqScorerAgent,
    InterviewOfficerAgent,
    GtoOfficerAgent,
    QuestionGeneratorAgent,
    NotebookAgent,
    PdfGeneratorAgent,
    QualityControlAgent,
} from './agents/all-agents';
import { AgentOrchestrator } from './orchestrator/agent.orchestrator';
import { AiEngineController } from './ai-engine.controller';

@Module({
    providers: [
        // Infrastructure
        OllamaClient,
        ConcurrencyManager,
        AiCacheService,

        // Agents
        PlannerAgent,
        PsychologicalAnalystAgent,
        OlqScorerAgent,
        InterviewOfficerAgent,
        GtoOfficerAgent,
        QuestionGeneratorAgent,
        NotebookAgent,
        PdfGeneratorAgent,
        QualityControlAgent,

        // Orchestrator
        AgentOrchestrator,
    ],
    controllers: [AiEngineController],
    exports: [AgentOrchestrator, OllamaClient],
})
export class AiEngineModule { }
