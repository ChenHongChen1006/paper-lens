// Tests for the cross-paper comparison token/output strategy fix.
//
// Root cause of the reported bug: comparing just 2 fully-analyzed papers
// (5/5 modules each) already hit `stop_reason: 'max_tokens'`. Two things
// were wrong:
//   1. runComparison() explicitly passed maxTokens: 4096 — LOWER than the
//      8192 default callStructured() already uses for single-module
//      analysis, even though a comparison has to reason about many more
//      items and can produce nested findings/sources across several
//      categories.
//   2. Nothing bounded the OUTPUT shape: no result-count guidance, no
//      source-count guidance, and comparison-relevant differences in
//      method/scope were being forced into `contradiction` instead of a
//      distinct, lower-stakes `difference` type.
//
// The fix is NOT "just raise max_tokens higher" (explicitly rejected by
// the request this addresses) — it's raising the budget by a bounded,
// reasonable amount AND shrinking both the input (pruneComparisonItems)
// and the requested output shape (COMPARISON_SYSTEM_PROMPT's count/source
// limits, the new `difference` type) so the budget is actually sufficient
// regardless of how many papers are selected (2-10).
//
// This file mocks @anthropic-ai/sdk entirely — no real network calls —
// and uses fake-indexeddb (via src/test/setup.js) for the persistence
// tests. Ten scenarios are covered, matching the request's checklist.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  COMPARISON_SYSTEM_PROMPT,
  COMPARISON_TOOL,
  COMPARISON_TYPES,
  COMPARISON_TYPE_LABELS,
  buildComparisonUserContent,
} from '../lib/prompts.js';
import { pruneComparisonItems, verifyComparisonSources } from '../lib/text.js';
import { db, saveComparison, listComparisons } from '../lib/storage.js';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const { runComparison } = await import('../lib/api.js');

function toolUseResponse(input, { stop_reason = 'tool_use', usage = { input_tokens: 500, output_tokens: 200 } } = {}) {
  return {
    stop_reason,
    usage,
    content: [{ type: 'tool_use', name: 'record_comparison', input }],
  };
}

const MODULES = ['overview', 'methodology', 'data', 'reproducibility', 'limitations'];

// Builds a realistic full 5-module analysis-item set for N mock papers, the
// same shape ComparePage.jsx assembles from getAnalyses() before calling
// runComparison — enough items per module to resemble a real analyzed paper.
function buildFullPapers(paperCount, itemsPerModule = 4) {
  const items = [];
  for (let p = 0; p < paperCount; p++) {
    const paperId = `paper-${p}`;
    for (const module of MODULES) {
      for (let i = 0; i < itemsPerModule; i++) {
        items.push({
          paperId,
          paperTitle: `Paper ${p}`,
          itemId: `${module}-item-${i}`,
          module,
          title: `${module} finding ${i}`,
          claim: `Paper ${p}'s ${module} claim number ${i} describes a specific, distinct result.`,
          kind: i === itemsPerModule - 1 ? 'not_mentioned' : 'fact',
          verificationStatus: i === itemsPerModule - 1 ? 'unavailable' : 'exact',
          verified: i !== itemsPerModule - 1,
        });
      }
    }
  }
  return items;
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('1. comparison stop_reason=max_tokens must not resolve as success', () => {
  it('runComparison rejects instead of returning truncated data', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ findings: [] }, { stop_reason: 'max_tokens' }));
    const items = buildFullPapers(2);
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' })
    ).rejects.toThrow();
  });

  it('uses a comparison-specific message, not the single-paper-analysis wording', async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse({ findings: [] }, { stop_reason: 'max_tokens' }));
    const items = buildFullPapers(2);
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' })
    ).rejects.toThrow('比較結果太長');
    // The analysis-specific wording talks about re-reading the PDF /
    // narrowing which content is excluded — nonsensical for comparison,
    // which never re-reads any PDF at all.
    try {
      mockCreate.mockResolvedValueOnce(toolUseResponse({ findings: [] }, { stop_reason: 'max_tokens' }));
      await runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' });
    } catch (err) {
      expect(err.message).not.toContain('縮小分析範圍');
      expect(err.message).not.toContain('排除以外的內容');
    }
  });
});

