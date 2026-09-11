// Regression tests for "跨篇比較產生空結果" — comparing 2 fully-analyzed,
// genuinely-related papers produced a saved comparison with ZERO cards, no
// API error, no max_tokens truncation.
//
// Root-cause audit (see CLAUDE.md for the full writeup): tracing the whole
// pipeline (selected papers → saved analyses → isAnalysisCompleted →
// pruneComparisonItems → comparison prompt → Claude raw tool-use output →
// parse → normalize → type validation → source-ID validation →
// verifyComparisonSources → final items → saveComparison → UI render)
// found NO existing code path that drops a non-empty `findings` array down
// to zero — verifyComparisonSources never removed a whole finding (only
// individual bad source IDs), and nothing validated `finding.type` against
// COMPARISON_TYPES at all (so `difference` was never at risk of being
// silently dropped by a stale 3-type check — there wasn't one). That means
// the most likely explanation for the reported empty result is Claude's
// OWN raw output being empty or near-empty — the rewritten
// COMPARISON_SYSTEM_PROMPT from the previous round leaned hard on
// hallucination-avoidance language ("寧可少而準", strict contradiction
// gating) without ever saying it's fine — expected, even — to report a few
// genuine, imperfect findings. This round:
//   1. Adds prompts.js: normalizeComparisonFindings() — the same kind of
//      per-item shape/type validation normalizeAnalysisItems() already
//      does for analysis items, wired into api.js's normalizeStructuredData
//      so it's impossible for a future stale-type-list bug to silently
//      eat `difference` findings (COMPARISON_TYPES is the one place the
//      enum is defined AND the one place it's checked).
//   2. Adds text.js: dropUnsourcedComparisonFindings() — rejects a whole
//      finding only when it ends up with ZERO valid sources after
//      verifyComparisonSources (not for merely having SOME invalid
//      sources — those are just stripped, per the existing behavior).
//   3. ComparePage.jsx now distinguishes "Claude legitimately returned 0
//      findings" (a save-able outcome) from "Claude tried, but everything
//      got filtered out during local processing" (a processing error —
//      thrown, not saved, so it never looks like a silent, confident "no
//      overlap" to the user).
//   4. COMPARISON_SYSTEM_PROMPT gained an explicit rule (rule 8) telling
//      Claude that "少而準" is not "empty", and that even a modest
//      thematic/application-domain overlap is enough basis for at least
//      one consensus or difference finding.
//   5. The empty-state copy no longer claims "沒有發現任何共識、矛盾或研究
//      缺口" (overstates AI certainty, and omits the newer 差異 type) —
//      see ComparePage.jsx's render for the corrected wording (not
//      component-tested, per this project's established testing
//      philosophy — see comparison.test.js's header comment).
//
// This file mocks @anthropic-ai/sdk entirely (no real API calls).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  COMPARISON_SYSTEM_PROMPT,
  COMPARISON_TYPES,
  COMPARISON_TOOL,
  normalizeComparisonFindings,
  buildComparisonUserContent,
} from '../lib/prompts.js';
import { verifyComparisonSources, dropUnsourcedComparisonFindings, pruneComparisonItems } from '../lib/text.js';

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

beforeEach(() => {
  mockCreate.mockReset();
});

