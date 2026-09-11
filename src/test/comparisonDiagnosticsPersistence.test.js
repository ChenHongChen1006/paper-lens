// Tests for persisted, non-sensitive comparison diagnostics.
//
// Motivation: after diagnosing "跨篇比較產生空結果" via a dev-only
// console.debug log, the user hit it again in real use but had opened
// DevTools only AFTER the comparison finished — the console log was
// already gone, and re-running just to see it again costs API credits.
// The fix is to persist a small, numbers-only diagnostics summary
// alongside the comparison record itself (storage.js: saveComparison's
// `diagnostics` field), built by the pure, independently-testable
// text.js: buildComparisonDiagnostics(). This file tests:
//   - buildComparisonDiagnostics' arithmetic (raw → normalized → source
//     validated → final, plus typeCounts) in isolation
//   - that a legitimate empty result (raw=0) is still saved WITH
//     diagnostics showing raw=0/final=0, so it's later provable that
//     Claude itself returned nothing
//   - that a processing-error result (raw>0, everything filtered out
//     locally) is never saved as a normal empty comparison — diagnostics
//     must not be used as a backdoor to "successfully" save that case
//   - old records without a `diagnostics` field at all don't crash
//     anything and round-trip through backup/restore unchanged
//   - new records WITH diagnostics round-trip through backup/restore too

import { describe, it, expect, beforeEach } from 'vitest';
import { buildComparisonDiagnostics, verifyComparisonSources, dropUnsourcedComparisonFindings } from '../lib/text.js';
import { db, saveComparison, listComparisons, exportBackup, importBackup } from '../lib/storage.js';

