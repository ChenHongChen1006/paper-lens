// Data-safety regression tests, written after investigating a report of
// IndexedDB data (papers, analyses, and even the API key) disappearing
// between sessions. The code audit found:
//   - no code path that clears the whole database, renames it, or bumps
//     its schema version destructively (grep + manual review of every
//     `.clear()` / `.delete()` call site — see CLAUDE.md)
//   - clearAllPaperData() (the in-app "clear data" feature) never touches
//     the `settings` table, so it structurally cannot explain the API key
//     also vanishing, and it's only ever reachable via a user click behind
//     a confirm() dialog
//   - a REAL bug in `saveAnalysis()`: retrying a module analysis that
//     fails (network hiccup, rate limit, bad key) overwrote the
//     previously successful result with an empty item list, because the
//     error handler called `saveAnalysis(..., { items: [] })` and the
//     old code did `items: data.items || []` — an empty array is truthy
//     in JS, so `[] || []` kept the empty array instead of falling back
//     to the existing data. Fixed below; this file guards the fix.
//
// These tests use fake-indexeddb (see src/test/setup.js), never the
// user's real browser database.

import { describe, it, expect, beforeEach } from 'vitest';
import Dexie from 'dexie';
import {
  db,
  createPaper,
  saveAnalysis,
  getAnalysis,
  getAnalyses,
  clearAllPaperData,
  setSetting,
  getAllSettings,
} from '../lib/storage.js';

beforeEach(async () => {
  await db.papers.clear();
  await db.analyses.clear();
  await db.settings.clear();
});

describe('re-opening the database (simulated app restart / HMR) never loses data', () => {
  it('data written before "reopening" the same database is still there after', async () => {
    const paper = await createPaper({ title: 'Persisted Paper', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'overview', {
      status: 'done',
      items: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
    });

    // Simulate a fresh page load re-running storage.js's module-level
    // `new Dexie('paperlens'); db.version(1).stores({...})` against the
    // SAME already-existing database — this must never wipe existing rows.
    const reopened = new Dexie('paperlens');
    reopened.version(1).stores({
      papers: 'id, title, fileName, createdAt',
      analyses: 'id, paperId, module, [paperId+module], updatedAt',
      questions: 'id, paperId, createdAt',
      comparisons: 'id, createdAt',
      settings: 'key',
      usage: 'id, timestamp',
    });
    await reopened.open();

    const papers = await reopened.papers.toArray();
    const analyses = await reopened.analyses.toArray();
    expect(papers).toHaveLength(1);
    expect(papers[0].title).toBe('Persisted Paper');
    expect(analyses).toHaveLength(1);
    expect(analyses[0].items).toHaveLength(1);

    reopened.close();
  });
});

describe('a failed re-analysis attempt never discards a previously successful result', () => {
  it('saveAnalysis with status "error" and no items keeps the existing items AND stays status "done"', async () => {
    // See CLAUDE.md: a failed re-analysis attempt on an already-completed
    // module must not flip it back to incomplete — "saved success state"
    // and "did the most recent attempt fail" are tracked separately
    // (status/items vs lastAttemptError/lastAttemptAt).
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    const goodItems = [{ id: 'i1', title: '重點', claim: '原文明確提到的內容。', kind: 'fact', evidence: [] }];

    await saveAnalysis(paper.id, 'methodology', { status: 'done', items: goodItems });

    // User clicks "重新分析" and it fails (e.g. API key stopped working).
    await saveAnalysis(paper.id, 'methodology', { status: 'error', items: [], error: 'API key 無效或驗證失敗。' });

    const record = await getAnalysis(paper.id, 'methodology');
    expect(record.status).toBe('done');
    expect(record.error).toBeNull();
    expect(record.lastAttemptError).toBe('API key 無效或驗證失敗。');
    // The previously successful items must still be there.
    expect(record.items).toEqual(goodItems);
  });

  it('a genuinely successful save (status "done", real items) replaces the old items', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'overview', {
      status: 'done',
      items: [{ id: 'i1', title: 'old', claim: 'old claim', kind: 'fact', evidence: [] }],
    });

    const newItems = [{ id: 'i2', title: 'new', claim: 'new claim', kind: 'fact', evidence: [] }];
    await saveAnalysis(paper.id, 'overview', { status: 'done', items: newItems });

    const record = await getAnalysis(paper.id, 'overview');
    expect(record.status).toBe('done');
    expect(record.items).toEqual(newItems);
  });

  it('a save that CLAIMS status "done" but has an empty items array does NOT count as success — saveAnalysis never trusts the caller blindly (see CLAUDE.md)', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    const goodItems = [{ id: 'i1', title: 'old', claim: 'old claim', kind: 'fact', evidence: [] }];
    await saveAnalysis(paper.id, 'overview', { status: 'done', items: goodItems });

    // A caller bug (or a malformed API response that slipped past earlier
    // layers) claims success but provides no items.
    await saveAnalysis(paper.id, 'overview', { status: 'done', items: [] });

    const record = await getAnalysis(paper.id, 'overview');
    // The old, genuinely successful result must survive untouched.
    expect(record.status).toBe('done');
    expect(record.items).toEqual(goodItems);
    expect(record.lastAttemptError).toBeTruthy();
  });

  it('the very first save for a module with an error and no items just stores an empty list (nothing to preserve)', async () => {
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'data', { status: 'error', items: [], error: '分析失敗' });

    const record = await getAnalysis(paper.id, 'data');
    expect(record.items).toEqual([]);
    expect(record.status).toBe('error');
  });
});

describe('clearAllPaperData is the only bulk-clear path, and it never touches settings', () => {
  it('leaves the API key and other settings completely untouched', async () => {
    await setSetting('apiKey', 'sk-ant-do-not-delete-me');
    await setSetting('model', 'claude-sonnet-5');
    const paper = await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });
    await saveAnalysis(paper.id, 'overview', { status: 'done', items: [] });

    await clearAllPaperData();

    const settings = await getAllSettings();
    expect(settings.apiKey).toBe('sk-ant-do-not-delete-me');
    expect(settings.model).toBe('claude-sonnet-5');
    const papers = await db.papers.toArray();
    expect(papers).toHaveLength(0);
  });
});

describe('uploading a paper with a duplicate file name never touches the existing paper', () => {
  it('creates an independent second record; the first paper and its analyses are untouched', async () => {
    const first = await createPaper({ title: 'Same Name', fileName: 'same.pdf', pageCount: 3, pages: [], segments: [] });
    await saveAnalysis(first.id, 'overview', {
      status: 'done',
      items: [{ id: 'i1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
    });

    // Re-"uploading" a PDF with the same file name always calls createPaper
    // again with a fresh generated id (see ingest.js) — it never looks up
    // or reuses an existing paper by file name.
    const second = await createPaper({ title: 'Same Name', fileName: 'same.pdf', pageCount: 3, pages: [], segments: [] });

    expect(second.id).not.toBe(first.id);

    const firstStillThere = await db.papers.get(first.id);
    const firstAnalyses = await getAnalyses(first.id);
    expect(firstStillThere).toBeDefined();
    expect(firstAnalyses).toHaveLength(1);
    expect(firstAnalyses[0].items).toHaveLength(1);

    const allPapers = await db.papers.toArray();
    expect(allPapers).toHaveLength(2);
  });
});
