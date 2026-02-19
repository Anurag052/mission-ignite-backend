import { Injectable, Logger } from '@nestjs/common';
import { SmartNotebookOutput } from './smart-notebook.generator';
import { IllustratedOutput } from './illustrated-notes.generator';

/**
 * PDF Renderer — Converts generated content into styled HTML for PDF export.
 *
 * Uses Puppeteer (headless Chrome) to render HTML → PDF with:
 *   - Professional styling (Inter font, color-coded sections)
 *   - Page headers/footers with branding
 *   - Table of contents with page numbers
 *   - Inline SVG diagrams (Mode 2)
 *   - Print-friendly layout with proper page breaks
 *
 * For server-side rendering without Puppeteer, falls back to
 * returning the styled HTML string (frontend can print-to-PDF).
 */

export interface PdfRenderOptions {
    format: 'A4' | 'LETTER';
    orientation: 'PORTRAIT' | 'LANDSCAPE';
    margins: { top: string; right: string; bottom: string; left: string };
    headerTemplate?: string;
    footerTemplate?: string;
    printBackground: boolean;
}

const DEFAULT_OPTIONS: PdfRenderOptions = {
    format: 'A4',
    orientation: 'PORTRAIT',
    margins: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    printBackground: true,
};

@Injectable()
export class PdfRendererService {
    private readonly logger = new Logger(PdfRendererService.name);

    // ── Mode 1: Smart Notebook → HTML ─────────────────────────────────────────────

    renderSmartNotebook(data: SmartNotebookOutput, options?: Partial<PdfRenderOptions>): string {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        this.logger.log(`Rendering Smart Notebook PDF: ${data.metadata.topic}`);

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>${this.getBaseStyles()}${this.getSmartNotebookStyles()}</style>
</head>
<body>
  ${this.renderCoverPage(data.metadata.topic, data.metadata.subject, 'SMART_NOTEBOOK', data.metadata.examFocus)}
  ${this.renderTableOfContents(data.tableOfContents)}

  <!-- Chapters -->
  ${data.chapters.map(ch => this.renderChapter(ch)).join('\n')}

  <!-- MCQs -->
  ${this.renderMCQSection(data.mcqs)}

  <!-- CAPF AC Questions -->
  ${data.capfQuestions.length > 0 ? this.renderSituationalSection('CAPF AC — Situational Questions', data.capfQuestions) : ''}

  <!-- SSB Questions -->
  ${data.ssbQuestions.length > 0 ? this.renderSituationalSection('SSB — Psychological Test Questions', data.ssbQuestions) : ''}

  <!-- OTA Questions -->
  ${data.otaQuestions.length > 0 ? this.renderSituationalSection('OTA — Assessment Scenarios', data.otaQuestions) : ''}

  <!-- Practice Test -->
  ${data.practiceTest ? this.renderPracticeTest(data.practiceTest) : ''}

  <!-- Quick Revision -->
  ${this.renderQuickRevision(data.quickRevisionSheet)}
</body>
</html>`;
    }

    // ── Mode 2: Illustrated Notes → HTML ──────────────────────────────────────────

    renderIllustratedNotes(data: IllustratedOutput, options?: Partial<PdfRenderOptions>): string {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        this.logger.log(`Rendering Illustrated Notes PDF: ${data.metadata.topic}`);

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>${this.getBaseStyles()}${this.getIllustratedStyles()}</style>
</head>
<body>
  ${this.renderCoverPage(data.metadata.topic, data.metadata.subject, 'ILLUSTRATED', [])}

  <!-- Bullet Sections -->
  ${data.bulletSections.map(s => this.renderBulletSection(s)).join('\n')}

  <!-- SVG Diagrams -->
  <div class="page-break"></div>
  <h2 class="section-title diagram-title">📊 Visual Diagrams</h2>
  ${data.diagrams.map(d => this.renderDiagram(d)).join('\n')}

  <!-- Mind Map -->
  <div class="page-break"></div>
  <h2 class="section-title">🧠 Mind Map</h2>
  <div class="mind-map-container">${data.mindMap.svgContent}</div>
  <p class="diagram-caption">${data.mindMap.title}</p>

  <!-- Tables -->
  ${data.tables.map(t => this.renderTable(t)).join('\n')}

  <!-- MCQs -->
  ${this.renderIllustratedMCQs(data.mcqs)}

  <!-- Analytical Questions -->
  ${this.renderAnalyticalQuestions(data.analyticalQuestions)}
</body>
</html>`;
    }

