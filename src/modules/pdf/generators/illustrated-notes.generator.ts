import { Injectable, Logger } from '@nestjs/common';

/**
 * Mode 2: Standard Illustrated Mode — Bullet Notes + SVG Diagrams
 *
 * Generates:
 *   - Concise bullet-point notes
 *   - Auto-generated SVG diagrams (flowcharts, cycles, hierarchies)
 *   - Mind maps (SVG-based)
 *   - Comparison tables
 *   - 20 MCQs
 *   - 10 Analytical CAPF AC questions
 *
 * All visuals are inline SVG — no external image dependencies.
 */

// ── Types ────────────────────────────────────────────────────────────────────────

export interface IllustratedRequest {
    topic: string;
    subject: string;
    subtopics?: string[];
    diagramStyle: 'MINIMAL' | 'COLORFUL' | 'PROFESSIONAL';
}

export interface BulletSection {
    heading: string;
    bullets: string[];
    subBullets?: Record<string, string[]>;  // nested bullets under a parent
    highlight?: string;                      // box-highlight text
}

export interface SvgDiagram {
    id: string;
    type: 'FLOWCHART' | 'CYCLE' | 'HIERARCHY' | 'PROCESS' | 'COMPARISON' | 'TIMELINE';
    title: string;
    svgContent: string;   // inline SVG markup
    caption: string;
    width: number;
    height: number;
}

export interface MindMapNode {
    label: string;
    children: MindMapNode[];
    color?: string;
}

export interface MindMap {
    title: string;
    rootNode: MindMapNode;
    svgContent: string;
    width: number;
    height: number;
}

export interface ComparisonTable {
    title: string;
    headers: string[];
    rows: string[][];
    footnote?: string;
}

export interface AnalyticalQuestion {
    id: number;
    passage: string;         // context paragraph
    question: string;
    expectedApproach: string;
    markingScheme: string;
    assessedSkills: string[];
}

export interface IllustratedMCQ {
    id: number;
    question: string;
    options: { a: string; b: string; c: string; d: string };
    correctAnswer: 'a' | 'b' | 'c' | 'd';
    explanation: string;
}

export interface IllustratedOutput {
    mode: 'ILLUSTRATED';
    metadata: {
        topic: string;
        subject: string;
        generatedAt: string;
        diagramCount: number;
        tableCount: number;
    };
    bulletSections: BulletSection[];
    diagrams: SvgDiagram[];
    mindMap: MindMap;
    tables: ComparisonTable[];
    mcqs: IllustratedMCQ[];
    analyticalQuestions: AnalyticalQuestion[];
}

// ── Color Palettes ──────────────────────────────────────────────────────────────

const PALETTES = {
    MINIMAL: {
        primary: '#1a1a2e', accent: '#16213e', bg: '#f0f0f0',
        node: '#e2e2e2', text: '#1a1a2e', border: '#555',
        colors: ['#6c757d', '#adb5bd', '#868e96', '#495057'],
    },
    COLORFUL: {
        primary: '#6C63FF', accent: '#FF6584', bg: '#FFF9EC',
        node: '#E8F4FD', text: '#2d3436', border: '#6C63FF',
        colors: ['#6C63FF', '#FF6584', '#00B894', '#FDCB6E', '#E17055', '#74B9FF'],
    },
    PROFESSIONAL: {
        primary: '#2C3E50', accent: '#E74C3C', bg: '#ECF0F1',
        node: '#D5E8D4', text: '#2C3E50', border: '#34495E',
        colors: ['#2980B9', '#27AE60', '#F39C12', '#8E44AD', '#E74C3C', '#1ABC9C'],
    },
};

@Injectable()
export class IllustratedNotesGenerator {
    private readonly logger = new Logger(IllustratedNotesGenerator.name);

    async generate(request: IllustratedRequest): Promise<IllustratedOutput> {
        this.logger.log(`Generating Illustrated Notes: ${request.topic} (${request.subject})`);

        const palette = PALETTES[request.diagramStyle] || PALETTES.PROFESSIONAL;
        const subtopics = request.subtopics || this.inferSubtopics(request.topic, request.subject);

        const [bulletSections, diagrams, mindMap, tables, mcqs, analytical] = await Promise.all([
            this.generateBulletSections(request.topic, subtopics),
            this.generateDiagrams(request.topic, subtopics, palette),
            this.generateMindMap(request.topic, subtopics, palette),
            this.generateTables(request.topic, subtopics),
            this.generateMCQs(request.topic, request.subject),
            this.generateAnalyticalQuestions(request.topic, request.subject),
        ]);

        return {
            mode: 'ILLUSTRATED',
            metadata: {
                topic: request.topic,
                subject: request.subject,
                generatedAt: new Date().toISOString(),
                diagramCount: diagrams.length,
                tableCount: tables.length,
            },
            bulletSections,
            diagrams,
            mindMap,
            tables,
            mcqs,
            analyticalQuestions: analytical,
        };
    }

