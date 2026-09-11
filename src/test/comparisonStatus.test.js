// Tests for the comparisonStatus / emptyReason mechanism.
//
// Context: even after loosening COMPARISON_SYSTEM_PROMPT's over-cautious
// language (prior round), a "0 findings" result from Claude is still
// technically legal — the only way to tell "genuinely nothing comparable"
// apart from "the model just gave up" was to re-run the whole comparison
// and eyeball the input by hand. This round adds a structural requirement:
// Claude must self-report a top-level `comparisonStatus` ("compared" |
// "insufficient_overlap") consistent with whether `findings` is empty,
// and must justify an empty result with a short `emptyReason` — checked
// locally (prompts.js: validateComparisonStatus), not just trusted,
// exactly like every other Claude self-report in this app.
//
// This file does NOT re-test max_tokens/token-budget behavior (see
// comparisonTokenBudget.test.js) — per the request this addresses,
// COMPARISON_MAX_TOKENS stays at 8192, unchanged.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  COMPARISON_STATUSES,
  validateComparisonStatus,
  normalizeComparisonFindings,
  buildComparisonUserContent,
  COMPARISON_TOOL,
} from '../lib/prompts.js';
import { db, saveComparison, listComparisons } from '../lib/storage.js';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const { runComparison } = await import('../lib/api.js');

function toolUseResponse(input) {
  return {
    stop_reason: 'tool_use',
    usage: { input_tokens: 500, output_tokens: 200 },
    content: [{ type: 'tool_use', name: 'record_comparison', input }],
  };
}

const items = [
  { paperId: 'p0', paperTitle: 'A', itemId: 'i1', module: 'overview', title: 'T', claim: 'C1', kind: 'fact', verificationStatus: 'exact', verified: true },
  { paperId: 'p1', paperTitle: 'B', itemId: 'i2', module: 'overview', title: 'T', claim: 'C2', kind: 'fact', verificationStatus: 'exact', verified: true },
];

beforeEach(() => {
  mockCreate.mockReset();
});

describe('validateComparisonStatus (pure function)', () => {
  it('1. findings > 0 with comparisonStatus="compared" is valid', () => {
    expect(validateComparisonStatus({ comparisonStatus: 'compared', findingsCount: 3 })).toEqual({ valid: true });
  });

  it('2. findings=[] with comparisonStatus="insufficient_overlap" and a non-empty emptyReason is valid', () => {
    expect(
      validateComparisonStatus({ comparisonStatus: 'insufficient_overlap', emptyReason: '重疊不足。', findingsCount: 0 })
    ).toEqual({ valid: true });
  });

  it('3. findings=[] but comparisonStatus="compared" is invalid', () => {
    const result = validateComparisonStatus({ comparisonStatus: 'compared', findingsCount: 0 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('status_inconsistent_with_findings');
  });

  it('3b. findings > 0 but comparisonStatus="insufficient_overlap" is also invalid (symmetric case)', () => {
    const result = validateComparisonStatus({ comparisonStatus: 'insufficient_overlap', emptyReason: 'x', findingsCount: 2 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('status_inconsistent_with_findings');
  });

  it('4. comparisonStatus="insufficient_overlap" without an emptyReason (missing, empty, or whitespace-only) is invalid', () => {
    expect(validateComparisonStatus({ comparisonStatus: 'insufficient_overlap', findingsCount: 0 }).valid).toBe(false);
    expect(validateComparisonStatus({ comparisonStatus: 'insufficient_overlap', emptyReason: '', findingsCount: 0 }).valid).toBe(false);
    expect(validateComparisonStatus({ comparisonStatus: 'insufficient_overlap', emptyReason: '   ', findingsCount: 0 }).valid).toBe(false);
    const result = validateComparisonStatus({ comparisonStatus: 'insufficient_overlap', findingsCount: 0 });
    expect(result.reason).toBe('missing_empty_reason');
  });

  it('a comparisonStatus outside COMPARISON_STATUSES is invalid regardless of findings count', () => {
    const result = validateComparisonStatus({ comparisonStatus: 'partially_compared', findingsCount: 0 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_comparison_status');
    expect(result.value).toBe('partially_compared');
  });

  it('a missing comparisonStatus entirely is invalid, not silently defaulted', () => {
    expect(validateComparisonStatus({ findingsCount: 0 }).valid).toBe(false);
    expect(validateComparisonStatus({}).valid).toBe(false);
  });
});

describe('runComparison end-to-end: comparisonStatus consistency is enforced, not just trusted', () => {
  it('1. a self-consistent "compared" response with findings resolves normally', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [{ title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'p0', itemId: 'i1' }] }],
        comparisonStatus: 'compared',
      })
    );
    const { data } = await runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' });
    expect(data.findings).toHaveLength(1);
    expect(data.comparisonStatus).toBe('compared');
  });

  it('2. a self-consistent "insufficient_overlap" response with a valid emptyReason resolves normally (legitimate empty result)', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [],
        comparisonStatus: 'insufficient_overlap',
        emptyReason: '兩篇已保存分析在研究問題與分析面向上的重疊不足，無法形成可靠比較。',
      })
    );
    const { data } = await runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' });
    expect(data.findings).toEqual([]);
    expect(data.comparisonStatus).toBe('insufficient_overlap');
    expect(data.emptyReason).toBeTruthy();
  });

  it('3. findings=[] but comparisonStatus="compared" — rejected as an invalid/malformed response, not saved', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ findings: [], comparisonStatus: 'compared' }));
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' })
    ).rejects.toThrow('AI 回傳的比較結果狀態不一致');
  });

  it('4. comparisonStatus="insufficient_overlap" with no emptyReason — rejected as invalid', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ findings: [], comparisonStatus: 'insufficient_overlap' }));
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' })
    ).rejects.toThrow('AI 回傳的比較結果狀態不一致');
  });

  it('findings > 0 but comparisonStatus="insufficient_overlap" — also rejected (the symmetric inconsistency)', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [{ title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'p0', itemId: 'i1' }] }],
        comparisonStatus: 'insufficient_overlap',
        emptyReason: 'inconsistent on purpose',
      })
    );
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' })
    ).rejects.toThrow('AI 回傳的比較結果狀態不一致');
  });
});

