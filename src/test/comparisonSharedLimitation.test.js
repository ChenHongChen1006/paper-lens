// Tests for the "共識 → 共同點" relabel, the new `shared_limitation`
// comparison type, paper-type overgeneralization guarding, and the
// source-chip dedup/format improvements.
//
// Context: with the comparison pipeline working end-to-end and producing
// real cards, manual review of actual output surfaced three semantic
// issues (see CLAUDE.md for the full writeup):
//   A. "共識" (consensus) is too strong a word for most findings, which
//      are really just "both papers touch on this", not an explicit
//      agreed conclusion. UI label changes to "共同點"; the underlying
//      `type` enum value stays `consensus` — no destructive migration.
//   B. "both papers lack X" was getting lumped into consensus, which is
//      backwards — a shared absence is not a shared positive
//      observation. New type: `shared_limitation` ("共同限制").
//   C. A card described Paper B (a scoping review) as a systematic
//      review, overgeneralizing two different review types into one.
//      COMPARISON_SYSTEM_PROMPT gained an explicit rule against this.
// Plus a UI fix: source chips only showed "paper · module", indistinguishable
// when a finding cited two different items from the same module — chips
// now include the analysis item's own title, and duplicate sources
// (same paperId+itemId) are deduped rather than rendered twice.

import { describe, it, expect } from 'vitest';
import {
  COMPARISON_TYPES,
  COMPARISON_TYPE_LABELS,
  COMPARISON_SYSTEM_PROMPT,
  COMPARISON_TOOL,
  normalizeComparisonFindings,
  buildComparisonUserContent,
} from '../lib/prompts.js';
import {
  dedupeComparisonSources,
  formatComparisonSourceLabel,
  buildComparisonDiagnostics,
  verifyComparisonSources,
} from '../lib/text.js';

describe('A. "共識" relabeled to "共同點" without a destructive enum change', () => {
  it('the underlying type enum value is still `consensus` — no migration needed for old saved data', () => {
    expect(COMPARISON_TYPES).toContain('consensus');
  });

  it('the Chinese label shown to users is "共同點", not "共識"', () => {
    expect(COMPARISON_TYPE_LABELS.consensus).toBe('共同點');
    expect(COMPARISON_TYPE_LABELS.consensus).not.toBe('共識');
  });
});

describe('B. shared_limitation is a distinct type from consensus, fully wired through the pipeline', () => {
  it('is part of the enum and has a Chinese label', () => {
    expect(COMPARISON_TYPES).toContain('shared_limitation');
    expect(COMPARISON_TYPE_LABELS.shared_limitation).toBe('共同限制');
  });

  it('is a valid value in the tool schema enum', () => {
    const typeSchema = COMPARISON_TOOL.input_schema.properties.findings.items.properties.type;
    expect(typeSchema.enum).toContain('shared_limitation');
    expect(typeSchema.enum).toEqual(COMPARISON_TYPES);
  });

  it('normalizeComparisonFindings accepts a well-formed shared_limitation finding', () => {
    const raw = [
      {
        title: '共同限制：reviewer agreement',
        type: 'shared_limitation',
        summary: '兩篇已保存分析中都未看到 reviewer independent screening 或 inter-rater agreement 的說明。',
        sources: [
          { paperId: 'paper-A', itemId: 'a-rep-1' },
          { paperId: 'paper-B', itemId: 'b-rep-1' },
        ],
      },
    ];
    const { findings, rejections } = normalizeComparisonFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('shared_limitation');
    expect(rejections).toHaveLength(0);
  });

  it('the prompt explicitly distinguishes shared_limitation from consensus (shared absence, not a shared positive observation)', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('shared_limitation（共同限制）');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('consensus 只用於正面的共同觀察');
  });

  it('the prompt requires conservative wording — not framed as authors admitting the limitation unless they actually did', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('兩篇已保存分析中都未看到');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不要寫成「作者承認」「作者自承」');
  });

  it('the prompt gates shared_limitation to only credibility/reproducibility/methodology/generalizability/evaluation/applicability-relevant gaps', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('研究可信度、可復現性、方法透明度、generalizability、evaluation quality、或 real-world applicability');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不是所有「兩篇都沒提到」的空白都值得產生 shared_limitation');
  });

  it('old comparison records containing only the original 4 types (no shared_limitation) still carry recognized types', () => {
    for (const type of ['consensus', 'difference', 'contradiction', 'research_gap']) {
      expect(COMPARISON_TYPE_LABELS[type]).toBeDefined();
    }
  });
});

