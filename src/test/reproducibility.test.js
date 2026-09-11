// Tests for the "可復現性" (reproducibility) module update: the prompt is
// now dynamic per paper type instead of one fixed checklist, so most of
// the behavior change lives in natural-language prompt text that isn't
// meaningfully unit-testable (per the request, we don't hard-test prose).
// What we *can* verify structurally:
//   - the prompt actually instructs Claude to classify paper type first
//     and to distinguish "not applicable" from "not_mentioned", rather
//     than emitting a fixed checklist for every paper
//   - the schema/tool contract for reproducibility items is unchanged
//     (still just {id, title, claim, kind, evidence} — no new required
//     field), so old saved analysis data keeps working with no migration
//   - reproducibility analysis items (old-style, no extra fields) still
//     round-trip through storage.js without crashing

import { describe, it, expect, beforeEach } from 'vitest';
import { getModule, ANALYSIS_TOOL } from '../lib/prompts.js';
import { db, createPaper, saveAnalysis, getAnalysis } from '../lib/storage.js';

describe('reproducibility prompt', () => {
  const question = getModule('reproducibility').buildQuestion();

  it('asks Claude to classify paper type before deciding which items to check', () => {
    expect(question).toContain('先判斷這篇論文的類型');
    expect(question).toContain('systematic review');
    expect(question).toContain('machine learning paper');
  });

  it('distinguishes "not applicable" from "not_mentioned" as separate concepts', () => {
    expect(question).toContain('不適用');
    expect(question).toContain('not_mentioned');
    // The rule that inapplicable items should not become cards at all.
    expect(question).toMatch(/不適用.*不要.*產生卡片|不要為它產生卡片/);
  });

  it('explicitly tells Claude not to force a fixed checklist onto every paper', () => {
    expect(question).toContain('不是固定 checklist');
  });

  it('gives systematic-review-specific guidance distinct from the ML checklist', () => {
    expect(question).toContain('inclusion criteria');
    expect(question).toContain('reviewer');
    expect(question).toContain('PRISMA');
    // PRISMA must be called out as a reporting framework, not software.
    expect(question).toMatch(/PRISMA.*不是軟體|PRISMA.*reporting/);
  });

  it('still asks for fact vs inference separation, same as other modules', () => {
    expect(question).toContain('fact');
    expect(question).toContain('inference');
    // fact and inference must be produced as separate items, not merged.
    expect(question).toMatch(/不能跟 fact 寫在同一個 item|必須拆開/);
  });
});

describe('reproducibility items keep the same shape as before (no schema change)', () => {
  it('the shared analysis tool schema is unchanged: still no new required field', () => {
    const itemSchema = ANALYSIS_TOOL.input_schema.properties.items.items;
    expect(itemSchema.required).toEqual(['id', 'title', 'claim', 'kind', 'evidence']);
  });

  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
  });

  it('saves and retrieves an old-style reproducibility item (no extra fields) without crashing', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'reproducibility', {
      status: 'done',
      items: [
        {
          id: 'item-1',
          title: '文獻納入／排除標準',
          claim: '作者說明納入標準為英文發表、涉及穿戴式感測器之研究。',
          kind: 'fact',
          evidence: [],
        },
      ],
    });

    const record = await getAnalysis(paper.id, 'reproducibility');
    expect(record.items).toHaveLength(1);
    expect(record.items[0].title).toBe('文獻納入／排除標準');
    expect(record.items[0].sourceScope).toBeUndefined();
  });
});