    // ── Bullet Sections ───────────────────────────────────────────────────────────

    private async generateBulletSections(topic: string, subtopics: string[]): Promise<BulletSection[]> {
        const sections: BulletSection[] = [
            {
                heading: `Overview — ${topic}`,
                bullets: [
                    `Definition and fundamental concept of ${topic}`,
                    `Historical background and evolution`,
                    `Significance in contemporary context`,
                    `Relevance to Indian polity, governance, and defence`,
                ],
                highlight: `Key Fact: ${topic} is a critical subject for CAPF AC, SSB, and OTA examinations.`,
            },
        ];

        for (const sub of subtopics) {
            sections.push({
                heading: sub,
                bullets: [
                    `Core principle: Foundational understanding of ${sub}`,
                    `Key features and characteristics`,
                    `Applications and real-world examples`,
                    `Important dates, data, and statistics`,
                    `Connection to other topics and current affairs`,
                ],
                subBullets: {
                    'Key features and characteristics': [
                        `Feature 1 — Primary characteristic of ${sub}`,
                        `Feature 2 — Secondary attribute`,
                        `Feature 3 — Distinguishing factor`,
                    ],
                },
            });
        }

        return sections;
    }

    // ── SVG Diagram Generation ────────────────────────────────────────────────────

    private async generateDiagrams(topic: string, subtopics: string[], palette: any): Promise<SvgDiagram[]> {
        const diagrams: SvgDiagram[] = [];

        // 1. Flowchart
        diagrams.push(this.generateFlowchart(topic, subtopics, palette));

        // 2. Cycle diagram
        if (subtopics.length >= 3) {
            diagrams.push(this.generateCycleDiagram(topic, subtopics.slice(0, 5), palette));
        }

        // 3. Hierarchy
        diagrams.push(this.generateHierarchy(topic, subtopics, palette));

        // 4. Timeline
        diagrams.push(this.generateTimeline(topic, palette));

        return diagrams;
    }