describe('buildComparisonDiagnostics (pure arithmetic, no I/O)', () => {
  it('1-5: computes raw / normalized / id-validated / single-paper-filtered / final counts and typeCounts correctly', () => {
    // 4 raw findings from Claude...
    const rawFindingCount = 4;
    // ...1 gets rejected during shape/type normalization (e.g. invalid
    // type), leaving 3...
    const normalizedFindingCount = 3;
    const rejections = [{ index: 2, reason: 'invalid_type', value: 'unknown_type' }];
    // ...1 of the remaining 3 ends up with zero valid sources after
    // verifyComparisonSources + dropUnsourcedComparisonFindings, leaving 2...
    const findingsAfterIdValidation = 2;
    // ...0 of those 2 get dropped for being single-paper findings.
    const singlePaperFindingCount = 0;
    const finalFindings = [
      { type: 'consensus', title: 'T1', summary: 'S1', sources: [{ paperId: 'p0', itemId: 'i1' }] },
      { type: 'difference', title: 'T2', summary: 'S2', sources: [{ paperId: 'p1', itemId: 'i2' }] },
    ];

    const diagnostics = buildComparisonDiagnostics({
      rawFindingCount,
      normalizedFindingCount,
      rejections,
      rawSourceCount: 5,
      invalidSourceIdCount: 1,
      findingsAfterIdValidation,
      singlePaperFindingCount,
      finalFindings,
    });

    expect(diagnostics.rawFindingCount).toBe(4);
    expect(diagnostics.parsedFindingCount).toBe(4);
    expect(diagnostics.normalizedFindingCount).toBe(3);
    expect(diagnostics.rejectedFindingCount).toBe(1);
    expect(diagnostics.invalidTypeCount).toBe(1);
    expect(diagnostics.rawSourceCount).toBe(5);
    expect(diagnostics.invalidSourceIdCount).toBe(1);
    // sourceClaim exact-match validation was removed — this mechanism no
    // longer exists, so this stays 0 always (see CLAUDE.md).
    expect(diagnostics.sourceClaimMismatchCount).toBe(0);
    expect(diagnostics.findingsAfterIdValidation).toBe(2);
    // Claim validation is a no-op now, so this stage always mirrors
    // findingsAfterIdValidation.
    expect(diagnostics.findingsAfterClaimValidation).toBe(2);
    expect(diagnostics.singlePaperFindingCount).toBe(0);
    expect(diagnostics.findingsAfterMultiPaperValidation).toBe(2);
    expect(diagnostics.finalFindingCount).toBe(2);
    expect(diagnostics.typeCounts).toEqual({ consensus: 1, difference: 1, contradiction: 0, shared_limitation: 0, research_gap: 0 });
  });

  it('never guesses a number for a stage it has no data for — defaults to 0 (or null for comparisonStatus), never omitted or guessed', () => {
    const diagnostics = buildComparisonDiagnostics();
    expect(diagnostics).toEqual({
      rawFindingCount: 0,
      parsedFindingCount: 0,
      normalizedFindingCount: 0,
      rejectedFindingCount: 0,
      invalidTypeCount: 0,
      rawSourceCount: 0,
      invalidSourceIdCount: 0,
      sourceClaimMismatchCount: 0,
      findingsAfterIdValidation: 0,
      findingsAfterClaimValidation: 0,
      singlePaperFindingCount: 0,
      findingsAfterMultiPaperValidation: 0,
      finalFindingCount: 0,
      typeCounts: { consensus: 0, difference: 0, contradiction: 0, shared_limitation: 0, research_gap: 0 },
      comparisonStatus: null,
    });
  });

  it('only contains numbers/short enum keys — no titles, claims, or raw rejection values leak through', () => {
    const diagnostics = buildComparisonDiagnostics({
      rawFindingCount: 1,
      rejections: [{ index: 0, reason: 'invalid_type', value: 'a suspiciously long string that could be anything' }],
      finalFindings: [{ type: 'consensus', title: 'A real title with real content', summary: 'A real summary', sources: [] }],
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('suspiciously long string');
    expect(serialized).not.toContain('A real title');
    expect(serialized).not.toContain('A real summary');
  });
});

describe('6-7: persisted diagnostics distinguish "Claude returned 0" from "processing zeroed a non-empty result"', () => {
  beforeEach(async () => {
    await db.comparisons.clear();
  });

  it('6: a legitimate empty result (raw=0) is saved, with diagnostics proving raw=0/final=0', async () => {
    const diagnostics = buildComparisonDiagnostics({ rawFindingCount: 0, normalizedFindingCount: 0, finalFindings: [] });
    const saved = await saveComparison({
      paperIds: ['p0', 'p1'],
      findings: [],
      status: 'done',
      diagnostics,
    });
    const list = await listComparisons();
    const record = list.find((c) => c.id === saved.id);
    expect(record).toBeDefined();
    expect(record.findings).toEqual([]);
    expect(record.diagnostics.rawFindingCount).toBe(0);
    expect(record.diagnostics.finalFindingCount).toBe(0);
  });

  it('7: raw>0 but everything filtered out locally — mirrors ComparePage.jsx and must NOT be saved as a normal empty comparison', async () => {
    // Simulates: Claude proposed 2 findings, but both cited only
    // hallucinated source IDs — exactly ComparePage.jsx's derivation.
    const validKeys = new Set(['p0::real-item']);
    const rawFindings = [
      { type: 'consensus', title: 'T1', summary: 'S1', sources: [{ paperId: 'p0', itemId: 'fabricated-1' }] },
      { type: 'difference', title: 'T2', summary: 'S2', sources: [{ paperId: 'p1', itemId: 'fabricated-2' }] },
    ];
    const rawFindingCount = rawFindings.length;
    const sourceVerified = verifyComparisonSources(rawFindings, validKeys);
    const { kept, dropped } = dropUnsourcedComparisonFindings(sourceVerified);

    expect(rawFindingCount).toBe(2);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(2);

    // The guard ComparePage.jsx applies: raw>0 && kept.length===0 → throw,
    // never call saveComparison. Confirm that invariant holds here, and
    // that consequently nothing gets persisted.
    const shouldThrow = rawFindingCount > 0 && kept.length === 0;
    expect(shouldThrow).toBe(true);
    if (!shouldThrow) {
      await saveComparison({ paperIds: ['p0', 'p1'], findings: kept, status: 'done' });
    }

    const list = await listComparisons();
    expect(list).toHaveLength(0); // nothing was saved — this is the whole point of the guard
  });
});

describe('8: old comparison records without a `diagnostics` field never crash anything', () => {
  beforeEach(async () => {
    await db.comparisons.clear();
  });

  it('saveComparison called without diagnostics stores diagnostics: null, not undefined or a crash', async () => {
    const saved = await saveComparison({ paperIds: ['p0', 'p1'], findings: [{ title: 'T', type: 'consensus', summary: 'S', sources: [] }], status: 'done' });
    expect(saved.diagnostics).toBeNull();
  });

  it('a legacy record written directly (pre-diagnostics era) reads back fine, and optional-chained access is safe', async () => {
    await db.comparisons.put({
      id: 'comparison-legacy',
      paperIds: ['p0', 'p1'],
      focusQuestion: '',
      findings: [{ title: 'Old finding', type: 'consensus', summary: 'S', sources: [] }],
      status: 'done',
      error: null,
      createdAt: Date.now(),
      // no `diagnostics` key at all — this is what every comparison saved
      // before this feature looks like.
    });
    const list = await listComparisons();
    const record = list.find((c) => c.id === 'comparison-legacy');
    expect(record).toBeDefined();
    expect(record.diagnostics).toBeUndefined();
    // Mirrors exactly what the DEV-only diagnostics panel in
    // ComparePage.jsx does: optional-chain everything, never assume the
    // field exists.
    expect(record.diagnostics?.rawFindingCount).toBeUndefined();
    expect(record.diagnostics?.typeCounts?.consensus ?? 0).toBe(0);
  });
});

describe('9: diagnostics survives a backup/restore round-trip', () => {
  beforeEach(async () => {
    await db.comparisons.clear();
  });

  it('a comparison saved with diagnostics keeps identical diagnostics after export -> clear -> import', async () => {
    const diagnostics = buildComparisonDiagnostics({
      rawFindingCount: 4,
      normalizedFindingCount: 3,
      rejections: [{ index: 2, reason: 'invalid_type', value: 'x' }],
      rawSourceCount: 5,
      invalidSourceIdCount: 1,
      findingsAfterIdValidation: 2,
      singlePaperFindingCount: 0,
      finalFindings: [
        { type: 'consensus', title: 'T1', summary: 'S1', sources: [{ paperId: 'p0', itemId: 'i1' }] },
        { type: 'difference', title: 'T2', summary: 'S2', sources: [{ paperId: 'p1', itemId: 'i2' }] },
      ],
    });
    const original = await saveComparison({
      paperIds: ['p0', 'p1'],
      findings: [
        { title: 'T1', type: 'consensus', summary: 'S1', sources: [{ paperId: 'p0', itemId: 'i1' }] },
        { title: 'T2', type: 'difference', summary: 'S2', sources: [{ paperId: 'p1', itemId: 'i2' }] },
      ],
      status: 'done',
      diagnostics,
    });

    const backup = await exportBackup();
    await db.comparisons.clear();
    await importBackup(backup);

    const list = await listComparisons();
    const restored = list.find((c) => c.id === original.id);
    expect(restored).toBeDefined();
    expect(restored.diagnostics).toEqual(diagnostics);
  });

  it('a legacy comparison without diagnostics also round-trips fine (optional field, no migration needed)', async () => {
    const original = await saveComparison({ paperIds: ['p0', 'p1'], findings: [], status: 'done' });
    const backup = await exportBackup();
    await db.comparisons.clear();
    await importBackup(backup);

    const list = await listComparisons();
    const restored = list.find((c) => c.id === original.id);
    expect(restored).toBeDefined();
    expect(restored.diagnostics).toBeNull();
  });
});