describe('normalizeComparisonFindings (per-finding shape/type validation)', () => {
  it('keeps a well-formed finding of every current type, including `difference`', () => {
    const raw = COMPARISON_TYPES.map((type, i) => ({
      title: `T${i}`,
      type,
      summary: 'S',
      sources: [{ paperId: 'p0', itemId: `item-${i}` }],
    }));
    const { findings, rejections } = normalizeComparisonFindings(raw);
    expect(findings).toHaveLength(COMPARISON_TYPES.length);
    expect(findings.map((f) => f.type)).toEqual(COMPARISON_TYPES);
    expect(rejections).toHaveLength(0);
  });

  it('does NOT reject a `difference` finding — there is no stale type list anywhere in this pipeline', () => {
    const raw = [{ title: 'Different scope', type: 'difference', summary: 'S', sources: [{ paperId: 'p0', itemId: 'i1' }] }];
    const { findings, rejections } = normalizeComparisonFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('difference');
    expect(rejections).toHaveLength(0);
  });

  it('rejects a finding whose type is outside COMPARISON_TYPES, with a recorded reason', () => {
    const raw = [{ title: 'T', type: 'not_a_real_type', summary: 'S', sources: [] }];
    const { findings, rejections } = normalizeComparisonFindings(raw);
    expect(findings).toHaveLength(0);
    expect(rejections).toEqual([{ index: 0, reason: 'invalid_type', value: 'not_a_real_type' }]);
  });

  it('rejects a non-object entry and a finding missing title/summary, without crashing', () => {
    const raw = [
      null,
      'not an object',
      { type: 'consensus', summary: 'S', sources: [] }, // missing title
      { title: 'T', type: 'consensus', sources: [] }, // missing summary
    ];
    const { findings, rejections } = normalizeComparisonFindings(raw);
    expect(findings).toHaveLength(0);
    expect(rejections.map((r) => r.reason)).toEqual(['not_an_object', 'not_an_object', 'missing_title', 'missing_summary']);
  });

  it('drops individually malformed source entries but keeps the finding itself', () => {
    const raw = [
      {
        title: 'T',
        type: 'consensus',
        summary: 'S',
        sources: [{ paperId: 'p0', itemId: 'i1' }, { paperId: 'p0' }, null, 'not an object'],
      },
    ];
    const { findings } = normalizeComparisonFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].sources).toEqual([{ paperId: 'p0', itemId: 'i1' }]);
  });

  it('treats a non-array input the same way normalizeAnalysisItems treats non-array items', () => {
    expect(normalizeComparisonFindings(null)).toEqual({
      findings: [],
      rejections: [{ index: null, reason: 'findings_not_an_array', value: 'object' }],
    });
  });
});

describe('dropUnsourcedComparisonFindings (whole-card rejection only for zero valid sources)', () => {
  it('keeps a finding with at least one valid source untouched', () => {
    const findings = [{ title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'p0', itemId: 'i1' }] }];
    const { kept, dropped } = dropUnsourcedComparisonFindings(findings);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('drops a finding whose sources array is empty after verification', () => {
    const findings = [
      { title: 'Grounded', type: 'consensus', summary: 'S', sources: [{ paperId: 'p0', itemId: 'i1' }] },
      { title: 'Fully hallucinated', type: 'difference', summary: 'S', sources: [] },
    ];
    const { kept, dropped } = dropUnsourcedComparisonFindings(findings);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('Grounded');
    expect(dropped).toEqual([{ index: 1, type: 'difference', reason: 'no_valid_sources_after_verification' }]);
  });

  it('applies the same rule to every type uniformly (consensus/difference/contradiction/shared_limitation/research_gap)', () => {
    const findings = COMPARISON_TYPES.map((type) => ({ title: 'T', type, summary: 'S', sources: [] }));
    const { kept, dropped } = dropUnsourcedComparisonFindings(findings);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(COMPARISON_TYPES.length);
  });

  it('a finding with SOME invalid sources but at least one valid one is kept, not dropped (partial invalidity != wholesale rejection)', () => {
    const validKeys = new Set(['p0::i1']);
    const raw = [{ title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'p0', itemId: 'i1' }, { paperId: 'p0', itemId: 'fabricated' }] }];
    const verified = verifyComparisonSources(raw, validKeys);
    expect(verified[0].sources).toEqual([{ paperId: 'p0', itemId: 'i1' }]);
    expect(verified[0].unverifiedSourceCount).toBe(1);
    const { kept, dropped } = dropUnsourcedComparisonFindings(verified);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });
});

describe('the prompt no longer pushes toward an empty result when papers genuinely overlap', () => {
  it('explicitly tells Claude that "少而準" does not mean "empty"', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('「少而準」不代表「應該回傳空結果」');
  });

  it('gives Claude a concrete bar for when a shared theme alone is enough for a consensus/difference finding', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('用穿戴式裝置的生理訊號偵測壓力／健康狀態');
  });

  it('restricts genuine near-empty output to truly unrelated paper sets', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('這些論文的重點清單彼此完全無關');
  });

  it('requires at least one source even for research_gap findings, in the tool schema description', () => {
    const sourcesSchema = COMPARISON_TOOL.input_schema.properties.findings.items.properties.sources;
    expect(sourcesSchema.description).toContain('每個 finding 至少要有 1 個來源，包括 research_gap');
  });
});