describe('2. a truncated tool_use input is never saved as a partial comparison', () => {
  it('rejects even when the (incomplete) tool input is a structurally valid but empty object', async () => {
    // This is the exact shape a max_tokens cutoff mid-tool-call produces:
    // stop_reason is max_tokens, but `input` can still look "valid" (e.g.
    // `{}`, or `{ findings: [] }`) — it must never reach the caller as a
    // usable result for saveComparison() to persist.
    mockCreate.mockResolvedValueOnce(toolUseResponse({}, { stop_reason: 'max_tokens' }));
    const items = buildFullPapers(2);
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' })
    ).rejects.toThrow('比較結果太長');
  });
});

describe('3. 2 papers x full 5/5-module analyses: prompt builds fine, runComparison succeeds', () => {
  it('builds a non-crashing prompt and completes successfully with a realistic budget', async () => {
    const items = buildFullPapers(2);
    expect(() => buildComparisonUserContent(pruneComparisonItems(items), '')).not.toThrow();

    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          {
            title: '共識發現',
            type: 'consensus',
            summary: '兩篇論文都指出類似的結果。',
            sources: [
              { paperId: 'paper-0', itemId: 'overview-item-0' },
              { paperId: 'paper-1', itemId: 'overview-item-0' },
            ],
          },
        ],
        comparisonStatus: 'compared',
      })
    );
    const result = await runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' });
    expect(result.data.findings).toHaveLength(1);
    expect(result.stopReason).toBe('tool_use');

    // The comparison-specific budget must actually be used, not the old,
    // smaller 4096 value.
    const requestArgs = mockCreate.mock.calls[0][0];
    expect(requestArgs.max_tokens).toBeGreaterThan(4096);
  });
});

