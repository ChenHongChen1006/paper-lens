// Tests for cross-paper comparison source provenance validation.
//
// History (see CLAUDE.md for the full writeup):
//   Round N-1: manual review found comparison findings citing real,
//   valid analysis item IDs whose content had nothing to do with the
//   finding (e.g. a "wearable sensing application potential" finding
//   citing a "literature search date range" item). The fix added a
//   second layer: Claude had to echo back the cited item's exact claim
//   text (`sourceClaim`), and a local check rejected any source whose
//   echo didn't match the real stored claim (whitespace-normalized).
//
//   Round N: with 2 fully-analyzed real papers, Claude produced 9 raw
//   findings and ALL 9 were rejected — "比較處理過程發生異常...（原始 9
//   筆，驗證後可用 0 筆）". The sourceClaim exact-match check was almost
//   certainly the cause: requiring a language model to reproduce a claim
//   BYTE-FOR-BYTE (even after whitespace normalization) is extremely
//   fragile — trivial rewording, punctuation variants, or the model
//   summarizing instead of copying verbatim all trigger it, and none of
//   that means the citation was actually wrong. Worse, it added no real
//   defense against the ORIGINAL problem: a model willing to cite an
//   irrelevant-but-real ID could just as easily copy that irrelevant
//   item's claim text exactly (which is legitimate content, just not
//   relevant) — the check never could distinguish "real but irrelevant"
//   from "real and relevant" in the first place.
//
//   This round REMOVES the sourceClaim mechanism entirely. What's left,
//   deliberately kept simple and robust:
//     1. Source ID whitelist validation (verifyComparisonSources) — a
//        cited {paperId, itemId} must be a real item that was actually
//        sent to Claude. This is the ONLY automated correctness check.
//     2. resolveComparisonSource / buildComparisonSourceIndex — every
//        display field (title, claim, module, ...) for a validated source
//        comes from THIS APP'S OWN stored data, never from anything
//        Claude's response contains. Claude is only ever trusted for
//        {paperId, itemId}.
//     3. dropSinglePaperFindings — a "cross-paper" finding needs sources
//        from at least 2 different papers.
//     4. The prompt still requires "select relevant sources before
//        writing the finding" (kept from the previous round) — this is
//        the only lever left for relevance, since no code here can prove
//        semantic relevance without a second AI call, which the user
//        explicitly does not want spent automatically.
//
// This file mocks @anthropic-ai/sdk entirely (no real API calls).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  COMPARISON_TOOL,
  COMPARISON_SYSTEM_PROMPT,
  buildComparisonUserContent,
} from '../lib/prompts.js';
import {
  verifyComparisonSources,
  dropSinglePaperFindings,
  dropUnsourcedComparisonFindings,
  dedupeComparisonSources,
  buildComparisonSourceIndex,
  resolveComparisonSource,
} from '../lib/text.js';

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

beforeEach(() => {
  mockCreate.mockReset();
});

// Mirrors the actual two test papers used throughout manual QA.
const paperA = { paperId: 'paper-A', paperTitle: 'Detection and monitoring of stress using wearables: a systematic review' };
const paperB = { paperId: 'paper-B', paperTitle: 'A Scoping Review of Deep Learning Methods for Photoplethysmography Data' };

function mockItem(paper, module, itemId, title, claim) {
  return { ...paper, itemId, module, title, claim, kind: 'fact', verificationStatus: 'exact', verified: true };
}

const items = [
  mockItem(paperA, 'limitations', 'a-li-1', '真實世界驗證缺口', '作者指出目前缺乏外部與真實世界驗證，可穿戴裝置在自由生活場域的長期表現仍待確認。'),
  mockItem(paperB, 'limitations', 'b-li-1', '真實世界驗證挑戰', '多數研究僅在受控環境測試，free-living 或即時運算表現仍是目前待解決的挑戰。'),
  mockItem(paperA, 'reproducibility', 'a-rep-1', '文獻搜尋日期範圍', '文獻搜尋涵蓋 2015 年 1 月至 2023 年 12 月的文獻。'),
  mockItem(paperA, 'methodology', 'a-me-1', '年齡納入條件', '研究範圍：只納入 18 至 60 歲的參與者。'),
  mockItem(paperB, 'reproducibility', 'b-rep-1', 'PRISMA 文獻回顧方法', '本篇依循 PRISMA 指引進行系統性文獻回顧流程。'),
];
const validKeys = new Set(items.map((it) => `${it.paperId}::${it.itemId}`));
const sourceIndex = buildComparisonSourceIndex(items);

describe('1. a valid sourceId is kept even with no sourceClaim field at all', () => {
  it('a bare {paperId, itemId} source (no sourceClaim, matching the current tool schema) passes ID validation', () => {
    const findings = [{ title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'paper-A', itemId: 'a-li-1' }] }];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toHaveLength(1);
    expect(result[0].unverifiedSourceCount).toBe(0);
  });
});

