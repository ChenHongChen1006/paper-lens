// Tests for two related analysis-data semantics fixes:
//
// A) "saved success state" vs "did the most recent attempt fail" are
//    tracked separately (storage.js: saveAnalysis / isAnalysisCompleted).
//    A failed re-analysis on an already-completed module must NOT turn it
//    back into "未完成", must still be usable for cross-paper comparison,
//    and the failure is recorded as lastAttemptError/lastAttemptAt rather
//    than flipping status to 'error'.
//
// B) normalizeAnalysisItems() must reject an item with a missing/empty
//    claim (PaperLens must never invent analysis content Claude didn't
//    actually write) while still giving title a safe neutral fallback
//    (title is just a label, not analysis content), and a malformed
//    evidence entry must only drop that one entry, never the whole item.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  createPaper,
  saveAnalysis,
  getAnalysis,
  getAnalyses,
  isAnalysisCompleted,
} from '../lib/storage.js';
import { normalizeAnalysisItems } from '../lib/prompts.js';

const goodItems = [
  { id: 'i1', title: '重點一', claim: '原文明確提到的內容。', kind: 'fact', evidence: [] },
  { id: 'i2', title: '重點二', claim: '另一個重點。', kind: 'inference', evidence: [] },
];

describe('A. failed re-analysis on an already-completed module', () => {
  beforeEach(async () => {
    await db.papers.clear();
    await db.analyses.clear();
  });

  it('1. status stays "done", items are preserved, isAnalysisCompleted is true, lastAttemptError is set', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'methodology', { status: 'done', items: goodItems });

    await saveAnalysis(paper.id, 'methodology', { status: 'error', items: [], error: 'API request timeout' });

    const record = await getAnalysis(paper.id, 'methodology');
    expect(record.status).toBe('done');
    expect(record.items).toEqual(goodItems);
    expect(isAnalysisCompleted(record)).toBe(true);
    expect(record.lastAttemptError).toBe('API request timeout');
    expect(record.lastAttemptAt).toBeGreaterThan(0);
  });

  it('2. this record is still usable for cross-paper comparison (it is completed and has real items)', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'methodology', { status: 'done', items: goodItems });
    await saveAnalysis(paper.id, 'methodology', { status: 'error', items: [], error: 'timeout' });

    // Mirrors ComparePage.jsx's handleCompare(): only completed analyses
    // feed the comparison prompt.
    const analyses = await getAnalyses(paper.id);
    const usable = analyses.filter(isAnalysisCompleted);
    expect(usable).toHaveLength(1);
    expect(usable[0].items).toEqual(goodItems);
  });

  it('3. the next re-analysis attempt succeeding replaces items and clears lastAttemptError', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'methodology', { status: 'done', items: goodItems });
    await saveAnalysis(paper.id, 'methodology', { status: 'error', items: [], error: 'timeout' });

    const newItems = [{ id: 'i3', title: '新重點', claim: '重新分析成功後的新內容。', kind: 'fact', evidence: [] }];
    await saveAnalysis(paper.id, 'methodology', { status: 'done', items: newItems });

    const record = await getAnalysis(paper.id, 'methodology');
    expect(record.status).toBe('done');
    expect(record.items).toEqual(newItems);
    expect(record.lastAttemptError).toBeNull();
    expect(record.lastAttemptAt).toBeNull();
  });

  it('4. a first-ever analysis attempt failing (nothing to preserve) is genuinely incomplete', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'methodology', { status: 'error', items: [], error: '第一次分析就失敗' });

    const record = await getAnalysis(paper.id, 'methodology');
    expect(record.status).toBe('error');
    expect(record.items).toEqual([]);
    expect(isAnalysisCompleted(record)).toBe(false);
  });

  it('old IndexedDB records saved before this feature (no lastAttemptError/lastAttemptAt fields) still work', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    // Simulate a pre-existing record written by an older version of the
    // app — no lastAttemptError/lastAttemptAt keys at all.
    await db.analyses.put({
      id: 'analysis-legacy-1',
      paperId: paper.id,
      module: 'overview',
      status: 'done',
      items: goodItems,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: null,
    });

    const record = await getAnalysis(paper.id, 'overview');
    expect(isAnalysisCompleted(record)).toBe(true);
    expect(record.lastAttemptError).toBeUndefined(); // no crash reading a missing field

    // A failed retry on this legacy record still preserves it correctly.
    await saveAnalysis(paper.id, 'overview', { status: 'error', items: [], error: 'retry failed' });
    const updated = await getAnalysis(paper.id, 'overview');
    expect(updated.status).toBe('done');
    expect(updated.items).toEqual(goodItems);
    expect(updated.lastAttemptError).toBe('retry failed');
  });
});

describe('B. normalizeAnalysisItems: claim is required, title is not', () => {
  it('5. item with no title but a valid claim is kept, with a neutral title fallback', () => {
    const { items, rejections } = normalizeAnalysisItems([
      { id: 'i1', claim: '這是有效的分析內容。', kind: 'fact', evidence: [] },
    ]);
    expect(rejections).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('分析項目');
    expect(items[0].claim).toBe('這是有效的分析內容。');
  });

  it('6. item with a title but no claim is rejected entirely', () => {
    const { items, rejections } = normalizeAnalysisItems([
      { id: 'i1', title: '有標題但沒內容', kind: 'fact', evidence: [] },
    ]);
    expect(items).toEqual([]);
    expect(rejections).toEqual([{ index: 0, reason: 'missing_claim' }]);
  });

  it('7. claim === "" (or whitespace-only) is rejected, not kept as an empty string', () => {
    const { items, rejections } = normalizeAnalysisItems([
      { id: 'i1', title: 'T', claim: '', kind: 'fact', evidence: [] },
      { id: 'i2', title: 'T', claim: '   ', kind: 'fact', evidence: [] },
    ]);
    expect(items).toEqual([]);
    expect(rejections).toEqual([
      { index: 0, reason: 'missing_claim' },
      { index: 1, reason: 'missing_claim' },
    ]);
  });

  it('8. a malformed evidence entry is dropped, but the (otherwise valid) item is kept', () => {
    const { items, rejections } = normalizeAnalysisItems([
      {
        id: 'i1',
        title: 'T',
        claim: '有效內容',
        kind: 'fact',
        evidence: [
          { segmentId: 'p1-s1', page: 1, quote: 'a real quote' },
          { segmentId: 'p1-s1', page: 1 /* missing quote */ },
          { segmentId: 'p1-s1', page: 1, quote: '' /* blank quote */ },
          'not even an object',
          null,
        ],
      },
    ]);
    expect(rejections).toEqual([]); // the item itself is not rejected
    expect(items).toHaveLength(1);
    expect(items[0].evidence).toEqual([{ segmentId: 'p1-s1', page: 1, quote: 'a real quote' }]);
  });

  it('a fact item that ends up with zero evidence (all malformed) is still kept, not rejected', () => {
    const { items, rejections } = normalizeAnalysisItems([
      { id: 'i1', title: 'T', claim: '有效內容但沒有好的 evidence', kind: 'fact', evidence: [{ page: 1 }] },
    ]);
    expect(rejections).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0].evidence).toEqual([]);
  });

  it('kind still rejects the item outright (unchanged behavior)', () => {
    const { items, rejections } = normalizeAnalysisItems([
      { id: 'i1', title: 'T', claim: '內容', kind: 'maybe', evidence: [] },
    ]);
    expect(items).toEqual([]);
    expect(rejections).toEqual([{ index: 0, reason: 'invalid_kind', value: 'maybe' }]);
  });
});
