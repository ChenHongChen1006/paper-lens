// Tests for cross-paper comparison: selection bounds, source-ID
// validation (the main hallucination-prevention safeguard), the prompt's
// hallucination-prevention rules, and that saving/reloading comparisons
// and deleting a paper referenced by one never crashes or corrupts data.
//
// ComparePage.jsx itself is a React component and (per this project's
// existing testing approach — see CLAUDE.md) isn't component-tested; the
// logic it depends on is pulled into pure functions in text.js /
// storage.js specifically so it CAN be tested here without a DOM.

import { describe, it, expect, beforeEach } from 'vitest';
import { validateComparisonSelection, verifyComparisonSources, bestVerificationStatus } from '../lib/text.js';
import { COMPARISON_SYSTEM_PROMPT, COMPARISON_TOOL } from '../lib/prompts.js';
import {
  db,
  createPaper,
  saveAnalysis,
  saveComparison,
  listComparisons,
  deletePaper,
  exportBackup,
  importBackup,
} from '../lib/storage.js';

describe('validateComparisonSelection', () => {
  it('rejects fewer than 2 papers', () => {
    expect(validateComparisonSelection([]).valid).toBe(false);
    expect(validateComparisonSelection(['a']).valid).toBe(false);
    expect(validateComparisonSelection(['a']).reason).toBe('too_few');
  });

  it('accepts 2 to 10 papers', () => {
    expect(validateComparisonSelection(['a', 'b']).valid).toBe(true);
    expect(validateComparisonSelection(Array.from({ length: 10 }, (_, i) => `p${i}`)).valid).toBe(true);
  });

  it('rejects more than 10 papers', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `p${i}`);
    const result = validateComparisonSelection(eleven);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('too_many');
  });
});

// The segments below back the bestVerificationStatus tests: one sentence
// that can be found verbatim ("exact"), one whose closely-paraphrased
// evidence only reaches a fuzzy/partial match, and nothing at all for a
// "not_found" quote.
const segments = [
  { id: 'p1-s1', page: 1, text: 'This paper proposes a new scheme called FastCC that reduces tail latency.' },
];

describe('bestVerificationStatus (comparison source verification semantics)', () => {
  it('returns "exact" when at least one evidence quote verifies exact', () => {
    const evidence = [{ segmentId: 'p1-s1', page: 1, quote: 'reduces tail latency' }];
    expect(bestVerificationStatus(evidence, segments)).toBe('exact');
  });

  it('returns "partial" — NOT "exact" — for a close paraphrase that is not a verbatim match', () => {
    const evidence = [
      { segmentId: 'p1-s1', page: 1, quote: 'this paper proposes a novel scheme named FastCC that reduces the tail latency' },
    ];
    const status = bestVerificationStatus(evidence, segments);
    expect(status).toBe('partial');
    expect(status).not.toBe('exact');
  });

  it('returns "not_found" when no evidence quote can be matched anywhere', () => {
    const evidence = [{ segmentId: 'p1-s1', page: 1, quote: 'the moon is made of green cheese' }];
    expect(bestVerificationStatus(evidence, segments)).toBe('not_found');
  });

  it('returns "unavailable" when the item has no evidence at all', () => {
    expect(bestVerificationStatus([], segments)).toBe('unavailable');
    expect(bestVerificationStatus(undefined, segments)).toBe('unavailable');
  });

  it('picks the best status across multiple evidence entries (exact beats not_found)', () => {
    const evidence = [
      { segmentId: 'p1-s1', page: 1, quote: 'nothing like this exists in the text' },
      { segmentId: 'p1-s1', page: 1, quote: 'reduces tail latency' },
    ];
    expect(bestVerificationStatus(evidence, segments)).toBe('exact');
  });
});