describe('5-6. difference can stand alone, and a pure research-scope difference passes normalization/schema fine', () => {
  it('5. a findings array containing only a `difference` (no consensus/contradiction/research_gap) normalizes cleanly', () => {
    const raw = [
      { title: '研究範圍不同', type: 'difference', summary: '兩篇研究範圍不同。', sources: [{ paperId: 'p0', itemId: 'i1' }] },
    ];
    const { findings, rejections } = normalizeComparisonFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('difference');
    expect(rejections).toHaveLength(0);
  });

  it('6. a realistic "research scope differs" difference (mirroring the two actual test papers) passes the full tool schema shape', () => {
    const finding = {
      title: '研究範圍不同',
      type: 'difference',
      summary: '兩篇研究範圍不同：A 以 wearable stress detection 為核心，B 以 deep-learning-based PPG analysis 為核心。',
      sources: [
        { paperId: 'paper-A', itemId: 'a-ov-1' },
        { paperId: 'paper-B', itemId: 'b-ov-1' },
      ],
    };
    // Not a hardcoded "the model will say this" assertion — just a schema
    // / prompt-builder regression check that this exact shape of finding
    // (the concrete example given in the request this addresses) is
    // something the pipeline can actually accept end-to-end.
    const typeSchema = COMPARISON_TOOL.input_schema.properties.findings.items.properties.type;
    expect(typeSchema.enum).toContain('difference');
    const { findings, rejections } = normalizeComparisonFindings([finding]);
    expect(findings).toEqual([finding]);
    expect(rejections).toHaveLength(0);
  });

  it('the prompt builder accepts a two-paper item set that would plausibly produce this difference, without crashing', () => {
    const realisticItems = [
      { paperId: 'paper-A', paperTitle: 'Detection and monitoring of stress using wearables: a systematic review', itemId: 'a-ov-1', module: 'overview', title: '研究目標', claim: '本篇系統性回顧探討如何運用穿戴式裝置的生理訊號偵測壓力。', kind: 'fact', verificationStatus: 'exact', verified: true },
      { paperId: 'paper-B', paperTitle: 'A Scoping Review of Deep Learning Methods for Photoplethysmography Data', itemId: 'b-ov-1', module: 'overview', title: '研究目標', claim: '本篇範疇審查探討深度學習方法在 PPG 訊號分析上的應用。', kind: 'fact', verificationStatus: 'exact', verified: true },
    ];
    expect(() => buildComparisonUserContent(realisticItems, '')).not.toThrow();
  });
});