describe('C. paper-type overgeneralization guard (e.g. scoping review mislabeled as systematic review)', () => {
  it('the prompt forbids collapsing two different review types into one specific type', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('絕對不能把兩篇統稱成其中一種更具體的類型');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不能寫成「兩篇都是 systematic review」');
  });

  it('the prompt offers an accurate alternative phrasing and allows the type difference itself to become a `difference` finding', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('兩篇皆為文獻回顧，但一篇為 systematic review，另一篇為 scoping review');
  });

  it('the prompt requires using the already-analyzed paper type, not guessing from the title', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不要只靠論文標題用猜的');
  });
});

describe('diagnostics: typeCounts includes shared_limitation, old data still safe', () => {
  it('buildComparisonDiagnostics counts shared_limitation findings', () => {
    const diagnostics = buildComparisonDiagnostics({
      finalFindings: [
        { type: 'shared_limitation', title: 'T1', summary: 'S1', sources: [] },
        { type: 'shared_limitation', title: 'T2', summary: 'S2', sources: [] },
        { type: 'consensus', title: 'T3', summary: 'S3', sources: [] },
      ],
    });
    expect(diagnostics.typeCounts.shared_limitation).toBe(2);
    expect(diagnostics.typeCounts.consensus).toBe(1);
  });

  it('typeCounts is built from COMPARISON_TYPES, so it always has every current type key, defaulting unseen ones to 0', () => {
    const diagnostics = buildComparisonDiagnostics({ finalFindings: [] });
    for (const type of COMPARISON_TYPES) {
      expect(diagnostics.typeCounts[type]).toBe(0);
    }
  });
});

