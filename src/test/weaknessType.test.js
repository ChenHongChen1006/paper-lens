// Tests for the "弱點與延伸" weaknessType field: normalization (missing or
// invalid values must never crash the analysis or the UI), the tool
// schema shape (weaknessType must stay optional, with no new required
// field), and that analysis items with or without weaknessType round-trip
// through storage.js fine — this is how old, pre-this-feature analysis
// data keeps working with no destructive IndexedDB migration.
//
// Unlike sourceScope, weaknessType has no catch-all "unclear" value: a
// missing or unrecognized value normalizes to `undefined`, and the UI
// simply omits the second badge for that item (see AnalysisModule.jsx).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WEAKNESS_TYPES,
  WEAKNESS_TYPE_LABELS,
  normalizeWeaknessType,
  ANALYSIS_TOOL,
  getModule,
} from '../lib/prompts.js';
import { db, createPaper, saveAnalysis, getAnalysis } from '../lib/storage.js';

describe('normalizeWeaknessType', () => {
  it('passes through every valid weaknessType value unchanged', () => {
    for (const value of WEAKNESS_TYPES) {
      expect(normalizeWeaknessType(value)).toBe(value);
    }
  });

  it('normalizes a missing value (undefined) to undefined, not a crash', () => {
    expect(normalizeWeaknessType(undefined)).toBeUndefined();
  });

  it('normalizes an illegal/unrecognized value to undefined instead of throwing', () => {
    expect(normalizeWeaknessType('made_up_value')).toBeUndefined();
    expect(normalizeWeaknessType('')).toBeUndefined();
    expect(normalizeWeaknessType(null)).toBeUndefined();
    expect(normalizeWeaknessType(123)).toBeUndefined();
  });

  it('has a Traditional Chinese label for every valid value', () => {
    for (const value of WEAKNESS_TYPES) {
      expect(typeof WEAKNESS_TYPE_LABELS[value]).toBe('string');
      expect(WEAKNESS_TYPE_LABELS[value].length).toBeGreaterThan(0);
    }
  });

  it('does not include an "unclear" catch-all value (unlike sourceScope)', () => {
    expect(WEAKNESS_TYPES).not.toContain('unclear');
  });
});

describe('ANALYSIS_TOOL schema', () => {
  it('declares weaknessType as an optional field, not required', () => {
    const itemSchema = ANALYSIS_TOOL.input_schema.properties.items.items;
    expect(itemSchema.properties.weaknessType).toBeDefined();
    expect(itemSchema.properties.weaknessType.enum).toEqual(WEAKNESS_TYPES);
    expect(itemSchema.required).not.toContain('weaknessType');
    // The original required fields (and sourceScope's earlier addition)
    // must still be intact — no new required field was introduced.
    expect(itemSchema.required).toEqual(['id', 'title', 'claim', 'kind', 'evidence']);
  });
});

describe('limitations prompt distinguishes scope choices from self-admitted limitations', () => {
  const question = getModule('limitations').buildQuestion();

  it('explicitly warns against treating scope/inclusion-exclusion choices as author-admitted limitations', () => {
    expect(question).toContain('scope_choice');
    expect(question).toContain('author_limitation');
    expect(question).toMatch(/不要把.*研究範圍.*當成.*弱點|不等於作者自承的弱點/);
  });

  it('distinguishes the review\'s own limitations from field-wide challenges', () => {
    expect(question).toContain('field_challenge');
    expect(question).toMatch(/不是這篇 review 本身的弱點|不是這篇論文自己的弱點/);
  });

  it('requires future_direction items to distinguish author-proposed (fact) from Claude-inferred (inference)', () => {
    expect(question).toContain('future_direction');
    expect(question).toContain('根據上述限制，可延伸研究');
  });

  it('still requires fact and inference to be kept in separate items', () => {
    expect(question).toMatch(/不要把.*原文明確事實.*與.*你的推論.*寫在同一個 item/);
  });
});

describe('limitations items with weaknessType round-trip through storage', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
  });

  it('saves and retrieves a limitations item that has weaknessType', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'limitations', {
      status: 'done',
      items: [
        {
          id: 'item-1',
          title: '研究範圍：排除公開資料集研究',
          claim: '作者排除了使用公開資料集的研究。',
          kind: 'fact',
          weaknessType: 'scope_choice',
          evidence: [],
        },
      ],
    });

    const record = await getAnalysis(paper.id, 'limitations');
    expect(record.items[0].weaknessType).toBe('scope_choice');
  });

  it('saves and retrieves an old-style item with no weaknessType field at all, without error', async () => {
    const paper = await createPaper({ title: 'P2', fileName: 'p2.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'limitations', {
      status: 'done',
      items: [
        {
          id: 'item-1',
          title: '舊版分析結果',
          claim: '這是新增 weaknessType 欄位之前保存的重點。',
          kind: 'fact',
          evidence: [],
        },
      ],
    });

    const record = await getAnalysis(paper.id, 'limitations');
    expect(record.items[0].weaknessType).toBeUndefined();
    // The display layer must treat this as "no second badge", not crash.
    expect(normalizeWeaknessType(record.items[0].weaknessType)).toBeUndefined();
  });
});
