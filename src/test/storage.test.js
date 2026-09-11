import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  createPaper,
  setSetting,
  exportBackup,
  validateBackup,
  clearAllPaperData,
  getAllSettings,
} from '../lib/storage.js';

beforeEach(async () => {
  await db.papers.clear();
  await db.analyses.clear();
  await db.questions.clear();
  await db.comparisons.clear();
  await db.settings.clear();
  await db.usage.clear();
});

describe('exportBackup', () => {
  it('never includes the API key', async () => {
    await setSetting('apiKey', 'sk-ant-super-secret-key');
    await setSetting('model', 'claude-sonnet-5');

    const backup = await exportBackup();

    expect(JSON.stringify(backup)).not.toContain('sk-ant-super-secret-key');
    expect(backup.settings.apiKey).toBeUndefined();
    expect(backup.settings.model).toBe('claude-sonnet-5');
  });

  it('never includes the PDF blob', async () => {
    const blob = new Blob(['%PDF-1.4 fake pdf bytes'], { type: 'application/pdf' });
    await createPaper({
      title: 'Test Paper',
      fileName: 'test.pdf',
      fileBlob: blob,
      pageCount: 1,
      pages: [{ page: 1, text: 'hello', charCount: 5 }],
      segments: [{ id: 'p1-s1', page: 1, text: 'hello' }],
    });

    const backup = await exportBackup();

    expect(backup.papers).toHaveLength(1);
    expect(backup.papers[0].fileBlob).toBeUndefined();
    expect(backup.papers[0].title).toBe('Test Paper');
    expect(backup.papers[0].segments).toHaveLength(1);
  });

  it('produces a backup that passes validateBackup', async () => {
    const backup = await exportBackup();
    expect(validateBackup(backup).valid).toBe(true);
  });
});

describe('validateBackup', () => {
  it('rejects malformed data', () => {
    expect(validateBackup(null).valid).toBe(false);
    expect(validateBackup({ papers: 'not-an-array' }).valid).toBe(false);
    expect(validateBackup({ schemaVersion: 1, papers: [] }).valid).toBe(true);
  });
});

describe('clearAllPaperData', () => {
  it('clears paper data but keeps settings such as the API key', async () => {
    await setSetting('apiKey', 'sk-ant-keep-me');
    await createPaper({ title: 'P', fileName: 'p.pdf', pageCount: 1, pages: [], segments: [] });

    await clearAllPaperData();

    const papers = await db.papers.toArray();
    expect(papers).toHaveLength(0);
    const settings = await getAllSettings();
    expect(settings.apiKey).toBe('sk-ant-keep-me');
  });
});