describe('comparison "verified" flag must require exact, not just partial', () => {
  // Mirrors the exact derivation ComparePage.jsx uses when building the
  // items sent to the comparison prompt: verified = kind is fact AND
  // verificationStatus is exact. This guards against a prior bug where
  // "at least exact OR partial" was accepted as verified.
  function computeVerified(kind, evidence) {
    const verificationStatus = bestVerificationStatus(evidence, segments);
    return { verificationStatus, verified: kind === 'fact' && verificationStatus === 'exact' };
  }

  it('a fact item with an exact-matching quote is verified', () => {
    const result = computeVerified('fact', [{ segmentId: 'p1-s1', page: 1, quote: 'reduces tail latency' }]);
    expect(result.verificationStatus).toBe('exact');
    expect(result.verified).toBe(true);
  });

  it('a fact item with only a partial-matching quote is NOT verified', () => {
    const result = computeVerified('fact', [
      { segmentId: 'p1-s1', page: 1, quote: 'this paper proposes a novel scheme named FastCC that reduces the tail latency' },
    ]);
    expect(result.verificationStatus).toBe('partial');
    expect(result.verified).toBe(false);
  });

  it('a fact item with a not_found quote is not verified', () => {
    const result = computeVerified('fact', [{ segmentId: 'p1-s1', page: 1, quote: 'nonexistent sentence' }]);
    expect(result.verificationStatus).toBe('not_found');
    expect(result.verified).toBe(false);
  });

  it('an inference item is never verified even with an exact-matching supporting quote', () => {
    const result = computeVerified('inference', [{ segmentId: 'p1-s1', page: 1, quote: 'reduces tail latency' }]);
    expect(result.verificationStatus).toBe('exact');
    expect(result.verified).toBe(false);
  });

  it('an item with no evidence is unavailable and not verified', () => {
    const result = computeVerified('fact', []);
    expect(result.verificationStatus).toBe('unavailable');
    expect(result.verified).toBe(false);
  });
});

describe('verifyComparisonSources (hallucinated source ID protection)', () => {
  const validKeys = new Set(['paperA::item-1', 'paperA::item-2', 'paperB::item-1']);

  it('keeps sources that were actually in the input list', () => {
    const findings = [
      {
        title: 'Both papers agree',
        type: 'consensus',
        summary: '...',
        sources: [
          { paperId: 'paperA', itemId: 'item-1' },
          { paperId: 'paperB', itemId: 'item-1' },
        ],
      },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toHaveLength(2);
    expect(result[0].unverifiedSourceCount).toBe(0);
  });

  it('strips a source ID that does not exist in the input list (hallucinated)', () => {
    const findings = [
      {
        title: 'Suspicious finding',
        type: 'contradiction',
        summary: '...',
        sources: [
          { paperId: 'paperA', itemId: 'item-1' },
          { paperId: 'paperA', itemId: 'item-99-does-not-exist' },
        ],
      },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toEqual([{ paperId: 'paperA', itemId: 'item-1' }]);
    expect(result[0].unverifiedSourceCount).toBe(1);
  });

  it('strips a source citing the wrong paper for a real itemId (cross-paper mix-up)', () => {
    const findings = [
      {
        title: 'Mixed up paper',
        type: 'consensus',
        summary: '...',
        // item-2 is real, but only under paperA, not paperB.
        sources: [{ paperId: 'paperB', itemId: 'item-2' }],
      },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toEqual([]);
    expect(result[0].unverifiedSourceCount).toBe(1);
  });

  it('drops all sources without crashing when every one is fabricated', () => {
    const findings = [
      { title: 'Fully hallucinated', type: 'research_gap', summary: '...', sources: [{ paperId: 'x', itemId: 'y' }] },
    ];
    const result = verifyComparisonSources(findings, validKeys);
    expect(result[0].sources).toEqual([]);
    expect(result[0].unverifiedSourceCount).toBe(1);
  });

  it('handles an empty or missing findings array without crashing', () => {
    expect(verifyComparisonSources([], validKeys)).toEqual([]);
    expect(verifyComparisonSources(undefined, validKeys)).toEqual([]);
  });
});

describe('comparison prompt hallucination-prevention rules', () => {
  it('tells Claude it only has the saved findings list, not the full papers', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不能假裝讀過任何論文的完整原文');
  });

  it('requires sources to be real IDs from the list, not fabricated', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不得杜撰不存在的 ID');
  });

  it('instructs Claude not to assume a paper covers an aspect it has no items for', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不是「這篇論文沒有這個面向的內容」');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('絕對不要假裝知道這篇論文在那個面向做了什麼');
  });

  it('warns against labeling mere method/scope differences as contradiction', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('方法不同、範圍不同本身不構成 contradiction');
  });

  it('explains verificationStatus and that verified is strictly tied to exact (not partial)', () => {
    expect(COMPARISON_SYSTEM_PROMPT).toContain('verificationStatus');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('partial 不算 verified');
  });

  it('tool schema requires findings sources to reference real paperId+itemId pairs (no sourceClaim — that mechanism was tried and removed, see CLAUDE.md)', () => {
    const sourceSchema = COMPARISON_TOOL.input_schema.properties.findings.items.properties.sources;
    expect(sourceSchema.items.required).toEqual(['paperId', 'itemId']);
  });
});