describe('2. a sourceClaim differing from the stored claim in punctuation/Unicode no longer causes rejection', () => {
  it('a source with a sourceClaim field that does NOT match the stored claim is still kept — the mechanism that would reject it was removed', () => {
    const findings = [
      {
        title: 'T',
        type: 'shared_limitation',
        summary: 'S',
        // Old-shape input some caller might still send (harmless leftover
        // field) — full-width punctuation, reordered, doesn't matter.
        sources: [{ paperId: 'paper-A', itemId: 'a-li-1', sourceClaim: '作者說沒有做真實世界驗證（完全不同的敘述）。' }],
      },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toHaveLength(1);
    expect(result[0].unverifiedSourceCount).toBe(0);
  });
});

describe('3. the UI-facing claim always comes from local storage, never from Claude, even if Claude sends a sourceClaim', () => {
  it('resolveComparisonSource returns the real stored claim, completely ignoring anything on the cited source object', () => {
    const claudesSource = { paperId: 'paper-A', itemId: 'a-li-1', sourceClaim: '一段 Claude 自己編出來、完全錯誤的敘述。' };
    const resolved = resolveComparisonSource(sourceIndex, claudesSource);
    expect(resolved.claim).toBe('作者指出目前缺乏外部與真實世界驗證，可穿戴裝置在自由生活場域的長期表現仍待確認。');
    expect(resolved.claim).not.toContain('編出來');
  });
});

describe('4. an invalid sourceId is still rejected', () => {
  it('a fabricated itemId is dropped even though paperId is real', () => {
    const findings = [{ title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'paper-A', itemId: 'does-not-exist' }] }];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toEqual([]);
    expect(result[0].unverifiedSourceCount).toBe(1);
  });

  it('a real itemId cited under the wrong paperId is dropped (cross-paper ID mix-up)', () => {
    const findings = [{ title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'paper-B', itemId: 'a-li-1' }] }];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toEqual([]);
  });

  it('resolveComparisonSource returns null for a key with no matching item', () => {
    expect(resolveComparisonSource(sourceIndex, { paperId: 'paper-A', itemId: 'does-not-exist' })).toBeNull();
  });
});

describe('5. two valid sources from the SAME paper → finding rejected (not cross-paper)', () => {
  it('dropSinglePaperFindings rejects a finding whose sources are both from paper-A', () => {
    const findings = [
      { title: 'T', type: 'difference', summary: 'S', sources: [{ paperId: 'paper-A', itemId: 'a-li-1' }, { paperId: 'paper-A', itemId: 'a-me-1' }] },
    ];
    const { kept, dropped } = dropSinglePaperFindings(findings);
    expect(kept).toHaveLength(0);
    expect(dropped[0].reason).toBe('single_paper_source');
  });
});

describe('6. two valid sources from DIFFERENT papers → finding kept', () => {
  it('a finding with one source from paper-A and one from paper-B survives every filtering stage', () => {
    const findings = [
      { title: 'T', type: 'shared_limitation', summary: 'S', sources: [{ paperId: 'paper-A', itemId: 'a-li-1' }, { paperId: 'paper-B', itemId: 'b-li-1' }] },
    ];
    const idChecked = verifyComparisonSources(findings, validKeys);
    const { kept: withSources } = dropUnsourcedComparisonFindings(idChecked);
    const { kept: final } = dropSinglePaperFindings(withSources);
    expect(final).toHaveLength(1);
    expect(final[0].sources.map((s) => s.paperId).sort()).toEqual(['paper-A', 'paper-B']);
  });
});

describe('7. resolved source content always reflects the local stored claim', () => {
  it('mirrors ComparePage.jsx: mapping a kept source through resolveComparisonSource attaches the real itemTitle/itemClaim/module', () => {
    const kept = { paperId: 'paper-B', itemId: 'b-li-1' };
    const resolved = resolveComparisonSource(sourceIndex, kept);
    expect(resolved.itemTitle).toBe('真實世界驗證挑戰');
    expect(resolved.claim).toBe('多數研究僅在受控環境測試，free-living 或即時運算表現仍是目前待解決的挑戰。');
    expect(resolved.module).toBe('limitations');
    expect(resolved.paperTitle).toBe(paperB.paperTitle);
  });
});

describe('8. old `sourceIds: [...]` flat-array shape never existed in this codebase, but is handled gracefully if seen', () => {
  it('a finding with sourceIds instead of sources has no sources (defensive, not a crash) — this shape was never produced by any version of this app', () => {
    const findings = [{ title: 'T', type: 'consensus', summary: 'S', sourceIds: ['paper-A::a-li-1'] }];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toEqual([]);
  });
});

describe('9. old sources+sourceClaim shape (from the removed mechanism) reads back fine', () => {
  it('a legacy finding whose sources already have a stored sourceClaim field passes ID validation and ignores the extra field', () => {
    const findings = [
      { title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'paper-A', itemId: 'a-li-1', sourceClaim: 'legacy field, ignored' }] },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toHaveLength(1);
  });
});