describe('7. old comparison records without comparisonStatus/emptyReason still work fine', () => {
  beforeEach(async () => {
    await db.comparisons.clear();
  });

  it('a legacy record with no comparisonStatus/emptyReason fields at all reads back safely', async () => {
    await db.comparisons.put({
      id: 'comparison-legacy-status',
      paperIds: ['p0', 'p1'],
      focusQuestion: '',
      findings: [],
      status: 'done',
      error: null,
      createdAt: Date.now(),
      // no diagnostics, no emptyReason — exactly what every comparison
      // saved before this feature (and the diagnostics feature before it)
      // looks like.
    });
    const list = await listComparisons();
    const record = list.find((c) => c.id === 'comparison-legacy-status');
    expect(record).toBeDefined();
    // Mirrors ComparePage.jsx's render: `c.emptyReason || <generic line>`.
    expect(record.emptyReason || '可能是兩篇研究的重疊範圍較少，或現有單篇分析不足以支持可靠比較。').toBe(
      '可能是兩篇研究的重疊範圍較少，或現有單篇分析不足以支持可靠比較。'
    );
    expect(record.diagnostics?.comparisonStatus ?? null).toBeNull();
  });
});

describe('8. diagnostics can store comparisonStatus, and it survives persistence', () => {
  beforeEach(async () => {
    await db.comparisons.clear();
  });

  it('a comparison saved with diagnostics.comparisonStatus="compared" round-trips through storage', async () => {
    const saved = await saveComparison({
      paperIds: ['p0', 'p1'],
      findings: [{ title: 'T', type: 'consensus', summary: 'S', sources: [] }],
      status: 'done',
      diagnostics: { rawItemCount: 1, finalItemCount: 1, comparisonStatus: 'compared', typeCounts: { consensus: 1, difference: 0, contradiction: 0, shared_limitation: 0, research_gap: 0 } },
    });
    const list = await listComparisons();
    const record = list.find((c) => c.id === saved.id);
    expect(record.diagnostics.comparisonStatus).toBe('compared');
  });

  it('a legitimately empty comparison stores diagnostics.comparisonStatus="insufficient_overlap" and a matching emptyReason', async () => {
    const saved = await saveComparison({
      paperIds: ['p0', 'p1'],
      findings: [],
      status: 'done',
      diagnostics: { rawItemCount: 0, finalItemCount: 0, comparisonStatus: 'insufficient_overlap', typeCounts: { consensus: 0, difference: 0, contradiction: 0, shared_limitation: 0, research_gap: 0 } },
      emptyReason: '兩篇已保存分析在研究問題與分析面向上的重疊不足，無法形成可靠比較。',
    });
    const list = await listComparisons();
    const record = list.find((c) => c.id === saved.id);
    expect(record.diagnostics.comparisonStatus).toBe('insufficient_overlap');
    expect(record.emptyReason).toBe('兩篇已保存分析在研究問題與分析面向上的重疊不足，無法形成可靠比較。');
  });
});

describe('COMPARISON_STATUSES / tool schema wiring', () => {
  it('COMPARISON_STATUSES is exactly the two documented values', () => {
    expect(COMPARISON_STATUSES).toEqual(['compared', 'insufficient_overlap']);
  });

  it('the tool schema requires comparisonStatus alongside findings, and constrains it to the enum', () => {
    expect(COMPARISON_TOOL.input_schema.required).toContain('comparisonStatus');
    expect(COMPARISON_TOOL.input_schema.properties.comparisonStatus.enum).toEqual(COMPARISON_STATUSES);
  });

  it('emptyReason is present in the schema but not in `required` (conditionally required, enforced in code via validateComparisonStatus)', () => {
    expect(COMPARISON_TOOL.input_schema.properties.emptyReason).toBeDefined();
    expect(COMPARISON_TOOL.input_schema.required).not.toContain('emptyReason');
  });
});
