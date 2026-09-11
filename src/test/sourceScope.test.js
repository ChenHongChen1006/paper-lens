// Tests for the "數據細節" sourceScope field: normalization (so a missing
// or invalid value from Claude never crashes the analysis or the UI), the
// tool schema shape (sourceScope must stay optional), and that analysis
// items with or without sourceScope round-trip through storage.js fine —
// this is how we're sure old, pre-this-feature analysis data keeps working
// without any destructive IndexedDB migration.

import { describe, it, expect, beforeEach } from 'vitest';
import { SOURCE_SCOPES, SOURCE_SCOPE_LABELS, normalizeSourceScope, ANALYSIS_TOOL } from '../lib/prompts.js';
import { db, createPaper, saveAnalysis, getAnalysis } from '../lib/storage.js';

describe('normalizeSourceScope', () => {
  it('passes through every valid sourceScope value unchanged', () => {
    for (const value of SOURCE_SCOPES) {
      expect(normalizeSourceScope(value)).toBe(value);
    }
  });

  it('normalizes a missing value (undefined) to "unclear"', () => {
    expect(normalizeSourceScope(undefined)).toBe('unclear');
  });

  it('normalizes an illegal/unrecognized value to "unclear" instead of throwing', () => {
    expect(normalizeSourceScope('made_up_value')).toBe('unclear');
    expect(normalizeSourceScope('')).toBe('unclear');
    expect(normalizeSourceScope(null)).toBe('unclear');
    expect(normalizeSourceScope(123)).toBe('unclear');
  });

  it('has a Traditional Chinese label for every valid value', () => {
    for (const value of SOURCE_SCOPES) {
      expect(typeof SOURCE_SCOPE_LABELS[value]).toBe('string');
      expect(SOURCE_SCOPE_LABELS[value].length).toBeGreaterThan(0);
    }
  });
});

describe('ANALYSIS_TOOL schema', () => {
  it('declares sourceScope as an optional field, not required', () => {
    const itemSchema = ANALYSIS_TOOL.input_schema.properties.items.items;
    expect(itemSchema.properties.sourceScope).toBeDefined();
    expect(itemSchema.properties.sourceScope.enum).toEqual(SOURCE_SCOPES);
    expect(itemSchema.required).not.toContain('sourceScope');
    // The original required fields must still be intact.
    expect(itemSchema.required).toEqual(['id', 'title', 'claim', 'kind', 'evidence']);
  });
});

describe('analysis items with sourceScope round-trip through storage', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
  });

  it('saves and retrieves a data-module analysis item that has sourceScope', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'data', {
      status: 'done',
      items: [
        {
          id: 'item-1',
          title: '文獻篩選數量',
          claim: '初始檢索 400 篇文章，最終納入 39 篇。',
          kind: 'fact',
          sourceScope: 'paper',
          evidence: [],
        },
      ],
    });

    const record = await getAnalysis(paper.id, 'data');
    expect(record.items[0].sourceScope).toBe('paper');
  });

  it('saves and retrieves an old-style item with no sourceScope field at all, without error', async () => {
    const paper = await createPaper({ title: 'P2', fileName: 'p2.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'data', {
      status: 'done',
      items: [
        {
          id: 'item-1',
          title: '舊版分析結果',
          claim: '這是新增 sourceScope 欄位之前保存的重點。',
          kind: 'fact',
          evidence: [],
        },
      ],
    });

    const record = await getAnalysis(paper.id, 'data');
    expect(record.items[0].sourceScope).toBeUndefined();
    // The display layer must treat this the same as an explicit "unclear".
    expect(normalizeSourceScope(record.items[0].sourceScope)).toBe('unclear');
  });
});