describe('10. the actual regression: 9 raw findings, each with 2 valid cross-paper sourceIds, must NOT collapse to 0', () => {
  it('mirrors ComparePage.jsx\'s full pipeline with a realistic 9-finding batch — none should be rejected merely for lacking/mismatching sourceClaim', () => {
    const rawFindings = Array.from({ length: 9 }, (_, i) => ({
      title: `Finding ${i}`,
      type: i % 2 === 0 ? 'consensus' : 'difference',
      summary: `Summary ${i}`,
      sources: [
        { paperId: 'paper-A', itemId: i % 3 === 0 ? 'a-li-1' : i % 3 === 1 ? 'a-rep-1' : 'a-me-1' },
        { paperId: 'paper-B', itemId: i % 2 === 0 ? 'b-li-1' : 'b-rep-1' },
      ],
    }));
    const idChecked = verifyComparisonSources(rawFindings, validKeys).map((f) => ({
      ...f,
      sources: dedupeComparisonSources(f.sources),
    }));
    const { kept: withSources } = dropUnsourcedComparisonFindings(idChecked);
    const { kept: final } = dropSinglePaperFindings(withSources);
    expect(final).toHaveLength(9); // nothing lost — this is the actual regression this round fixes
  });

  it('end-to-end through runComparison: a mocked 9-finding response (no sourceClaim field, matching the current schema) is accepted as-is', async () => {
    const rawFindings = Array.from({ length: 9 }, (_, i) => ({
      title: `Finding ${i}`,
      type: 'consensus',
      summary: `Summary ${i}`,
      sources: [
        { paperId: 'paper-A', itemId: 'a-li-1' },
        { paperId: 'paper-B', itemId: 'b-li-1' },
      ],
    }));
    mockCreate.mockResolvedValueOnce(toolUseResponse({ findings: rawFindings, comparisonStatus: 'compared' }));
    const { data } = await runComparison({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', items, focusQuestion: '' });
    expect(data.findings).toHaveLength(9);
    const idChecked = verifyComparisonSources(data.findings, validKeys);
    const { kept: withSources } = dropUnsourcedComparisonFindings(idChecked);
    const { kept: final } = dropSinglePaperFindings(withSources);
    expect(final).toHaveLength(9);
  });
});

describe('prompt: "select sources first, write finding second" is kept; sourceClaim verbatim-copy instruction is removed', () => {
  it('still explicitly forbids writing the conclusion first and attaching plausible IDs afterward', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('寫作順序必須是「先選來源、再寫結論」，絕對不能反過來');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('先想好一句 comparison claim，再回頭從合法 ID 清單裡隨便找幾個看起來相關的來源掛上去湊數');
  });

  it('no longer asks Claude to copy claim text into sources', () => {
    expect(COMPARISON_SYSTEM_PROMPT).not.toContain('逐字複製');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('sources 只需要提供 paperId 跟 itemId 這兩個欄位，不需要複製 claim 內容');
  });

  it('still requires every finding to have sources from at least 2 different papers', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('每個 finding 的有效來源必須涵蓋至少 2 篇不同論文');
  });

  it('still tightens shared_limitation source selection to genuinely limitation-relevant items', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('shared_limitation 的來源要優先挑選真正在講限制／缺失的 items');
  });

  it('still does not let a missing meta-analysis/p-value be auto-treated as a weakness', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不代表這本身就是弱點');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('兩篇都沒有進行統計合併／meta-analysis');
  });
});

describe('tool schema: sources only require paperId + itemId (sourceClaim removed)', () => {
  it('the sources item schema requires only paperId and itemId', () => {
    const sourceSchema = COMPARISON_TOOL.input_schema.properties.findings.items.properties.sources;
    expect(sourceSchema.items.required).toEqual(['paperId', 'itemId']);
    expect(sourceSchema.items.properties.sourceClaim).toBeUndefined();
  });
});

describe('buildComparisonUserContent includes sourceScope/weaknessType when present, omits when absent', () => {
  it('includes sourceScope for a data-module item that has it', () => {
    const content = buildComparisonUserContent(
      [{ paperId: 'p0', paperTitle: 'P', itemId: 'i1', module: 'data', title: 'T', claim: 'C', kind: 'fact', verificationStatus: 'exact', verified: true, sourceScope: 'reviewed_studies' }],
      ''
    );
    expect(content).toContain('sourceScope="reviewed_studies"');
  });

  it('includes weaknessType for a limitations-module item that has it', () => {
    const content = buildComparisonUserContent(
      [{ paperId: 'p0', paperTitle: 'P', itemId: 'i1', module: 'limitations', title: 'T', claim: 'C', kind: 'fact', verificationStatus: 'exact', verified: true, weaknessType: 'author_limitation' }],
      ''
    );
    expect(content).toContain('weaknessType="author_limitation"');
  });

  it('omits both attributes entirely for an item without them (e.g. overview module) — no crash, no empty attribute', () => {
    const content = buildComparisonUserContent(
      [{ paperId: 'p0', paperTitle: 'P', itemId: 'i1', module: 'overview', title: 'T', claim: 'C', kind: 'fact', verificationStatus: 'exact', verified: true }],
      ''
    );
    expect(content).not.toContain('sourceScope=');
    expect(content).not.toContain('weaknessType=');
  });
});