    private generateFlowchart(topic: string, steps: string[], palette: any): SvgDiagram {
        const w = 600, nodeH = 40, gap = 20, pad = 30;
        const nodeW = 260;
        const totalH = (nodeH + gap) * steps.length + pad * 2 + 60;

        let nodes = '';
        let arrows = '';

        for (let i = 0; i < steps.length; i++) {
            const x = (w - nodeW) / 2;
            const y = pad + 40 + i * (nodeH + gap);
            const color = palette.colors[i % palette.colors.length];
            const isFirst = i === 0;
            const isLast = i === steps.length - 1;

            const rx = isFirst || isLast ? nodeH / 2 : 4;

            nodes += `<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="${rx}" fill="${color}" opacity="0.9"/>`;
            nodes += `<text x="${w / 2}" y="${y + nodeH / 2 + 5}" text-anchor="middle" fill="white" font-size="12" font-family="Inter, sans-serif">${this.truncate(steps[i], 35)}</text>`;

            if (i < steps.length - 1) {
                const arrowY = y + nodeH;
                const nextY = y + nodeH + gap;
                arrows += `<line x1="${w / 2}" y1="${arrowY}" x2="${w / 2}" y2="${nextY}" stroke="${palette.border}" stroke-width="2" marker-end="url(#arrow)"/>`;
            }
        }

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${totalH}" width="${w}" height="${totalH}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${palette.border}"/>
    </marker>
  </defs>
  <rect width="100%" height="100%" fill="${palette.bg}" rx="8"/>
  <text x="${w / 2}" y="28" text-anchor="middle" fill="${palette.primary}" font-size="16" font-weight="bold" font-family="Inter, sans-serif">${this.truncate(topic, 50)} — Process Flow</text>
  ${nodes}${arrows}
</svg>`;

        return {
            id: 'flowchart-1',
            type: 'FLOWCHART',
            title: `${topic} — Process Flow`,
            svgContent: svg,
            caption: `Flowchart showing the key stages of ${topic}`,
            width: w,
            height: totalH,
        };
    }

    private generateCycleDiagram(topic: string, items: string[], palette: any): SvgDiagram {
        const w = 500, h = 500;
        const cx = w / 2, cy = h / 2, r = 160;
        const n = items.length;

        let nodes = '';
        let arrows = '';

        for (let i = 0; i < n; i++) {
            const angle = (2 * Math.PI * i) / n - Math.PI / 2;
            const x = cx + r * Math.cos(angle);
            const y = cy + r * Math.sin(angle);
            const color = palette.colors[i % palette.colors.length];

            nodes += `<circle cx="${x}" cy="${y}" r="40" fill="${color}" opacity="0.85"/>`;
            nodes += `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="white" font-size="10" font-family="Inter, sans-serif">${this.truncate(items[i], 18)}</text>`;

            // Arrow to next
            const nextAngle = (2 * Math.PI * ((i + 1) % n)) / n - Math.PI / 2;
            const midAngle = (angle + nextAngle) / 2 + (nextAngle < angle ? Math.PI : 0);
            const arcR = r * 0.85;
            const ax1 = cx + arcR * Math.cos(angle + 0.3);
            const ay1 = cy + arcR * Math.sin(angle + 0.3);
            const ax2 = cx + arcR * Math.cos(nextAngle - 0.3);
            const ay2 = cy + arcR * Math.sin(nextAngle - 0.3);
            arrows += `<line x1="${ax1}" y1="${ay1}" x2="${ax2}" y2="${ay2}" stroke="${palette.border}" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.5"/>`;
        }

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="${palette.bg}" rx="8"/>
  <text x="${cx}" y="28" text-anchor="middle" fill="${palette.primary}" font-size="16" font-weight="bold" font-family="Inter, sans-serif">${this.truncate(topic, 40)} — Cycle</text>
  ${arrows}${nodes}
  <circle cx="${cx}" cy="${cy}" r="45" fill="${palette.primary}" opacity="0.9"/>
  <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="white" font-size="11" font-weight="bold" font-family="Inter, sans-serif">${this.truncate(topic, 14)}</text>
</svg>`;

        return {
            id: 'cycle-1',
            type: 'CYCLE',
            title: `${topic} — Cycle Diagram`,
            svgContent: svg,
            caption: `Cyclical relationship between key aspects of ${topic}`,
            width: w,
            height: h,
        };
    }

    private generateHierarchy(topic: string, items: string[], palette: any): SvgDiagram {
        const w = 700, h = 350;
        const rootX = w / 2, rootY = 60;
        const level2Y = 170, level2Gap = w / (items.length + 1);

        let nodes = '';
        let lines = '';

        // Root
        nodes += `<rect x="${rootX - 80}" y="${rootY - 18}" width="160" height="36" rx="18" fill="${palette.primary}"/>`;
        nodes += `<text x="${rootX}" y="${rootY + 5}" text-anchor="middle" fill="white" font-size="13" font-weight="bold" font-family="Inter, sans-serif">${this.truncate(topic, 22)}</text>`;

        // Level 2 nodes
        for (let i = 0; i < items.length; i++) {
            const x = level2Gap * (i + 1);
            const color = palette.colors[i % palette.colors.length];

            lines += `<line x1="${rootX}" y1="${rootY + 18}" x2="${x}" y2="${level2Y - 15}" stroke="${palette.border}" stroke-width="1.5" opacity="0.6"/>`;
            nodes += `<rect x="${x - 65}" y="${level2Y - 15}" width="130" height="30" rx="6" fill="${color}" opacity="0.85"/>`;
            nodes += `<text x="${x}" y="${level2Y + 4}" text-anchor="middle" fill="white" font-size="10" font-family="Inter, sans-serif">${this.truncate(items[i], 20)}</text>`;

            // Sub-nodes
            for (let j = 0; j < 2; j++) {
                const subY = level2Y + 70 + j * 40;
                const subX = x + (j === 0 ? -35 : 35);
                lines += `<line x1="${x}" y1="${level2Y + 15}" x2="${subX}" y2="${subY - 10}" stroke="${palette.border}" stroke-width="1" opacity="0.4"/>`;
                nodes += `<rect x="${subX - 40}" y="${subY - 10}" width="80" height="22" rx="4" fill="${palette.node}" stroke="${color}" stroke-width="1"/>`;
                nodes += `<text x="${subX}" y="${subY + 4}" text-anchor="middle" fill="${palette.text}" font-size="8" font-family="Inter, sans-serif">Detail ${j + 1}</text>`;
            }
        }

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="${palette.bg}" rx="8"/>
  <text x="${w / 2}" y="24" text-anchor="middle" fill="${palette.primary}" font-size="14" font-weight="bold" font-family="Inter, sans-serif">Hierarchy — ${this.truncate(topic, 40)}</text>
  ${lines}${nodes}
</svg>`;