// Realistic mock mirroring the user's actual two papers:
//   Paper A: systematic review, wearable stress detection, multiple
//            physiological signals, real-world/usability challenges.
//   Paper B: scoping review, deep learning for PPG, stress detection is one
//            application, CNN/CRNN/Transformer/datasets focus, real-world
//            validation challenges.
// Both share a genuine thematic overlap (wearable physiological sensing for
// stress/health) despite very different emphases — exactly the case the
// reported bug said should NOT come back empty.
const paperA = {
  paperId: 'paper-A',
  paperTitle: 'Detection and monitoring of stress using wearables: a systematic review',
};
const paperB = {
  paperId: 'paper-B',
  paperTitle: 'A Scoping Review of Deep Learning Methods for Photoplethysmography Data',
};

function mockItem(paper, module, itemId, title, claim) {
  return {
    ...paper,
    itemId,
    module,
    title,
    claim,
    kind: 'fact',
    verificationStatus: 'exact',
    verified: true,
  };
}

const realisticItems = [
  mockItem(paperA, 'overview', 'a-ov-1', '研究目標', '本篇系統性回顧探討如何運用穿戴式裝置的生理訊號偵測壓力。'),
  mockItem(paperA, 'methodology', 'a-me-1', '涵蓋訊號類型', '納入的研究涵蓋心率變異度、皮膚電活動、皮膚溫度等多種生理訊號。'),
  mockItem(paperA, 'limitations', 'a-li-1', '真實世界挑戰', '多數研究在實驗室環境進行，真實世界部署的可行性與準確度仍待驗證。'),
  mockItem(paperB, 'overview', 'b-ov-1', '研究目標', '本篇範疇審查探討深度學習方法在 PPG 訊號分析上的應用。'),
  mockItem(paperB, 'methodology', 'b-me-1', '模型類型', '涵蓋的深度學習模型包含 CNN、CRNN 與 Transformer 架構。'),
  mockItem(paperB, 'data', 'b-da-1', '應用領域', '壓力偵測是被回顧研究中 PPG 深度學習模型的其中一項應用場景。'),
  mockItem(paperB, 'limitations', 'b-li-1', '真實世界驗證', '多數模型僅在受控資料集上驗證，缺乏真實世界情境下的驗證。'),
];

describe('7. realistic mock: two genuinely-related-but-different-focus papers must not come back empty', () => {
  it('the prompt builder handles the realistic item set without crashing, and includes both papers', () => {
    const pruned = pruneComparisonItems(realisticItems);
    const content = buildComparisonUserContent(pruned, '');
    expect(content).toContain('paper-A');
    expect(content).toContain('paper-B');
  });

  it('difference and consensus findings both survive the full local pipeline (type validation, source validation, no-source rejection)', async () => {
    const validKeys = new Set(realisticItems.map((it) => `${it.paperId}::${it.itemId}`));

    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          {
            title: '研究範圍不同',
            type: 'difference',
            summary: '兩篇研究範圍不同：A 以 stress detection 為核心，B 以 PPG deep learning 為核心。',
            sources: [
              { paperId: 'paper-A', itemId: 'a-ov-1' },
              { paperId: 'paper-B', itemId: 'b-ov-1' },
            ],
          },
          {
            title: '共同應用領域',
            type: 'consensus',
            summary: '兩篇都顯示 wearable physiological sensing 可支援 stress／health monitoring。',
            sources: [
              { paperId: 'paper-A', itemId: 'a-ov-1' },
              { paperId: 'paper-B', itemId: 'b-da-1' },
            ],
          },
          {
            title: '真實世界驗證挑戰',
            type: 'consensus',
            summary: '兩篇都指出目前的研究多半缺乏真實世界情境下的完整驗證。',
            sources: [
              { paperId: 'paper-A', itemId: 'a-li-1' },
              { paperId: 'paper-B', itemId: 'b-li-1' },
            ],
          },
        ],
        comparisonStatus: 'compared',
      })
    );

    const { data } = await runComparison({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-5',
      items: realisticItems,
      focusQuestion: '',
    });

    // Mirrors ComparePage.jsx's own derivation: source-ID validation, then
    // whole-card rejection only for zero remaining valid sources.
    const sourceVerified = verifyComparisonSources(data.findings, validKeys);
    const { kept, dropped } = dropUnsourcedComparisonFindings(sourceVerified);

    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(3);
    expect(kept.some((f) => f.type === 'difference')).toBe(true);
    expect(kept.filter((f) => f.type === 'consensus')).toHaveLength(2);
    // Source IDs are preserved through the whole pipeline, not stripped.
    const differenceFinding = kept.find((f) => f.type === 'difference');
    expect(differenceFinding.sources).toEqual([
      { paperId: 'paper-A', itemId: 'a-ov-1' },
      { paperId: 'paper-B', itemId: 'b-ov-1' },
    ]);
  });
});

