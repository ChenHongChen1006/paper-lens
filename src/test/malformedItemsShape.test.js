// Regression tests for a real crash: opening the "弱點與延伸" tab threw
// "analysis.items.map is not a function" because a saved analysis record
// had `items` as something other than a flat array (most likely an object
// grouped by weaknessType category, e.g. { author_limitation: [...],
// scope_choice: [...] } — see CLAUDE.md and the "卡片排序" section of the
// limitations prompt, which discusses 5 categories in a way that could
// plausibly nudge a model toward grouping its own output that way despite
// the tool schema demanding a flat array).
//
// The fix has three independent layers, all covered here:
//   1. api.js: normalizeStructuredData() always coerces a non-array
//      `items` to [] before it leaves callStructured() (and
//      runModuleAnalysis()'s existing finalItemCount===0 guard turns that
//      into a thrown error).
//   2. storage.js: saveAnalysis() never trusts the caller — a claimed
//      "done" save without a genuine non-empty items array is treated as
//      a failed attempt regardless.
//   3. AnalysisModule.jsx: defensive rendering for whatever old data is
//      already sitting in a user's IndexedDB from before layers 1-2
//      existed (tested here via the same boolean logic the component
//      uses, since this project doesn't do full component/DOM tests).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { normalizeAnalysisItems } from '../lib/prompts.js';
import { db, createPaper, saveAnalysis, getAnalysis, getAnalyses, isAnalysisCompleted } from '../lib/storage.js';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const { runModuleAnalysis } = await import('../lib/api.js');

const segments = [{ id: 'p1-s1', page: 1, text: 'The authors excluded studies published before 2018.' }];
const baseArgs = { apiKey: 'sk-ant-test', model: 'claude-sonnet-5', segments, moduleId: 'limitations' };

function toolUseResponse(input) {
  return {
    stop_reason: 'tool_use',
    usage: { input_tokens: 500, output_tokens: 200 },
    content: [{ type: 'tool_use', name: 'record_analysis', input }],
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('1. weakness/limitations module: a normal flat items array succeeds', () => {
  it('resolves with the items, unaffected by any of the new guards', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        items: [
          { id: 'i1', title: '研究範圍', claim: '排除 2018 年以前的研究。', kind: 'fact', weaknessType: 'scope_choice', evidence: [] },
        ],
      })
    );
    const result = await runModuleAnalysis(baseArgs);
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].weaknessType).toBe('scope_choice');
  });
});

describe('2. weakness module returns items as an object (grouped by category) — the actual reported shape', () => {
  it('does not save as done, and runModuleAnalysis rejects instead of returning a non-array items', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        items: {
          author_limitation: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
          scope_choice: [{ id: 'i2', title: 'T2', claim: 'C2', kind: 'fact', evidence: [] }],
        },
      })
    );
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow('Claude 已回應，但沒有產生可用的分析結果。請重試。');
  });
});

describe('3. weakness module returns items: null — must not crash', () => {
  it('runModuleAnalysis rejects cleanly, no TypeError', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ items: null }));
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow('Claude 已回應，但沒有產生可用的分析結果。請重試。');
  });

  it('normalizeAnalysisItems itself never throws on null, a string, or a number', () => {
    expect(() => normalizeAnalysisItems(null)).not.toThrow();
    expect(() => normalizeAnalysisItems('not an array')).not.toThrow();
    expect(() => normalizeAnalysisItems(42)).not.toThrow();
    expect(normalizeAnalysisItems(null)).toEqual({
      items: [],
      rejections: [{ index: null, reason: 'items_not_an_array', value: 'object' }],
    });
  });
});

describe('4. weakness module response has no `items` key at all', () => {
  it('runModuleAnalysis rejects rather than saving an empty success', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({}));
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow('Claude 已回應，但沒有產生可用的分析結果。請重試。');
  });
});

