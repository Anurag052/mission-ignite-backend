import { Injectable, Logger } from '@nestjs/common';
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
    QcInput,
} from '../agents/all-agents';
import { OllamaClient } from '../ollama/ollama.client';
import { ConcurrencyManager } from '../concurrency/concurrency.manager';
import { AiCacheService } from '../cache/ai-cache.service';
import { AgentExecutionResult } from '../agents/base.agent';

export type AgentName =
    | 'planner'
    | 'psychologicalAnalyst'
    | 'olqScorer'
    | 'interviewOfficer'
    | 'gtoOfficer'
    | 'questionGenerator'
    | 'notebook'
    | 'pdfGenerator'
    | 'qualityControl';

/**
 * Agent Orchestrator — the central hub for routing requests to agents.
 *
 * Features:
 *  - Route by agent name
 *  - Chain agents (pipe output of one into another)
 *  - Quality-control pass (optional)
 *  - Fallback on failure
 *  - Status / health reporting
 */
@Injectable()
export class AgentOrchestrator {
    private readonly logger = new Logger(AgentOrchestrator.name);
    private readonly agentMap: Map<AgentName, any>;

    constructor(
        private readonly ollamaClient: OllamaClient,
        private readonly concurrency: ConcurrencyManager,
        private readonly cache: AiCacheService,
        // Inject all agents
        private readonly plannerAgent: PlannerAgent,
        private readonly psychAgent: PsychologicalAnalystAgent,
        private readonly olqAgent: OlqScorerAgent,
        private readonly interviewAgent: InterviewOfficerAgent,
        private readonly gtoAgent: GtoOfficerAgent,
        private readonly questionAgent: QuestionGeneratorAgent,
        private readonly notebookAgent: NotebookAgent,
        private readonly pdfAgent: PdfGeneratorAgent,
        private readonly qcAgent: QualityControlAgent,
    ) {
        this.agentMap = new Map<AgentName, any>([
            ['planner', this.plannerAgent],
            ['psychologicalAnalyst', this.psychAgent],
            ['olqScorer', this.olqAgent],
            ['interviewOfficer', this.interviewAgent],
            ['gtoOfficer', this.gtoAgent],
            ['questionGenerator', this.questionAgent],
            ['notebook', this.notebookAgent],
            ['pdfGenerator', this.pdfAgent],
            ['qualityControl', this.qcAgent],
        ]);
    }

    // ── Route a single request to an agent ────────────────────────────────────────

    async runAgent<T = any>(
        agentName: AgentName,
        input: Record<string, string>,
        enableQC = false,
    ): Promise<AgentExecutionResult<T>> {
        const agent = this.agentMap.get(agentName);
        if (!agent) {
            return {
                success: false,
                agentName,
                taskId: 'none',
                data: null,
                rawResponse: '',
                durationMs: 0,
                fromCache: false,
                retries: 0,
                error: `Unknown agent: ${agentName}`,
            };
        }

        if (!this.ollamaClient.getIsHealthy()) {
            return {
                success: false,
                agentName,
                taskId: 'none',
                data: null,
                rawResponse: '',
                durationMs: 0,
                fromCache: false,
                retries: 0,
                error: 'Ollama is not available. Start Ollama and try again.',
            };
        }

        this.logger.log(`Routing to agent: ${agentName}`);
        const result = await agent.execute(input);

        // Optional QC pass
        if (enableQC && result.success && agentName !== 'qualityControl') {
            return this.withQualityControl(result);
        }

        return result;
    }

    // ── Chain agents ──────────────────────────────────────────────────────────────

    async chainAgents(
        steps: Array<{
            agentName: AgentName;
            inputTransformer: (prevOutput: any) => Record<string, string>;
        }>,
        initialInput: Record<string, string>,
        enableQC = false,
    ): Promise<AgentExecutionResult[]> {
        const results: AgentExecutionResult[] = [];
        let currentOutput: any = null;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const input = i === 0
                ? initialInput
                : step.inputTransformer(currentOutput);

            this.logger.log(`Chain step ${i + 1}/${steps.length}: ${step.agentName}`);
            const result = await this.runAgent(step.agentName, input, enableQC);
            results.push(result);

            if (!result.success) {
                this.logger.warn(`Chain broken at step ${i + 1} (${step.agentName})`);
                break;
            }

            currentOutput = result.data;
        }

        return results;
    }

    // ── Parallel execution ────────────────────────────────────────────────────────

    async runParallel(
        tasks: Array<{ agentName: AgentName; input: Record<string, string> }>,
    ): Promise<AgentExecutionResult[]> {
        this.logger.log(`Running ${tasks.length} agents in parallel`);
        return Promise.all(
            tasks.map((t) => this.runAgent(t.agentName, t.input)),
        );
    }

    // ── Quality control pass ──────────────────────────────────────────────────────

    private async withQualityControl<T>(
        originalResult: AgentExecutionResult<T>,
    ): Promise<AgentExecutionResult<T>> {
        this.logger.log(`QC pass on: ${originalResult.agentName}`);

        const qcInput: QcInput = {
            sourceAgent: originalResult.agentName,
            agentOutput: JSON.stringify(originalResult.data),
            expectedSchema: 'See prompt template for expected fields',
        };

        const qcResult = await this.qcAgent.execute(qcInput);

        if (qcResult.success && qcResult.data) {
            const qcData = qcResult.data;
            if (qcData.qualityScore < 5) {
                this.logger.warn(
                    `QC flagged low quality (${qcData.qualityScore}/10) for ${originalResult.agentName}`,
                );
                // Use corrected output if available
                if (qcData.correctedOutput) {
                    return {
                        ...originalResult,
                        data: qcData.correctedOutput as T,
                    };
                }
            }
        }

        return originalResult;
    }

    // ── Status ────────────────────────────────────────────────────────────────────

    getStatus() {
        return {
            ollamaHealthy: this.ollamaClient.getIsHealthy(),
            activeModel: this.ollamaClient.getActiveModel(),
            concurrency: this.concurrency.getStatus(),
            availableAgents: Array.from(this.agentMap.keys()),
        };
    }
}
