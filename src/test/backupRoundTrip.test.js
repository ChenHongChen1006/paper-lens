// Full backup/restore round-trip test (request: "不要只測 JSON 裡有沒有欄位，
// 要測真的 restore 得回來"). Builds fake data across every table, exports a
// backup, wipes the tables to simulate a clean install, imports the
// backup, and verifies every piece of data is actually readable again —
// not just that the exported JSON object happens to contain the right
// keys. Also re-confirms, this time via the imported result rather than
// just the raw export, that the API key and PDF blob never survive a
// backup.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  createPaper,
  saveAnalysis,
  saveQuestion,
  saveComparison,
  setSetting,
  getAllSettings,
  exportBackup,
  importBackup,
  getQuestions,
  getAnalyses,
  listComparisons,
} from '../lib/storage.js';

beforeEach(async () => {
  await db.papers.clear();
  await db.analyses.clear();
  await db.questions.clear();
  await db.comparisons.clear();
  await db.settings.clear();
});

describe('full backup/restore round-trip', () => {
  it('restores papers, analyses, questions, and comparisons into a freshly cleared database', async () => {
    await setSetting('apiKey', 'sk-ant-super-secret');
    await setSetting('researchBackground', '我在研究穿戴式裝置的壓力偵測。');

    const blob = new Blob(['%PDF-1.4 fake bytes'], { type: 'application/pdf' });
    const paperA = await createPaper({
      title: '論文 A',
      fileName: 'a.pdf',
      fileBlob: blob,
      pageCount: 2,
      pages: [{ page: 1, text: 'hello', charCount: 5 }],
      segments: [{ id: 'p1-s1', page: 1, text: 'hello world' }],
    });
    const paperB = await createPaper({
      title: '論文 B',
      fileName: 'b.pdf',
      pageCount: 1,
      pages: [],
      segments: [{ id: 'p1-s1', page: 1, text: 'another paper entirely' }],
    });

    await saveAnalysis(paperA.id, 'overview', {
      status: 'done',
      items: [{ id: 'item-1', title: '重點', claim: '原文內容。', kind: 'fact', evidence: [] }],
    });
    await saveQuestion(paperA.id, '這篇論文在做什麼？', {
      items: [{ id: 'ans-1', title: '答案', claim: '回答內容', kind: 'fact', evidence: [] }],
      status: 'done',
    });
    await saveComparison({
      paperIds: [paperA.id, paperB.id],
      focusQuestion: '',
      findings: [{ title: 'F', type: 'research_gap', summary: 'S', sources: [] }],
      status: 'done',
    });

    const backup = await exportBackup();

    // --- API key / PDF blob must never be in the exported backup ---
    expect(backup.settings.apiKey).toBeUndefined();
    expect(JSON.stringify(backup)).not.toContain('sk-ant-super-secret');
    expect(backup.papers.every((p) => p.fileBlob === undefined)).toBe(true);

    // --- simulate a genuinely fresh install and restore into it ---
    await db.papers.clear();
    await db.analyses.clear();
    await db.questions.clear();
    await db.comparisons.clear();
    await db.settings.clear(); // apiKey too — importBackup must not need it

    await importBackup(backup);

    // Papers: metadata restored, but no PDF blob (never backed up).
    const restoredPaperA = await db.papers.get(paperA.id);
    const restoredPaperB = await db.papers.get(paperB.id);
    expect(restoredPaperA.title).toBe('論文 A');
    expect(restoredPaperA.segments).toEqual([{ id: 'p1-s1', page: 1, text: 'hello world' }]);
    expect(restoredPaperA.fileBlob).toBeUndefined();
    expect(restoredPaperB.title).toBe('論文 B');

    // Analyses actually come back with their items intact.
    const restoredAnalyses = await getAnalyses(paperA.id);
    expect(restoredAnalyses).toHaveLength(1);
    expect(restoredAnalyses[0].items[0].claim).toBe('原文內容。');

    // Questions come back too.
    const restoredQuestions = await getQuestions(paperA.id);
    expect(restoredQuestions).toHaveLength(1);
    expect(restoredQuestions[0].question).toBe('這篇論文在做什麼？');
    expect(restoredQuestions[0].answer.items[0].claim).toBe('回答內容');

    // Comparisons come back.
    const restoredComparisons = await listComparisons();
    expect(restoredComparisons).toHaveLength(1);
    expect(restoredComparisons[0].paperIds).toEqual([paperA.id, paperB.id]);
    expect(restoredComparisons[0].findings[0].title).toBe('F');

    // Non-secret settings (research background) restore; API key does not
    // — it was never in the backup to begin with.
    const restoredSettings = await getAllSettings();
    expect(restoredSettings.researchBackground).toBe('我在研究穿戴式裝置的壓力偵測。');
    expect(restoredSettings.apiKey).toBe(''); // default, never restored
  });

  it('importing a backup never overwrites an API key already set in the current browser', async () => {
    await setSetting('apiKey', 'sk-ant-current-browser-key');
    const backup = await exportBackup(); // has no apiKey field at all

    await importBackup(backup);

    const settings = await getAllSettings();
    expect(settings.apiKey).toBe('sk-ant-current-browser-key');
  });

  it('rejects malformed backup data before writing anything to the database', async () => {
    const paper = await createPaper({ title: 'Keep me', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });

    await expect(importBackup({ papers: 'not-an-array' })).rejects.toThrow();
    await expect(importBackup(null)).rejects.toThrow();

    // The existing paper must be completely untouched by the rejected import.
    const stillThere = await db.papers.get(paper.id);
    expect(stillThere.title).toBe('Keep me');
    const allPapers = await db.papers.toArray();
    expect(allPapers).toHaveLength(1);
  });
});