describe('4. 10 papers x full 5/5-module analyses: prompt builder does not crash', () => {
  it('handles the maximum supported paper count without throwing', () => {
    const items = buildFullPapers(10);
    const pruned = pruneComparisonItems(items);
    expect(() => buildComparisonUserContent(pruned, '')).not.toThrow();

    // Paper attribution stays correct after pruning: every distinct
    // paperId from the input is still represented.
    const paperIdsIn = new Set(items.map((it) => it.paperId));
    const paperIdsOut = new Set(pruned.map((it) => it.paperId));
    expect(paperIdsOut).toEqual(paperIdsIn);

    // Source IDs (paperId::itemId) stay unique — no duplicate item ids
    // collide across different papers after pruning.
    const keys = pruned.map((it) => `${it.paperId}::${it.itemId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('malformed items mixed into a 10-paper batch do not break the whole batch', () => {
    const items = buildFullPapers(10);
    // Simulate a couple of malformed entries that could in principle slip
    // through upstream code (missing claim, non-string module) — prune
    // must not throw on these, and must not silently corrupt neighboring
    // valid items.
    items.push({ paperId: 'paper-0', module: 'overview', itemId: 'bad-1', claim: undefined, kind: 'fact' });
    items.push({ paperId: 'paper-1', module: null, itemId: 'bad-2', claim: 'x', kind: 'fact' });
    expect(() => pruneComparisonItems(items)).not.toThrow();
    const pruned = pruneComparisonItems(items);
    expect(pruned.length).toBeGreaterThan(0);
  });
});

describe('5. comparison result count is guided by the prompt, not brute-truncated in code', () => {
  it('the system prompt instructs a default cap of about 4-5 findings per category', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('4-5 個');
  });

  it('the system prompt asks for a narrower result set when a focus question is given', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('有聚焦問題時，只產生跟該問題直接相關的發現');
  });

  it('buildComparisonUserContent reinforces narrow scoping for a focus question', () => {
    const content = buildComparisonUserContent(buildFullPapers(1), '延遲表現');
    expect(content).toContain('只回答與這個問題直接相關的比較');
  });
});

describe('6. contradiction is not triggered merely by different methods/scope', () => {
  it('the prompt explicitly classifies method/scope differences as `difference`, not `contradiction`', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('A 用方法 X、B 用方法 Y');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('這些都應該標成 difference，不是 contradiction');
  });

  it('contradiction is reserved for the same question/condition with incompatible results', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('只用於兩篇論文針對「同一個問題、同一個現象、或同類條件」提出實質不相容的結果或結論');
  });
});

describe('7. the `difference` type is fully wired end-to-end', () => {
  it('is part of the shared type list and has a Chinese label', () => {
    expect(COMPARISON_TYPES).toContain('difference');
    expect(COMPARISON_TYPE_LABELS.difference).toBe('差異');
  });

  it('is a valid value in the tool schema enum', () => {
    const typeSchema = COMPARISON_TOOL.input_schema.properties.findings.items.properties.type;
    expect(typeSchema.enum).toEqual(COMPARISON_TYPES);
    expect(typeSchema.enum).toContain('difference');
  });

  it('verifyComparisonSources treats a `difference` finding exactly like any other type (type is passed through untouched)', () => {
    const validKeys = new Set(['paper-0::item-1']);
    const findings = [
      { title: 'Different scopes', type: 'difference', summary: '...', sources: [{ paperId: 'paper-0', itemId: 'item-1' }] },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].type).toBe('difference');
    expect(result[0].sources).toHaveLength(1);
  });

  it('old comparison records containing only consensus/contradiction/research_gap (no difference) still carry a recognized type', () => {
    // Old data predates the `difference` type entirely — every type it
    // could contain must still be in COMPARISON_TYPE_LABELS so the UI
    // renders a real label instead of falling back to the raw type string.
    for (const type of ['consensus', 'contradiction', 'research_gap']) {
      expect(COMPARISON_TYPE_LABELS[type]).toBeDefined();
    }
  });
});

describe('8. source validation still works after the input-pruning changes', () => {
  it('a source pointing at a pruned-away duplicate claim is correctly rejected as unverified', () => {
    const items = [
      { paperId: 'paper-0', module: 'overview', itemId: 'item-1', claim: 'Same claim text.', kind: 'fact' },
      { paperId: 'paper-0', module: 'overview', itemId: 'item-2', claim: 'Same claim text.', kind: 'fact' },
    ];
    const pruned = pruneComparisonItems(items);
    expect(pruned).toHaveLength(1); // item-2 is a duplicate claim, pruned away
    const validKeys = new Set(pruned.map((it) => `${it.paperId}::${it.itemId}`));
    // Claude citing the pruned-away item-2 must be rejected, since it was
    // never actually shown to the model after pruning.
    const findings = [
      { title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'paper-0', itemId: 'item-2' }] },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toEqual([]);
    expect(result[0].unverifiedSourceCount).toBe(1);
  });
});

describe('9. hallucinated source IDs are still filtered out end-to-end', () => {
  it('runComparison result has hallucinated sources stripped once verifyComparisonSources is applied', async () => {
    const items = buildFullPapers(2);
    const pruned = pruneComparisonItems(items);
    const validKeys = new Set(pruned.map((it) => `${it.paperId}::${it.itemId}`));

    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          {
            title: 'Fabricated',
            type: 'consensus',
            summary: 'S',
            sources: [{ paperId: 'paper-0', itemId: 'this-item-does-not-exist' }],
          },
        ],
        comparisonStatus: 'compared',
      })
    );
    const result = await runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' });
    const verified = verifyComparisonSources(result.data.findings, validKeys);
    expect(verified[0].sources).toEqual([]);
    expect(verified[0].unverifiedSourceCount).toBe(1);
  });
});

describe('10. an API failure during comparison never deletes existing saved comparisons', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.comparisons.clear();
  });

  it('an earlier successful comparison survives a later failed comparison attempt', async () => {
    const saved = await saveComparison({
      paperIds: ['paper-0', 'paper-1'],
      findings: [{ title: 'Earlier good result', type: 'consensus', summary: 'S', sources: [] }],
      status: 'done',
    });

    mockCreate.mockResolvedValueOnce(toolUseResponse({ findings: [] }, { stop_reason: 'max_tokens' }));
    const items = buildFullPapers(2);
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' })
    ).rejects.toThrow();

    const list = await listComparisons();
    expect(list.find((c) => c.id === saved.id)).toBeDefined();
    expect(list.find((c) => c.id === saved.id).findings[0].title).toBe('Earlier good result');
  });

  it('a generic API error (not max_tokens) also leaves existing comparisons untouched', async () => {
    const saved = await saveComparison({
      paperIds: ['paper-0', 'paper-1'],
      findings: [{ title: 'Still here', type: 'consensus', summary: 'S', sources: [] }],
      status: 'done',
    });

    mockCreate.mockRejectedValueOnce(new Error('network error'));
    const items = buildFullPapers(2);
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' })
    ).rejects.toThrow('network error');

    const list = await listComparisons();
    expect(list.find((c) => c.id === saved.id)).toBeDefined();
  });
});

describe('pruneComparisonItems (pure function)', () => {
  it('drops exact-duplicate claims within the same paper+module group', () => {
    const items = [
      { paperId: 'p0', module: 'overview', itemId: 'i1', claim: 'Same text.', kind: 'fact' },
      { paperId: 'p0', module: 'overview', itemId: 'i2', claim: 'Same text.', kind: 'fact' },
      { paperId: 'p0', module: 'overview', itemId: 'i3', claim: 'Different text.', kind: 'fact' },
    ];
    const result = pruneComparisonItems(items);
    expect(result).toHaveLength(2);
    expect(result.map((it) => it.itemId)).toEqual(['i1', 'i3']);
  });

  it('does not dedupe identical claims across different papers or different modules', () => {
    const items = [
      { paperId: 'p0', module: 'overview', itemId: 'i1', claim: 'Same text.', kind: 'fact' },
      { paperId: 'p1', module: 'overview', itemId: 'i2', claim: 'Same text.', kind: 'fact' },
      { paperId: 'p0', module: 'methodology', itemId: 'i3', claim: 'Same text.', kind: 'fact' },
    ];
    const result = pruneComparisonItems(items);
    expect(result).toHaveLength(3);
  });

  it('caps not_mentioned items per paper+module group without touching fact/inference items', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({
        paperId: 'p0',
        module: 'reproducibility',
        itemId: `nm-${i}`,
        claim: `Gap number ${i}.`,
        kind: 'not_mentioned',
      })),
      { paperId: 'p0', module: 'reproducibility', itemId: 'fact-1', claim: 'A real fact.', kind: 'fact' },
    ];
    const result = pruneComparisonItems(items, { maxNotMentionedPerGroup: 3 });
    const notMentioned = result.filter((it) => it.kind === 'not_mentioned');
    expect(notMentioned).toHaveLength(3);
    expect(result.some((it) => it.kind === 'fact')).toBe(true);
  });

  it('never removes a group down to zero items just because they are all not_mentioned and over cap', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      paperId: 'p0',
      module: 'limitations',
      itemId: `nm-${i}`,
      claim: `Gap ${i}.`,
      kind: 'not_mentioned',
    }));
    const result = pruneComparisonItems(items, { maxNotMentionedPerGroup: 2 });
    expect(result.length).toBe(2);
    expect(result.length).toBeGreaterThan(0);
  });
});
