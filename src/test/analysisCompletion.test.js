// Tests for isAnalysisCompleted() — the single shared rule for "does this
// module's analysis count as done", used by PapersPage (homepage card
// count), PaperDetailPage (header count + "分析全部未完成面向"), and
// ComparePage (paper selection eligibility + comparison input). Written
// after a real report of the header showing "分析 2/5" while some of
// those "completed" modules were actually status:"done" + items:[] —
// leftover records from the max_tokens/empty-result bug (see CLAUDE.md) —
// which must NOT count as completed even though status alone says "done".

import { describe, it, expect, beforeEach } from 'vitest';
import { db, createPaper, saveAnalysis, getAnalyses, isAnalysisCompleted } from '../lib/storage.js';
import { MODULES } from '../lib/prompts.js';

describe('isAnalysisCompleted', () => {
  it('1. status=done with items counts as completed', () => {
    const analysis = {
      status: 'done',
      items: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
    };
    expect(isAnalysisCompleted(analysis)).toBe(true);
  });

  it('1b. status=done with 5 items counts as completed', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`,
      title: 'T',
      claim: 'C',
      kind: 'fact',
      evidence: [],
    }));
    expect(isAnalysisCompleted({ status: 'done', items })).toBe(true);
  });

  it('2. status=done with an empty items array is NOT completed (the reported bug\'s leftover record shape)', () => {
    expect(isAnalysisCompleted({ status: 'done', items: [], error: null })).toBe(false);
  });

  it('3. status=error is never completed, even if items happens to be non-empty (preserved old items)', () => {
    expect(isAnalysisCompleted({ status: 'error', items: [], error: 'failed' })).toBe(false);
    expect(
      isAnalysisCompleted({
        status: 'error',
        items: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
        error: '重新分析失敗',
      })
    ).toBe(false);
  });

  it('4. undefined/missing analysis record is not completed', () => {
    expect(isAnalysisCompleted(undefined)).toBe(false);
    expect(isAnalysisCompleted(null)).toBe(false);
  });

  it('handles a malformed items field (not an array) without crashing', () => {
    expect(isAnalysisCompleted({ status: 'done', items: 'not-an-array' })).toBe(false);
    expect(isAnalysisCompleted({ status: 'done' })).toBe(false);
  });
});

describe('5. completion count across the 5 modules with mixed record states', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
  });

  it('1 genuinely done + 2 done-with-empty-items (legacy bug records) + 2 missing = 1/5, not 3/5', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 36, pages: [], segments: [] });

    await saveAnalysis(paper.id, 'overview', {
      status: 'done',
      items: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
    });
    // These two simulate the exact leftover shape from the reported bug.
    await saveAnalysis(paper.id, 'methodology', { status: 'done', items: [], error: null });
    await saveAnalysis(paper.id, 'data', { status: 'done', items: [], error: null });
    // reproducibility and limitations: no record at all.

    const analyses = await getAnalyses(paper.id);
    const byModule = Object.fromEntries(analyses.map((a) => [a.module, a]));
    const completedCount = MODULES.filter((m) => isAnalysisCompleted(byModule[m.id])).length;

    expect(completedCount).toBe(1);
    expect(MODULES.length).toBe(5);
  });
});

describe('6. homepage and paper-detail-page completion counts must agree', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
  });

  it('counting via db.analyses.toArray() (PapersPage-style) and via getAnalyses(paperId) (PaperDetailPage-style) yield the same number', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'overview', {
      status: 'done',
      items: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
    });
    await saveAnalysis(paper.id, 'methodology', { status: 'done', items: [] });
    await saveAnalysis(paper.id, 'reproducibility', {
      status: 'error',
      items: [{ id: 'i1', title: 'old', claim: 'preserved from a prior success', kind: 'fact', evidence: [] }],
      error: '重新分析失敗',
    });

    // PapersPage-style: scan the whole analyses table and bucket by paperId.
    const allAnalyses = await db.analyses.toArray();
    const homepageCount = allAnalyses.filter((a) => a.paperId === paper.id && isAnalysisCompleted(a)).length;

    // PaperDetailPage-style: fetch this paper's analyses directly.
    const paperAnalyses = await getAnalyses(paper.id);
    const detailPageCount = paperAnalyses.filter(isAnalysisCompleted).length;

    expect(homepageCount).toBe(detailPageCount);
    expect(homepageCount).toBe(1); // only overview
  });
});

describe('7. "分析全部未完成面向" must re-attempt a done+[] module', () => {
  it('a module with status=done and empty items is included in the pending (to-be-analyzed) list', async () => {
    await db.papers.clear();
    await db.analyses.clear();
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'overview', {
      status: 'done',
      items: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
    });
    await saveAnalysis(paper.id, 'methodology', { status: 'done', items: [] });

    const analyses = await getAnalyses(paper.id);
    const byModule = Object.fromEntries(analyses.map((a) => [a.module, a]));
    // Mirrors PaperDetailPage.jsx's handleAnalyzeAll(): pending = modules
    // that are not (yet) completed.
    const pending = MODULES.filter((m) => !isAnalysisCompleted(byModule[m.id]));

    expect(pending.map((m) => m.id)).toContain('methodology');
    expect(pending.map((m) => m.id)).not.toContain('overview');
    // data/reproducibility/limitations have no record at all — also pending.
    expect(pending).toHaveLength(4);
  });
});