describe('8. a comparison that "succeeds" but loses everything during local processing must not silently save empty', () => {
  it('scenario A: Claude legitimately returns 0 findings with a valid comparisonStatus/emptyReason — a legitimate, save-able empty result', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [],
        comparisonStatus: 'insufficient_overlap',
        emptyReason: '兩篇已保存分析在研究問題與分析面向上的重疊不足，無法形成可靠比較。',
      })
    );
    const { data, diagnostics } = await runComparison({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-5',
      items: realisticItems,
      focusQuestion: '',
    });
    const rawFindingCount = diagnostics?.rawItemCount ?? data.findings.length;
    expect(rawFindingCount).toBe(0);
    expect(data.comparisonStatus).toBe('insufficient_overlap');
    expect(data.emptyReason).toBe('兩篇已保存分析在研究問題與分析面向上的重疊不足，無法形成可靠比較。');
    // ComparePage.jsx's guard: rawFindingCount > 0 && kept.length === 0 → throw.
    // Here rawFindingCount is 0, so no throw — this is a legitimate save.
    const shouldThrow = rawFindingCount > 0 && dropUnsourcedComparisonFindings(verifyComparisonSources(data.findings, new Set())).kept.length === 0;
    expect(shouldThrow).toBe(false);
  });

  it('scenario B: Claude tries, but every finding cites only hallucinated source IDs — must be flagged as a processing error, not saved as empty', async () => {
    const validKeys = new Set(realisticItems.map((it) => `${it.paperId}::${it.itemId}`));
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          { title: 'Fabricated 1', type: 'consensus', summary: 'S', sources: [{ paperId: 'paper-A', itemId: 'does-not-exist' }] },
          { title: 'Fabricated 2', type: 'difference', summary: 'S', sources: [{ paperId: 'paper-B', itemId: 'also-fake' }] },
        ],
        comparisonStatus: 'compared',
      })
    );
    const { data, diagnostics } = await runComparison({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-5',
      items: realisticItems,
      focusQuestion: '',
    });
    const rawFindingCount = diagnostics?.rawItemCount ?? data.findings.length;
    const { kept } = dropUnsourcedComparisonFindings(verifyComparisonSources(data.findings, validKeys));
    expect(rawFindingCount).toBe(2);
    expect(kept).toHaveLength(0);
    // This is exactly the condition ComparePage.jsx uses to throw instead
    // of saving — a "successful" API call that produced nothing usable
    // after local validation is a processing error, not a real empty
    // comparison.
    const shouldThrow = rawFindingCount > 0 && kept.length === 0;
    expect(shouldThrow).toBe(true);
  });

  it('scenario C: Claude tries, all findings have an invalid `type` (fallback-JSON path ignoring the schema enum) — now caught even earlier, inside runComparison itself, via the comparisonStatus consistency check', async () => {
    // Claude honestly self-reports comparisonStatus="compared" (it believes
    // it produced 2 findings) — but both have a `type` outside
    // COMPARISON_TYPES, so normalizeComparisonFindings (api.js) strips both
    // during shape/type validation, leaving data.findings empty. That
    // leaves comparisonStatus="compared" internally inconsistent with the
    // post-normalization findings count of 0 — validateComparisonStatus
    // (prompts.js) catches this and runComparison() throws immediately,
    // before ComparePage.jsx would even get a `data` object to derive its
    // own raw>0/final=0 guard from. This is a strictly earlier catch of
    // the same underlying "malformed Claude output" problem class.
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          { title: 'T1', type: 'similarity', summary: 'S', sources: [{ paperId: 'paper-A', itemId: 'a-ov-1' }] },
          { title: 'T2', type: 'gap', summary: 'S', sources: [{ paperId: 'paper-B', itemId: 'b-ov-1' }] },
        ],
        comparisonStatus: 'compared',
      })
    );
    await expect(
      runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items: realisticItems, focusQuestion: '' })
    ).rejects.toThrow('AI 回傳的比較結果狀態不一致');
  });
});