        return {
            id: 'hierarchy-1',
            type: 'HIERARCHY',
            title: `${topic} — Hierarchy`,
            svgContent: svg,
            caption: `Hierarchical breakdown of ${topic} concepts`,
            width: w,
            height: h,
        };
    }

    private generateTimeline(topic: string, palette: any): SvgDiagram {
        const w = 700, h = 200;
        const events = [
            { year: 'Origins', desc: 'Historical foundations' },
            { year: 'Development', desc: 'Key milestones' },
            { year: 'Modern Era', desc: 'Contemporary evolution' },
            { year: 'Present', desc: 'Current state' },
            { year: 'Future', desc: 'Upcoming trends' },
        ];

        const lineY = 100;
        const gap = w / (events.length + 1);

        let nodes = '';
        nodes += `<line x1="40" y1="${lineY}" x2="${w - 40}" y2="${lineY}" stroke="${palette.primary}" stroke-width="3"/>`;

        for (let i = 0; i < events.length; i++) {
            const x = gap * (i + 1);
            const color = palette.colors[i % palette.colors.length];
            const above = i % 2 === 0;

            nodes += `<circle cx="${x}" cy="${lineY}" r="8" fill="${color}"/>`;
            nodes += `<text x="${x}" y="${above ? lineY - 25 : lineY + 35}" text-anchor="middle" fill="${palette.primary}" font-size="11" font-weight="bold" font-family="Inter, sans-serif">${events[i].year}</text>`;
            nodes += `<text x="${x}" y="${above ? lineY - 12 : lineY + 48}" text-anchor="middle" fill="${palette.text}" font-size="9" font-family="Inter, sans-serif">${events[i].desc}</text>`;
        }

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="${palette.bg}" rx="8"/>
  <text x="${w / 2}" y="28" text-anchor="middle" fill="${palette.primary}" font-size="14" font-weight="bold" font-family="Inter, sans-serif">Timeline — ${this.truncate(topic, 40)}</text>
  ${nodes}
</svg>`;

        return {
            id: 'timeline-1',
            type: 'TIMELINE',
            title: `${topic} — Timeline`,
            svgContent: svg,
            caption: `Historical timeline of ${topic}`,
            width: w,
            height: h,
        };
    }

    // ── Mind Map ──────────────────────────────────────────────────────────────────

    private async generateMindMap(topic: string, subtopics: string[], palette: any): Promise<MindMap> {
        const rootNode: MindMapNode = {
            label: topic,
            children: subtopics.map((sub, i) => ({
                label: sub,
                color: palette.colors[i % palette.colors.length],
                children: [
                    { label: 'Key Fact 1', children: [] },
                    { label: 'Key Fact 2', children: [] },
                ],
            })),
        };

        const w = 800, h = 600;
        const cx = w / 2, cy = h / 2;
        let nodes = '';
        let lines = '';

        // Root
        nodes += `<circle cx="${cx}" cy="${cy}" r="50" fill="${palette.primary}"/>`;
        nodes += `<text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="white" font-size="13" font-weight="bold" font-family="Inter, sans-serif">${this.truncate(topic, 16)}</text>`;

        // Branches
        const n = rootNode.children.length;
        for (let i = 0; i < n; i++) {
            const angle = (2 * Math.PI * i) / n - Math.PI / 2;
            const r1 = 170;
            const bx = cx + r1 * Math.cos(angle);
            const by = cy + r1 * Math.sin(angle);
            const color = rootNode.children[i].color || palette.colors[i % palette.colors.length];

            // Branch line (curved)
            const ctrl1x = cx + 60 * Math.cos(angle);
            const ctrl1y = cy + 60 * Math.sin(angle);
            lines += `<path d="M ${cx} ${cy} Q ${ctrl1x} ${ctrl1y} ${bx} ${by}" stroke="${color}" stroke-width="3" fill="none" opacity="0.7"/>`;

            // Branch node
            nodes += `<ellipse cx="${bx}" cy="${by}" rx="65" ry="22" fill="${color}" opacity="0.85"/>`;
            nodes += `<text x="${bx}" y="${by + 4}" text-anchor="middle" fill="white" font-size="10" font-family="Inter, sans-serif">${this.truncate(rootNode.children[i].label, 18)}</text>`;

            // Sub-branches
            const subChildren = rootNode.children[i].children;
            for (let j = 0; j < subChildren.length; j++) {
                const subAngle = angle + (j - (subChildren.length - 1) / 2) * 0.4;
                const r2 = 100;
                const sx = bx + r2 * Math.cos(subAngle);
                const sy = by + r2 * Math.sin(subAngle);

                lines += `<line x1="${bx}" y1="${by}" x2="${sx}" y2="${sy}" stroke="${color}" stroke-width="1.5" opacity="0.4"/>`;
                nodes += `<rect x="${sx - 45}" y="${sy - 10}" width="90" height="20" rx="10" fill="${palette.node}" stroke="${color}" stroke-width="1"/>`;
                nodes += `<text x="${sx}" y="${sy + 4}" text-anchor="middle" fill="${palette.text}" font-size="8" font-family="Inter, sans-serif">${subChildren[j].label}</text>`;
            }
        }

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="${palette.bg}" rx="8"/>
  ${lines}${nodes}
</svg>`;

        return {
            title: `Mind Map — ${topic}`,
            rootNode,
            svgContent: svg,
            width: w,
            height: h,
        };
    }

    // ── Comparison Tables ─────────────────────────────────────────────────────────

    private async generateTables(topic: string, subtopics: string[]): Promise<ComparisonTable[]> {
        const tables: ComparisonTable[] = [];

        // Main comparison table
        tables.push({
            title: `Key Aspects of ${topic}`,
            headers: ['Aspect', 'Details', 'Significance', 'Exam Relevance'],
            rows: subtopics.slice(0, 6).map((sub, i) => [
                sub,
                `Core characteristics and features of ${sub}`,
                i % 2 === 0 ? 'High' : 'Medium',
                'CAPF AC / SSB',
            ]),
            footnote: `Source: Standard reference texts for ${topic}`,
        });

        // Before/After or comparison
        if (subtopics.length >= 2) {
            tables.push({
                title: `Comparison: ${subtopics[0]} vs ${subtopics[1]}`,
                headers: ['Parameter', subtopics[0], subtopics[1]],
                rows: [
                    ['Definition', `Description of ${subtopics[0]}`, `Description of ${subtopics[1]}`],
                    ['Key Feature', 'Feature A characteristic', 'Feature B characteristic'],
                    ['Application', 'Context A', 'Context B'],
                    ['Relevance', 'High for defence exams', 'Medium for general studies'],
                ],
            });
        }

        return tables;
    }

    // ── 20 MCQs ───────────────────────────────────────────────────────────────────

    private async generateMCQs(topic: string, subject: string): Promise<IllustratedMCQ[]> {
        const mcqs: IllustratedMCQ[] = [];

        for (let i = 0; i < 20; i++) {
            mcqs.push({
                id: i + 1,
                question: `[AI-Generated] Q${i + 1}: Objective question on ${topic} (${subject})`,
                options: {
                    a: 'Option A — plausible distractor',
                    b: 'Option B — correct answer',
                    c: 'Option C — commonly confused',
                    d: 'Option D — partially correct',
                },
                correctAnswer: 'b',
                explanation: `Explanation referencing key concepts of ${topic}. This question follows CAPF AC pattern.`,
            });
        }

        return mcqs;
    }

    // ── 10 Analytical CAPF AC Questions ───────────────────────────────────────────

    private async generateAnalyticalQuestions(topic: string, subject: string): Promise<AnalyticalQuestion[]> {
        const questions: AnalyticalQuestion[] = [];

        const skillSets = [
            ['Critical Analysis', 'Data Interpretation'],
            ['Reasoning', 'Application'],
            ['Factual Recall', 'Synthesis'],
            ['Evaluation', 'Comparison'],
            ['Problem Solving', 'Decision Making'],
        ];

        for (let i = 0; i < 10; i++) {
            questions.push({
                id: i + 1,
                passage: `[AI-Generated] Context passage ${i + 1}: A detailed scenario or data set related to ${topic} in the domain of ${subject}. This passage provides the factual basis for the analytical question that follows. The candidate is expected to read, comprehend, and apply critical thinking.`,
                question: `Based on the above passage, analyze the implications of ${topic} and provide a reasoned response with supporting arguments. (${i < 5 ? '150 words' : '250 words'})`,
                expectedApproach: `Structure: (1) Identify key issues, (2) Apply relevant knowledge of ${subject}, (3) Draw evidence-based conclusions, (4) Suggest practical recommendations.`,
                markingScheme: `Content: 40% | Analysis: 30% | Clarity: 20% | Examples: 10%`,
                assessedSkills: skillSets[i % skillSets.length],
            });
        }

        return questions;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────

    private inferSubtopics(topic: string, subject: string): string[] {
        return [
            `Introduction to ${topic}`,
            `Key Concepts & Theories`,
            `Indian Context & Applications`,
            `Global Perspective`,
            `Current Trends & Developments`,
        ];
    }

    private truncate(text: string, maxLen: number): string {
        return text.length > maxLen ? text.slice(0, maxLen - 2) + '…' : text;
    }
}