describe('comparison persistence and deletion safety', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
    await db.comparisons.clear();
  });

  it('saves and reloads a comparison', async () => {
    const record = await saveComparison({
      paperIds: ['p1', 'p2'],
      focusQuestion: '高負載下的表現',
      findings: [{ title: 'T', type: 'consensus', summary: 'S', sources: [] }],
      status: 'done',
    });
    const list = await listComparisons();
    expect(list.find((c) => c.id === record.id)).toBeDefined();
    expect(list.find((c) => c.id === record.id).findings).toHaveLength(1);
  });

  it('each saveComparison call creates an independent record — a later failed comparison never overwrites an earlier successful one', async () => {
    await saveComparison({ paperIds: ['p1', 'p2'], findings: [{ title: 'Good one', type: 'consensus', summary: 'S', sources: [] }], status: 'done' });
    // A second, unrelated comparison — comparisons are never upserted by
    // any shared key, unlike saveAnalysis, so there is nothing to overwrite.
    await saveComparison({ paperIds: ['p3', 'p4'], findings: [], status: 'done' });

    const list = await listComparisons();
    expect(list).toHaveLength(2);
    expect(list.some((c) => c.findings[0]?.title === 'Good one')).toBe(true);
  });

  it('deleting a paper referenced by a comparison removes it from that comparison without crashing, and drops the comparison if fewer than 2 papers remain', async () => {
    const paperA = await createPaper({ title: 'A', fileName: 'a.pdf', pageCount: 1, pages: [], segments: [] });
    const paperB = await createPaper({ title: 'B', fileName: 'b.pdf', pageCount: 1, pages: [], segments: [] });
    const paperC = await createPaper({ title: 'C', fileName: 'c.pdf', pageCount: 1, pages: [], segments: [] });

    const threeWay = await saveComparison({ paperIds: [paperA.id, paperB.id, paperC.id], findings: [], status: 'done' });
    const twoWay = await saveComparison({ paperIds: [paperA.id, paperB.id], findings: [], status: 'done' });

    await deletePaper(paperA.id);

    const list = await listComparisons();
    const survivingThreeWay = list.find((c) => c.id === threeWay.id);
    const survivingTwoWay = list.find((c) => c.id === twoWay.id);

    // 3-paper comparison loses paperA but survives with the other 2.
    expect(survivingThreeWay).toBeDefined();
    expect(survivingThreeWay.paperIds).toEqual([paperB.id, paperC.id]);
    // 2-paper comparison drops below the 2-paper minimum and is removed.
    expect(survivingTwoWay).toBeUndefined();
  });
});

describe('backup/restore round-trip includes comparisons and analyses correctly', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
    await db.questions.clear();
    await db.comparisons.clear();
  });

  it('a comparison saved before export is readable again after import into a cleared database', async () => {
    const paperA = await createPaper({ title: 'A', fileName: 'a.pdf', pageCount: 1, pages: [], segments: [] });
    const paperB = await createPaper({ title: 'B', fileName: 'b.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paperA.id, 'overview', {
      status: 'done',
      items: [{ id: 'item-1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
    });
    const original = await saveComparison({
      paperIds: [paperA.id, paperB.id],
      focusQuestion: '延遲表現',
      findings: [
        { title: 'Consensus finding', type: 'consensus', summary: 'S', sources: [{ paperId: paperA.id, itemId: 'item-1' }] },
      ],
      status: 'done',
    });

    const backup = await exportBackup();

    // Simulate a genuinely fresh install: clear everything, then restore.
    await db.papers.clear();
    await db.analyses.clear();
    await db.comparisons.clear();

    await importBackup(backup);

    const restoredComparisons = await listComparisons();
    const restored = restoredComparisons.find((c) => c.id === original.id);
    expect(restored).toBeDefined();
    expect(restored.focusQuestion).toBe('延遲表現');
    expect(restored.findings[0].sources[0].itemId).toBe('item-1');

    const restoredPapers = await db.papers.toArray();
    expect(restoredPapers.map((p) => p.title).sort()).toEqual(['A', 'B']);

    const restoredAnalyses = await db.analyses.toArray();
    expect(restoredAnalyses).toHaveLength(1);
    expect(restoredAnalyses[0].items[0].title).toBe('T');
  });
});