describe('5. old IndexedDB record with status:"done" and items as an object — storage/UI-logic level', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
  });

  it('isAnalysisCompleted treats it as NOT completed (so PaperDetailPage\'s X/5 count excludes it)', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    // Simulate a pre-existing bad record, written before saveAnalysis()'s
    // invariant existed — bypass saveAnalysis and write directly, exactly
    // like old data already sitting in a real user's IndexedDB.
    await db.analyses.put({
      id: 'analysis-legacy-bad',
      paperId: paper.id,
      module: 'limitations',
      status: 'done',
      items: { author_limitation: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }] },
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: null,
    });

    const record = await getAnalysis(paper.id, 'limitations');
    expect(isAnalysisCompleted(record)).toBe(false);

    // This mirrors exactly the condition AnalysisModule.jsx uses to decide
    // whether to show "先前分析資料格式異常，請重新分析。" instead of
    // crashing on `.map()` — see the component for the actual JSX.
    const hasMalformedItems = record.items !== undefined && !Array.isArray(record.items);
    expect(hasMalformedItems).toBe(true);
  });

  it('re-analyzing successfully after a legacy malformed record overwrites it cleanly', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await db.analyses.put({
      id: 'analysis-legacy-bad',
      paperId: paper.id,
      module: 'limitations',
      status: 'done',
      items: { author_limitation: [] },
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: null,
    });

    const goodItems = [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', weaknessType: 'scope_choice', evidence: [] }];
    await saveAnalysis(paper.id, 'limitations', { status: 'done', items: goodItems });

    const record = await getAnalysis(paper.id, 'limitations');
    expect(record.status).toBe('done');
    expect(record.items).toEqual(goodItems);
    expect(isAnalysisCompleted(record)).toBe(true);
  });
});

describe('6. analyze-all: 4 modules succeed, the 5th (weakness) is malformed', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
  });

  it('the 4 successful results are preserved, count is 4/5, and the failed module can be retried independently', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    const modules = ['overview', 'methodology', 'data', 'reproducibility'];
    for (const moduleId of modules) {
      await saveAnalysis(paper.id, moduleId, {
        status: 'done',
        items: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
      });
    }
    // The 5th module's analysis attempt failed (this is what
    // PaperDetailPage.jsx's analyzeOne() catch block would save after
    // runModuleAnalysis() rejected for the malformed-shape reason).
    await saveAnalysis(paper.id, 'limitations', {
      status: 'error',
      items: [],
      error: 'Claude 已回應，但沒有產生可用的分析結果。請重試。',
    });

    const analyses = await getAnalyses(paper.id);
    const completedCount = analyses.filter(isAnalysisCompleted).length;
    expect(completedCount).toBe(4);

    // The 4 successful modules are untouched.
    for (const moduleId of modules) {
      const record = analyses.find((a) => a.module === moduleId);
      expect(record.status).toBe('done');
      expect(record.items).toHaveLength(1);
    }

    // The failed module is independently retriable — a fresh success for
    // ONLY that module doesn't require touching the other 4 at all.
    const retryItems = [{ id: 'i2', title: 'Retry', claim: 'Second attempt succeeded.', kind: 'fact', evidence: [] }];
    await saveAnalysis(paper.id, 'limitations', { status: 'done', items: retryItems });

    const afterRetry = await getAnalyses(paper.id);
    expect(afterRetry.filter(isAnalysisCompleted)).toHaveLength(5);
    for (const moduleId of modules) {
      expect(afterRetry.find((a) => a.module === moduleId).items).toHaveLength(1); // still untouched
    }
  });
});

describe('7. a malformed weaknessType on one item normalizes safely without turning items into a non-array', () => {
  it('the item is kept (weaknessType is a per-item field, not a container), items stays a flat array', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        items: [
          { id: 'i1', title: 'T1', claim: 'C1', kind: 'fact', weaknessType: 'not_a_real_category', evidence: [] },
          { id: 'i2', title: 'T2', claim: 'C2', kind: 'fact', weaknessType: 'scope_choice', evidence: [] },
        ],
      })
    );
    const result = await runModuleAnalysis(baseArgs);
    expect(Array.isArray(result.data.items)).toBe(true);
    expect(result.data.items).toHaveLength(2);
    // normalizeWeaknessType() falls back to undefined for the bad value —
    // the ITEM survives, only the one field is sanitized.
    expect(result.data.items[0].weaknessType).toBeUndefined();
    expect(result.data.items[1].weaknessType).toBe('scope_choice');
  });
});
