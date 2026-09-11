// export.js — Markdown rendering of a paper's analyses/questions, and small
// browser download/clipboard helpers used by Settings and PaperDetail.

import {
  MODULES,
  SOURCE_SCOPE_LABELS,
  WEAKNESS_TYPE_LABELS,
  normalizeSourceScope,
  normalizeWeaknessType,
} from './prompts.js';
import { verifyQuote } from './text.js';

function kindLabel(kind) {
  return { fact: '事實', inference: '推論', not_mentioned: '原文未提及' }[kind] || kind;
}

function statusLabel(status) {
  return { exact: '原文已核對', partial: '部分符合', not_found: '找不到原文' }[status] || '未核對';
}

function renderEvidence(ev, segments, indent = '') {
  const verification = verifyQuote(ev.quote, segments, { hintSegmentId: ev.segmentId, hintPage: ev.page });
  const page = verification.page ?? ev.page ?? '?';
  return [
    `${indent}原文依據：`,
    '',
    `${indent}> ${ev.quote}`,
    '',
    `${indent}頁碼：p. ${page}`,
    '',
    `${indent}核對結果：${statusLabel(verification.status)}`,
    '',
  ];
}

// analysesByModule: { [moduleId]: { items, status } | undefined }
export function buildPaperMarkdown(paper, analysesByModule, questions = []) {
  const lines = [];
  lines.push(`# ${paper.title}`);
  lines.push('');
  lines.push(`- 檔名：${paper.fileName}`);
  lines.push(`- 頁數：${paper.pageCount}`);
  lines.push(`- 擷取方式：${paper.extractionMode === 'ocr' ? 'OCR（掃描 PDF）' : '文字 PDF'}`);
  lines.push(`- 匯出時間：${new Date().toLocaleString('zh-TW')}`);
  lines.push('');

  for (const module of MODULES) {
    const analysis = analysesByModule[module.id];
    lines.push(`## ${module.label}`);
    lines.push('');
    if (!analysis || !Array.isArray(analysis.items) || analysis.items.length === 0) {
      lines.push('_尚未分析。_');
      lines.push('');
      continue;
    }
    for (const item of analysis.items) {
      lines.push(`### ${item.title}`);
      lines.push('');
      lines.push(item.claim);
      lines.push('');
      lines.push(`類型：${kindLabel(item.kind)}`);
      // Mirrors the same optional-field handling AnalysisModule.jsx uses
      // for the second badge: 數據細節 always shows a source-scope label
      // (normalizeSourceScope falls back to "來源層級不明"); 弱點與延伸
      // only shows one when a valid weaknessType exists (see prompts.js).
      if (module.id === 'data') {
        lines.push(`數據來源：${SOURCE_SCOPE_LABELS[normalizeSourceScope(item.sourceScope)]}`);
      }
      if (module.id === 'limitations') {
        const weaknessType = normalizeWeaknessType(item.weaknessType);
        if (weaknessType) lines.push(`類別：${WEAKNESS_TYPE_LABELS[weaknessType]}`);
      }
      lines.push('');
      for (const ev of Array.isArray(item.evidence) ? item.evidence : []) {
        lines.push(...renderEvidence(ev, paper.segments));
      }
    }
  }

  if (questions.length > 0) {
    lines.push('## 自訂提問');
    lines.push('');
    for (const q of questions) {
      lines.push(`### Q：${q.question}`);
      lines.push('');
      const items = Array.isArray(q.answer?.items) ? q.answer.items : [];
      if (items.length === 0) lines.push('_無回答內容。_');
      for (const item of items) {
        lines.push(`- **${item.title}**（${kindLabel(item.kind)}）：${item.claim}`);
        for (const ev of Array.isArray(item.evidence) ? item.evidence : []) {
          const verification = verifyQuote(ev.quote, paper.segments, {
            hintSegmentId: ev.segmentId,
            hintPage: ev.page,
          });
          const page = verification.page ?? ev.page ?? '?';
          lines.push(`  > ${ev.quote} — p.${page}（${statusLabel(verification.status)}）`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadMarkdown(filename, markdown) {
  downloadTextFile(filename, markdown, 'text/markdown;charset=utf-8');
}

export function downloadJson(filename, obj) {
  downloadTextFile(filename, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8');
}

export async function copyToClipboard(text) {
  await navigator.clipboard.writeText(text);
}