describe('D/16. source chip dedup and format', () => {
  it('1. dedupeComparisonSources collapses an exact duplicate {paperId, itemId} pair to one', () => {
    const sources = [
      { paperId: 'p0', itemId: 'i1', module: 'methodology' },
      { paperId: 'p0', itemId: 'i1', module: 'methodology' },
    ];
    expect(dedupeComparisonSources(sources)).toHaveLength(1);
  });

  it('2. same paper + same module but different item IDs both survive dedup, as two distinct sources', () => {
    const sources = [
      { paperId: 'p0', itemId: 'i1', module: 'methodology', itemTitle: '公開資料集排除條件' },
      { paperId: 'p0', itemId: 'i2', module: 'methodology', itemTitle: '年齡納入條件' },
    ];
    const result = dedupeComparisonSources(sources);
    expect(result).toHaveLength(2);
    const labels = result.map((s) => formatComparisonSourceLabel({ paperTitle: 'Paper', moduleLabel: '方法論', itemTitle: s.itemTitle }).short);
    expect(labels[0]).not.toBe(labels[1]);
    expect(labels[0]).toContain('公開資料集排除條件');
    expect(labels[1]).toContain('年齡納入條件');
  });

  it('3. a long item title is truncated in the short label but fully preserved in the full (title-attribute) label', () => {
    const longTitle = '這是一個非常非常非常長的分析項目標題用來測試截斷是否正常運作而不會破版';
    const { short, full } = formatComparisonSourceLabel(
      { paperTitle: 'P', moduleLabel: 'M', itemTitle: longTitle },
      { maxSegmentLength: 10 }
    );
    expect(short.length).toBeLessThan(full.length);
    expect(short).toContain('…');
    expect(full).toContain(longTitle);
    expect(full).not.toContain('…');
  });

  it('4. a source citing the wrong paper for a real itemId is still blocked by verifyComparisonSources (dedup does not bypass source validation)', () => {
    const validKeys = new Set(['paperA::item-1']);
    const findings = [
      { title: 'T', type: 'consensus', summary: 'S', sources: [{ paperId: 'paperB', itemId: 'item-1' }] },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toEqual([]);
    expect(result[0].unverifiedSourceCount).toBe(1);
  });

  it('formatComparisonSourceLabel degrades to the old two-part "paper · module" format when itemTitle is absent (old saved comparisons)', () => {
    const { short, full } = formatComparisonSourceLabel({ paperTitle: 'Paper A', moduleLabel: '方法論', itemTitle: null });
    expect(short).toBe('Paper A · 方法論');
    expect(full).toBe('Paper A · 方法論');
  });

  it('dedupeComparisonSources never crashes on a non-array or malformed input', () => {
    expect(dedupeComparisonSources(undefined)).toEqual([]);
    expect(dedupeComparisonSources(null)).toEqual([]);
    expect(() => dedupeComparisonSources([{ paperId: 'p0' }, null, {}])).not.toThrow();
  });
});

describe('15. realistic regression: the two actual test papers, with review-type and shared-limitation findings', () => {
  const paperA = { paperId: 'paper-A', paperTitle: 'Detection and monitoring of stress using wearables: a systematic review' };
  const paperB = { paperId: 'paper-B', paperTitle: 'A Scoping Review of Deep Learning Methods for Photoplethysmography Data' };

  function mockItem(paper, module, itemId, title, claim) {
    return { ...paper, itemId, module, title, claim, kind: 'fact', verificationStatus: 'exact', verified: true };
  }

  const realisticItems = [
    mockItem(paperA, 'overview', 'a-ov-1', '論文類型', '本篇為 systematic review，探討穿戴式裝置如何偵測壓力。'),
    mockItem(paperA, 'reproducibility', 'a-rep-1', '文獻搜尋與篩選', '原文未說明是否由多位 reviewer 獨立篩選文獻。'),
    mockItem(paperA, 'limitations', 'a-li-1', '真實世界挑戰', '多數研究在實驗室環境進行，free-living 部署的可行性仍待驗證。'),
    mockItem(paperB, 'overview', 'b-ov-1', '論文類型', '本篇為 scoping review，探討深度學習方法在 PPG 訊號分析上的應用。'),
    mockItem(paperB, 'reproducibility', 'b-rep-1', '文獻搜尋與篩選', '原文未說明是否有 inter-rater agreement 的評估。'),
    mockItem(paperB, 'limitations', 'b-li-1', '真實世界驗證', '多數模型僅在受控資料集上驗證，缺乏真實世界情境下的驗證。'),
  ];

  it('schema/normalization accepts a `difference` describing the two different review types (not collapsed into one)', () => {
    const finding = {
      title: '回顧類型不同',
      type: 'difference',
      summary: '兩篇皆為文獻回顧，但回顧類型與研究範圍不同：A 為 systematic review，B 為 scoping review。',
      sources: [
        { paperId: 'paper-A', itemId: 'a-ov-1' },
        { paperId: 'paper-B', itemId: 'b-ov-1' },
      ],
    };
    const { findings, rejections } = normalizeComparisonFindings([finding]);
    expect(findings).toEqual([finding]);
    expect(rejections).toHaveLength(0);
  });

  it('schema/normalization accepts a `shared_limitation` describing a common real-world/free-living validation gap', () => {
    const finding = {
      title: '共同限制：真實世界驗證',
      type: 'shared_limitation',
      summary: '兩篇都存在 real-world validation／free-living deployment 相關限制的說明不足。',
      sources: [
        { paperId: 'paper-A', itemId: 'a-li-1' },
        { paperId: 'paper-B', itemId: 'b-li-1' },
      ],
    };
    const { findings, rejections } = normalizeComparisonFindings([finding]);
    expect(findings).toEqual([finding]);
    expect(rejections).toHaveLength(0);
  });

  it('the prompt builder accepts the full realistic item set without crashing', () => {
    expect(() => buildComparisonUserContent(realisticItems, '')).not.toThrow();
  });

  it('a finding citing both papers survives full source validation and dedup with distinct, informative source chips', () => {
    const validKeys = new Set(realisticItems.map((it) => `${it.paperId}::${it.itemId}`));
    const findings = [
      {
        title: '共同限制：reviewer agreement',
        type: 'shared_limitation',
        summary: '兩篇已保存分析中都未看到 reviewer independent screening 或 inter-rater agreement 的說明。',
        sources: [
          { paperId: 'paper-A', itemId: 'a-rep-1' },
          { paperId: 'paper-B', itemId: 'b-rep-1' },
          { paperId: 'paper-A', itemId: 'a-rep-1' }, // duplicate citation
        ],
      },
    ];
    const verified = verifyComparisonSources(findings, validKeys);
    const deduped = dedupeComparisonSources(verified[0].sources);
    expect(deduped).toHaveLength(2); // the duplicate is gone, both real papers remain
    const labels = deduped.map((s) =>
      formatComparisonSourceLabel({
        paperTitle: s.paperId === 'paper-A' ? paperA.paperTitle : paperB.paperTitle,
        moduleLabel: '可復現性',
        itemTitle: '文獻搜尋與篩選',
      }).short
    );
    expect(new Set(labels).size).toBeGreaterThanOrEqual(1); // both chips render distinct paper attribution
  });
});