    // ── PDF Generation (Puppeteer) ────────────────────────────────────────────────

    async generatePdfBuffer(html: string, options?: Partial<PdfRenderOptions>): Promise<Buffer> {
        const opts = { ...DEFAULT_OPTIONS, ...options };

        try {
            // Dynamic import — Puppeteer may not be available in all environments
            const puppeteer = await import('puppeteer');
            const browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            });

            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: 'networkidle0' });

            const pdfBuffer = await page.pdf({
                format: opts.format === 'A4' ? 'a4' : 'letter',
                landscape: opts.orientation === 'LANDSCAPE',
                margin: opts.margins,
                printBackground: opts.printBackground,
                headerTemplate: opts.headerTemplate || this.getHeaderTemplate(),
                footerTemplate: opts.footerTemplate || this.getFooterTemplate(),
                displayHeaderFooter: true,
            });

            await browser.close();
            return Buffer.from(pdfBuffer);

        } catch (err) {
            this.logger.warn('Puppeteer unavailable — returning HTML for client-side PDF generation');
            return Buffer.from(html, 'utf-8');
        }
    }

    // ── Render Components ─────────────────────────────────────────────────────────

    private renderCoverPage(topic: string, subject: string, mode: string, examFocus: string[]): string {
        const modeLabel = mode === 'SMART_NOTEBOOK' ? '🧠 Smart Notebook AI' : '📖 Illustrated Notes';
        return `
<div class="cover-page">
  <div class="cover-badge">${modeLabel}</div>
  <h1 class="cover-title">${topic}</h1>
  <div class="cover-subject">${subject}</div>
  ${examFocus.length > 0 ? `<div class="cover-exams">Exam Focus: ${examFocus.join(' • ')}</div>` : ''}
  <div class="cover-meta">
    <span>Mission Ignite — OTA SSB Preparation</span>
    <span>Generated: ${new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
  </div>
  <div class="cover-bar"></div>
</div>
<div class="page-break"></div>`;
    }

    private renderTableOfContents(toc: Array<{ chapter: number; title: string; page: number }>): string {
        return `
<div class="toc">
  <h2 class="toc-title">Table of Contents</h2>
  <div class="toc-entries">
    ${toc.map(e => `
      <div class="toc-entry">
        <span class="toc-chapter">Chapter ${e.chapter}</span>
        <span class="toc-dots"></span>
        <span class="toc-label">${e.title}</span>
      </div>
    `).join('')}
  </div>
</div>
<div class="page-break"></div>`;
    }

    private renderChapter(ch: any): string {
        return `
<div class="chapter">
  <div class="chapter-header">
    <span class="chapter-number">Chapter ${ch.chapterNumber}</span>
    <h2 class="chapter-title">${ch.title}</h2>
    <p class="chapter-summary">${ch.summary}</p>
  </div>

  ${ch.sections.map((s: any) => `
    <div class="section">
      <h3 class="section-heading">${s.heading}</h3>
      <div class="section-content">${s.content}</div>

      <div class="bullet-list">
        ${s.bulletPoints.map((b: string) => `<div class="bullet-item">▸ ${b}</div>`).join('')}
      </div>

      ${s.importantTerms.length > 0 ? `
        <div class="terms-box">
          <h4>📚 Key Terms</h4>
          ${s.importantTerms.map((t: any) => `
            <div class="term"><strong>${t.term}:</strong> ${t.definition}</div>
          `).join('')}
        </div>
      ` : ''}

      ${s.mnemonics ? `<div class="mnemonic-box">💡 Mnemonic: ${s.mnemonics.join('; ')}</div>` : ''}
      ${s.examTip ? `<div class="exam-tip">🎯 Exam Tip: ${s.examTip}</div>` : ''}
    </div>
  `).join('')}

  <div class="key-points-box">
    <h4>🔑 Key Points — Chapter ${ch.chapterNumber}</h4>
    <ol>
      ${ch.keyPoints.map((kp: string) => `<li>${kp}</li>`).join('')}
    </ol>
  </div>
</div>
<div class="page-break"></div>`;
    }

    private renderMCQSection(mcqs: any[]): string {
        return `
<div class="page-break"></div>
<div class="mcq-section">
  <h2 class="section-title">📝 Multiple Choice Questions (${mcqs.length})</h2>
  ${mcqs.map(q => `
    <div class="mcq">
      <div class="mcq-question"><strong>Q${q.id}.</strong> ${q.question}
        <span class="difficulty-badge difficulty-${q.difficulty.toLowerCase()}">${q.difficulty}</span>
      </div>
      <div class="mcq-options">
        <div class="mcq-option">(a) ${q.options.a}</div>
        <div class="mcq-option">(b) ${q.options.b}</div>
        <div class="mcq-option">(c) ${q.options.c}</div>
        <div class="mcq-option">(d) ${q.options.d}</div>
      </div>
      <div class="mcq-answer">✅ Answer: (${q.correctAnswer}) — ${q.explanation}</div>
    </div>
  `).join('')}
</div>`;
    }

    private renderSituationalSection(title: string, questions: any[]): string {
        return `
<div class="page-break"></div>
<div class="situational-section">
  <h2 class="section-title">🎖️ ${title}</h2>
  ${questions.map(q => `
    <div class="situational-q">
      <div class="sq-header">
        <span class="sq-id">${q.id}</span>
        <span class="sq-type">${q.type.replace(/_/g, ' ')}</span>
      </div>
      <div class="sq-scenario">${q.scenario}</div>
      <div class="sq-question"><strong>Question:</strong> ${q.question}</div>
      <div class="sq-ideal"><strong>Ideal Approach:</strong> ${q.idealResponse}</div>
      <div class="sq-olqs">OLQs Assessed: ${q.assessedOLQ.join(', ')}</div>
    </div>
  `).join('')}
</div>`;
    }

    private renderPracticeTest(test: any): string {
        return `
<div class="page-break"></div>
<div class="practice-test">
  <h2 class="section-title">📋 ${test.title}</h2>
  <div class="test-meta">Duration: ${test.duration} | Total Marks: ${test.totalMarks}</div>
  ${test.sections.map((sec: any) => `
    <div class="test-section">
      <h3>${sec.name} (${sec.marks} marks)</h3>
      ${sec.negativeMarking ? `<div class="neg-mark">⚠️ Negative marking: -${sec.negativeMarkValue} per wrong answer</div>` : ''}
      ${sec.questions.map((q: any) => `
        <div class="mcq compact">
          <div class="mcq-question"><strong>Q${q.id}.</strong> ${q.question}</div>
          <div class="mcq-options inline">
            (a) ${q.options.a} &nbsp; (b) ${q.options.b} &nbsp; (c) ${q.options.c} &nbsp; (d) ${q.options.d}
          </div>
        </div>
      `).join('')}
    </div>
  `).join('')}
</div>`;
    }

    private renderQuickRevision(items: string[]): string {
        return `
<div class="page-break"></div>
<div class="quick-revision">
  <h2 class="section-title">⚡ Quick Revision Sheet</h2>
  <div class="revision-grid">
    ${items.map((item, i) => `
      <div class="revision-item">
        <span class="revision-num">${i + 1}</span>
        <span>${item}</span>
      </div>
    `).join('')}
  </div>
</div>`;
    }

    private renderBulletSection(section: any): string {
        return `
<div class="illustrated-section">
  <h2 class="illustrated-heading">${section.heading}</h2>
  ${section.highlight ? `<div class="highlight-box">${section.highlight}</div>` : ''}
  <ul class="bullet-list-il">
    ${section.bullets.map((b: string) => {
            const subBullets = section.subBullets?.[b];
            return `<li>${b}${subBullets ? `
        <ul>${subBullets.map((sb: string) => `<li class="sub-bullet">${sb}</li>`).join('')}</ul>
      ` : ''}</li>`;
        }).join('')}
  </ul>
</div>`;
    }

    private renderDiagram(diagram: any): string {
        return `
<div class="diagram-block">
  <div class="svg-container">${diagram.svgContent}</div>
  <p class="diagram-caption">${diagram.caption}</p>
</div>`;
    }

    private renderTable(table: any): string {
        return `
<div class="table-block">
  <h3 class="table-title">${table.title}</h3>
  <table class="data-table">
    <thead><tr>${table.headers.map((h: string) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>
      ${table.rows.map((row: string[]) => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}
    </tbody>
  </table>
  ${table.footnote ? `<p class="table-footnote">${table.footnote}</p>` : ''}
</div>`;
    }

    private renderIllustratedMCQs(mcqs: any[]): string {
        return `
<div class="page-break"></div>
<div class="mcq-section">
  <h2 class="section-title">📝 Multiple Choice Questions (${mcqs.length})</h2>
  ${mcqs.map(q => `
    <div class="mcq">
      <div class="mcq-question"><strong>Q${q.id}.</strong> ${q.question}</div>
      <div class="mcq-options">
        (a) ${q.options.a} &nbsp; (b) ${q.options.b} &nbsp; (c) ${q.options.c} &nbsp; (d) ${q.options.d}
      </div>
      <div class="mcq-answer">✅ (${q.correctAnswer}) — ${q.explanation}</div>
    </div>
  `).join('')}
</div>`;
    }

    private renderAnalyticalQuestions(questions: any[]): string {
        return `
<div class="page-break"></div>
<div class="analytical-section">
  <h2 class="section-title">🔍 CAPF AC — Analytical Questions (${questions.length})</h2>
  ${questions.map(q => `
    <div class="analytical-q">
      <div class="aq-id">Q${q.id}</div>
      <div class="aq-passage">${q.passage}</div>
      <div class="aq-question"><strong>Question:</strong> ${q.question}</div>
      <div class="aq-approach"><strong>Expected Approach:</strong> ${q.expectedApproach}</div>
      <div class="aq-marking">Marking: ${q.markingScheme}</div>
      <div class="aq-skills">Skills: ${q.assessedSkills.join(', ')}</div>
    </div>
  `).join('')}
</div>`;
    }

    // ── Styles ────────────────────────────────────────────────────────────────────

    private getBaseStyles(): string {
        return `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@600;700&display=swap');

      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 11pt;
        line-height: 1.6;
        color: #1a1a2e;
        background: #fff;
      }

      .page-break { page-break-after: always; }

      /* Cover Page */
      .cover-page {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        min-height: 90vh; text-align: center; padding: 60px 40px;
      }
      .cover-badge {
        font-size: 14pt; font-weight: 600; color: #6C63FF;
        padding: 8px 24px; border: 2px solid #6C63FF; border-radius: 24px;
        margin-bottom: 40px; letter-spacing: 1px;
      }
      .cover-title {
        font-family: 'Outfit', sans-serif; font-size: 36pt; font-weight: 700;
        color: #1a1a2e; margin-bottom: 16px; line-height: 1.2;
      }
      .cover-subject {
        font-size: 16pt; color: #6C63FF; font-weight: 500; margin-bottom: 12px;
      }
      .cover-exams {
        font-size: 11pt; color: #555; margin-bottom: 40px;
      }
      .cover-meta {
        display: flex; flex-direction: column; gap: 4px;
        font-size: 10pt; color: #888;
      }
      .cover-bar {
        width: 120px; height: 4px; background: linear-gradient(90deg, #6C63FF, #FF6584);
        border-radius: 2px; margin-top: 40px;
      }

      /* Section Titles */
      .section-title {
        font-family: 'Outfit', sans-serif; font-size: 18pt; font-weight: 700;
        color: #1a1a2e; margin: 24px 0 16px; padding-bottom: 8px;
        border-bottom: 3px solid #6C63FF;
      }

      /* TOC */
      .toc { padding: 40px 0; }
      .toc-title {
        font-family: 'Outfit', sans-serif; font-size: 22pt;
        color: #1a1a2e; margin-bottom: 24px;
      }
      .toc-entry {
        display: flex; align-items: baseline; padding: 6px 0;
        border-bottom: 1px dotted #ddd;
      }
      .toc-chapter { font-weight: 600; color: #6C63FF; min-width: 100px; }
      .toc-label { color: #333; }

      /* MCQ */
      .mcq {
        padding: 12px 0; border-bottom: 1px solid #eee; margin-bottom: 8px;
      }
      .mcq-question { font-weight: 500; margin-bottom: 8px; }
      .mcq-options { padding-left: 20px; margin-bottom: 6px; }
      .mcq-option { padding: 2px 0; }
      .mcq-answer {
        font-size: 10pt; color: #27AE60; background: #E8F8F0;
        padding: 6px 12px; border-radius: 6px; margin-top: 6px;
      }
      .difficulty-badge {
        font-size: 8pt; padding: 2px 8px; border-radius: 10px;
        font-weight: 600; margin-left: 8px;
      }
      .difficulty-easy { background: #E8F8F0; color: #27AE60; }
      .difficulty-medium { background: #FFF8E1; color: #F39C12; }
      .difficulty-hard { background: #FDEDEC; color: #E74C3C; }

      /* Tables */
      .data-table {
        width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 10pt;
      }
      .data-table th {
        background: #2C3E50; color: white; padding: 10px 12px;
        text-align: left; font-weight: 600;
      }
      .data-table td {
        padding: 8px 12px; border-bottom: 1px solid #eee;
      }
      .data-table tr:nth-child(even) td { background: #F8F9FA; }
      .table-footnote { font-size: 9pt; color: #888; margin-top: 4px; }
    `;
    }

    private getSmartNotebookStyles(): string {
        return `
      /* Chapters */
      .chapter { margin-bottom: 32px; }
      .chapter-header {
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        color: white; padding: 24px 28px; border-radius: 12px; margin-bottom: 20px;
      }
      .chapter-number {
        font-size: 10pt; color: #6C63FF; font-weight: 600;
        text-transform: uppercase; letter-spacing: 2px;
      }
      .chapter-title { font-size: 20pt; font-weight: 700; margin: 8px 0; }
      .chapter-summary { font-size: 10pt; color: #ccc; line-height: 1.5; }

      .section { margin: 16px 0; padding: 12px 0; border-bottom: 1px solid #eee; }
      .section-heading {
        font-size: 13pt; font-weight: 600; color: #2C3E50;
        margin-bottom: 8px; padding-left: 12px;
        border-left: 4px solid #6C63FF;
      }
      .section-content { padding: 8px 0; color: #333; }

      .bullet-item {
        padding: 3px 0 3px 16px; color: #444;
      }

      .terms-box {
        background: #F0F4FF; border-left: 4px solid #6C63FF;
        padding: 12px 16px; border-radius: 0 8px 8px 0; margin: 12px 0;
      }
      .terms-box h4 { font-size: 11pt; margin-bottom: 6px; }
      .term { font-size: 10pt; padding: 3px 0; }

      .mnemonic-box {
        background: #FFF8E1; border: 1px dashed #F39C12;
        padding: 10px 14px; border-radius: 8px; margin: 8px 0;
        font-size: 10pt; color: #856404;
      }

      .exam-tip {
        background: #E8F8F0; padding: 8px 14px; border-radius: 8px;
        font-size: 10pt; color: #1B7A4A; margin: 8px 0;
      }

      .key-points-box {
        background: #FFF3E0; padding: 16px 20px; border-radius: 10px;
        margin: 16px 0; border: 2px solid #FF9800;
      }
      .key-points-box h4 { font-size: 12pt; margin-bottom: 8px; }
      .key-points-box ol { padding-left: 20px; }
      .key-points-box li { padding: 3px 0; font-size: 10pt; }

      /* Situational Questions */
      .situational-q {
        padding: 14px 0; border-bottom: 1px solid #eee; margin-bottom: 10px;
      }
      .sq-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .sq-id {
        width: 28px; height: 28px; background: #6C63FF; color: white;
        border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-size: 11pt; font-weight: 700;
      }
      .sq-type {
        font-size: 9pt; padding: 3px 10px; background: #F0F4FF;
        border-radius: 12px; color: #6C63FF; font-weight: 600;
      }
      .sq-scenario { font-style: italic; color: #444; margin: 6px 0; }
      .sq-question { margin: 6px 0; }
      .sq-ideal {
        font-size: 10pt; color: #27AE60; background: #E8F8F0;
        padding: 8px 12px; border-radius: 6px; margin-top: 6px;
      }
      .sq-olqs {
        font-size: 9pt; color: #888; margin-top: 4px;
      }

      /* Practice Test */
      .test-meta {
        font-size: 12pt; color: #555; margin-bottom: 16px;
        padding: 10px; background: #F8F9FA; border-radius: 8px;
      }
      .neg-mark {
        font-size: 10pt; color: #E74C3C; padding: 4px 0;
      }
      .mcq.compact { padding: 6px 0; }

      /* Quick Revision */
      .revision-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .revision-item {
        display: flex; align-items: baseline; gap: 8px;
        padding: 6px 10px; background: #F8F9FA; border-radius: 6px; font-size: 10pt;
      }
      .revision-num {
        width: 22px; height: 22px; background: #6C63FF; color: white;
        border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-size: 9pt; font-weight: 700; flex-shrink: 0;
      }
    `;
    }

    private getIllustratedStyles(): string {
        return `
      .illustrated-section { margin: 16px 0; }
      .illustrated-heading {
        font-size: 14pt; font-weight: 700; color: #2C3E50;
        padding: 8px 0; border-bottom: 2px solid #6C63FF;
      }
      .bullet-list-il { list-style: none; padding-left: 0; }
      .bullet-list-il > li {
        padding: 6px 0 6px 20px; position: relative; color: #333;
      }
      .bullet-list-il > li::before {
        content: '▹'; position: absolute; left: 0; color: #6C63FF; font-weight: bold;
      }
      .sub-bullet { font-size: 10pt; color: #666; padding: 2px 0; }
      .highlight-box {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white; padding: 12px 18px; border-radius: 8px;
        margin: 10px 0; font-size: 10pt;
      }
      .diagram-block { text-align: center; margin: 20px 0; }
      .svg-container { display: flex; justify-content: center; }
      .svg-container svg { max-width: 100%; height: auto; }
      .diagram-caption {
        font-size: 9pt; color: #888; margin-top: 6px; text-align: center;
      }
      .mind-map-container { display: flex; justify-content: center; margin: 16px 0; }
      .mind-map-container svg { max-width: 100%; height: auto; }

      .analytical-q {
        padding: 14px 0; border-bottom: 1px solid #eee;
      }
      .aq-id {
        font-weight: 700; color: #6C63FF; font-size: 12pt;
      }
      .aq-passage {
        background: #F8F9FA; padding: 12px; border-radius: 8px;
        font-size: 10pt; color: #444; margin: 8px 0;
        border-left: 4px solid #2C3E50;
      }
      .aq-question { margin: 6px 0; }
      .aq-approach {
        font-size: 10pt; color: #27AE60; margin: 4px 0;
      }
      .aq-marking { font-size: 9pt; color: #888; }
      .aq-skills { font-size: 9pt; color: #6C63FF; }
    `;
    }

    private getHeaderTemplate(): string {
        return `<div style="font-size:8pt; color:#aaa; width:100%; text-align:center; padding-top:5mm;">
      Mission Ignite — OTA SSB Preparation
    </div>`;
    }

    private getFooterTemplate(): string {
        return `<div style="font-size:8pt; color:#aaa; width:100%; display:flex; justify-content:space-between; padding:0 15mm;">
      <span>Confidential — For personal use only</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`;
    }
}
