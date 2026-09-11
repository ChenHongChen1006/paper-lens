// storage.js — IndexedDB access via Dexie.
//
// Tables:
//   papers      metadata + extracted pages/segments + the PDF blob itself
//   analyses    one row per (paperId, module) — the five analysis aspects
//   questions   custom Q&A history per paper
//   comparisons cross-paper comparison results
//   settings    single key/value store (apiKey, model, researchBackground, ...)
//   usage       one row per Claude API request, for token accounting
//
// SCHEMA_VERSION is stored in the `settings` table so future sessions can
// detect and migrate older data if the shape of a table ever changes.

import Dexie from 'dexie';

export const SCHEMA_VERSION = 1;

// The database name and version history below are load-bearing: changing
// the name, or adding a `db.version(N)` bump, changes what data the next
// page load can see. Dexie treats each distinct name as a completely
// separate IndexedDB database, and an `.upgrade()` callback runs against
// the user's REAL existing data — never call `.clear()` (or delete/drop a
// table) inside one, and never rename this database. If a future schema
// change genuinely needs to restructure a table, add a new
// `db.version(N + 1).stores({...}).upgrade(tx => ...)` that transforms
// existing rows in place; do not add a version bump that starts from an
// empty table.
export const db = new Dexie('paperlens');

db.version(1).stores({
  papers: 'id, title, fileName, createdAt',
  analyses: 'id, paperId, module, [paperId+module], updatedAt',
  questions: 'id, paperId, createdAt',
  comparisons: 'id, createdAt',
  settings: 'key',
  usage: 'id, timestamp',
});

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Settings — API key never leaves this table, and is never included in
// exportBackup().
// ---------------------------------------------------------------------------

const SETTINGS_DEFAULTS = {
  apiKey: '',
  model: 'claude-sonnet-5',
  customModel: '',
  researchBackground: '',
};

export async function getSetting(key, fallback) {
  const row = await db.settings.get(key);
  if (row) return row.value;
  if (fallback !== undefined) return fallback;
  return SETTINGS_DEFAULTS[key];
}

export async function getAllSettings() {
  const rows = await db.settings.toArray();
  const out = { ...SETTINGS_DEFAULTS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

export async function deleteSetting(key) {
  await db.settings.delete(key);
}

// ---------------------------------------------------------------------------
// Papers
// ---------------------------------------------------------------------------

export function newPaperId() {
  return `paper-${uid()}`;
}

export async function createPaper(paper) {
  const now = Date.now();
  const record = {
    id: paper.id || newPaperId(),
    title: paper.title || paper.fileName || '未命名論文',
    fileName: paper.fileName,
    fileBlob: paper.fileBlob,
    createdAt: now,
    pageCount: paper.pageCount || 0,
    extractionMode: paper.extractionMode || 'text', // 'text' | 'ocr'
    extractionStatus: paper.extractionStatus || 'pending', // pending|processing|done|error
    extractionError: paper.extractionError || null,
    pages: paper.pages || [], // [{ page, text, charCount }]
    segments: paper.segments || [], // [{ id, page, text }]
    referenceInfo: paper.referenceInfo || null,
    scanInfo: paper.scanInfo || null,
    ...paper,
  };
  record.id = record.id || newPaperId();
  await db.papers.put(record);
  return record;
}

export async function updatePaper(id, changes) {
  await db.papers.update(id, changes);
  return db.papers.get(id);
}

export async function getPaper(id) {
  return db.papers.get(id);
}

export async function listPapers() {
  const papers = await db.papers.orderBy('createdAt').reverse().toArray();
  return papers;
}

export async function deletePaper(id) {
  await db.transaction('rw', db.papers, db.analyses, db.questions, db.comparisons, async () => {
    await db.papers.delete(id);
    await db.analyses.where('paperId').equals(id).delete();
    await db.questions.where('paperId').equals(id).delete();
    // Remove this paper from any cross-paper comparisons; drop comparisons
    // that no longer have at least 2 papers.
    const comparisons = await db.comparisons.toArray();
    for (const c of comparisons) {
      if (!c.paperIds?.includes(id)) continue;
      const remaining = c.paperIds.filter((pid) => pid !== id);
      if (remaining.length < 2) {
        await db.comparisons.delete(c.id);
      } else {
        await db.comparisons.update(c.id, { paperIds: remaining });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

// The ONE place that decides whether a module's analysis counts as
// "completed" — used by the paper list cards, the paper detail page's
// header count, "analyze all未完成面向", and cross-paper comparison's
// paper-selection eligibility, so they can never disagree with each
// other. `status: 'done'` alone is NOT enough: a prior bug (see
// CLAUDE.md) could save status:'done' with an empty items array when
// Claude's response ended up producing nothing usable, and those old
// records are still sitting in existing users' IndexedDB — they must
// keep showing as incomplete until the module is actually re-analyzed
// successfully, not silently count toward "X/5". Note this deliberately
// does NOT look at lastAttemptError — a module whose most recent retry
// failed but which still holds a genuinely successful prior result (see
// saveAnalysis below) is still completed.
export function isAnalysisCompleted(analysis) {
  return analysis?.status === 'done' && Array.isArray(analysis.items) && analysis.items.length > 0;
}

// A module's "saved success state" and "did the most recent attempt fail"
// are two different things — a failed re-analysis must never turn an
// already-completed module back into an incomplete one. This function
// also never blindly trusts the caller's `status`: a save only counts as
// a genuine success when `items` really is a non-empty array — if a
// caller passes status:'done' with items that are missing, empty, or not
// an array at all (e.g. an object grouped by category — the exact shape
// that caused a real `analysis.items.map is not a function` crash, see
// CLAUDE.md), this function treats it as a failed attempt anyway rather
// than writing malformed data to IndexedDB.
//
//   - genuine success (Array.isArray(items) && items.length > 0, and the
//     caller isn't explicitly reporting an error): items replace the
//     existing ones outright, status:'done', any stale
//     lastAttemptError/lastAttemptAt from a previous failed retry is
//     cleared.
//   - anything else (explicit status:'error', OR items missing/empty/not
//     an array despite the caller claiming success) is a "failed
//     attempt". If there's already a genuinely completed result for this
//     module: KEEP status:'done' and the existing items untouched, and
//     record the failure on the side as lastAttemptError/lastAttemptAt —
//     the module is still completed (isAnalysisCompleted only looks at
//     status+items) and still usable for cross-paper comparison /
//     Markdown export. If there's nothing successful to preserve (first
//     attempt, or a prior attempt also never succeeded): status:'error',
//     items stay empty — genuinely incomplete.
export async function saveAnalysis(paperId, moduleId, data) {
  const existing = await db.analyses.where({ paperId, module: moduleId }).first();
  const now = Date.now();

  const itemsAreValid = Array.isArray(data.items) && data.items.length > 0;
  const callerClaimsSuccess = (data.status || 'done') !== 'error';
  const isGenuineSuccess = callerClaimsSuccess && itemsAreValid;

  // Whenever the caller thought this was a success but it doesn't meet
  // the bar (empty array, or not an array at all — e.g. Claude/a custom
  // model returning `items` grouped by category instead of a flat list),
  // and didn't already supply its own error message, fall back to one
  // that names the actual problem instead of leaving lastAttemptError
  // empty for what is very much a failure.
  const failureMessage = isGenuineSuccess
    ? null
    : data.error || (callerClaimsSuccess ? 'Claude 回傳的分析格式不完整，請重新分析。' : null);

  const existingWasCompleted = isAnalysisCompleted(existing);

  let record;
  if (isGenuineSuccess) {
    record = {
      id: existing?.id || `analysis-${uid()}`,
      paperId,
      module: moduleId,
      status: 'done',
      items: data.items,
      error: null,
      lastAttemptError: null,
      lastAttemptAt: null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      usage: data.usage || existing?.usage || null,
    };
  } else if (existingWasCompleted) {
    record = {
      id: existing.id,
      paperId,
      module: moduleId,
      status: 'done',
      items: existing.items,
      error: null,
      lastAttemptError: failureMessage,
      lastAttemptAt: now,
      createdAt: existing.createdAt,
      updatedAt: now,
      usage: existing.usage || null,
    };
  } else {
    record = {
      id: existing?.id || `analysis-${uid()}`,
      paperId,
      module: moduleId,
      status: 'error',
      items: [],
      error: failureMessage,
      lastAttemptError: null,
      lastAttemptAt: null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      usage: data.usage || existing?.usage || null,
    };
  }
  await db.analyses.put(record);
  return record;
}

export async function getAnalyses(paperId) {
  return db.analyses.where('paperId').equals(paperId).toArray();
}

export async function getAnalysis(paperId, moduleId) {
  return db.analyses.where({ paperId, module: moduleId }).first();
}

export async function deleteAnalysis(paperId, moduleId) {
  const row = await db.analyses.where({ paperId, module: moduleId }).first();
  if (row) await db.analyses.delete(row.id);
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function saveQuestion(paperId, question, answer) {
  const record = {
    id: `question-${uid()}`,
    paperId,
    question,
    answer, // { items, status, error }
    createdAt: Date.now(),
  };
  await db.questions.put(record);
  return record;
}

export async function getQuestions(paperId) {
  return db.questions.where('paperId').equals(paperId).reverse().sortBy('createdAt').then((rows) =>
    rows.sort((a, b) => b.createdAt - a.createdAt)
  );
}

export async function deleteQuestion(id) {
  await db.questions.delete(id);
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

export async function saveComparison(comparison) {
  const record = {
    id: `comparison-${uid()}`,
    paperIds: comparison.paperIds,
    focusQuestion: comparison.focusQuestion || '',
    findings: comparison.findings || [],
    status: comparison.status || 'done',
    error: comparison.error || null,
    // Optional, non-sensitive pipeline diagnostics (counts/typeCounts only
    // — see text.js: buildComparisonDiagnostics) so a "why did this come
    // back empty" investigation doesn't require having had DevTools open
    // at the time. Never contains an API key, prompt text, PDF text, or a
    // Claude response body — callers are responsible for only ever
    // passing the numeric summary, not raw diagnostics. Optional so old
    // records (and any caller that doesn't pass it) keep working with no
    // migration.
    diagnostics: comparison.diagnostics || null,
    // Claude's own short explanation for why a comparison legitimately
    // came back with 0 findings (comparisonStatus="insufficient_overlap"
    // — see prompts.js: validateComparisonStatus). Only ever set when
    // `findings` is empty; a non-empty comparison has nothing to explain,
    // so this stays null. Content is prompt-constrained to be short and
    // to describe only "why no comparison", never a new research claim —
    // still just plain text, same trust level as a `summary` field.
    emptyReason: comparison.emptyReason || null,
    createdAt: Date.now(),
  };
  await db.comparisons.put(record);
  return record;
}

export async function listComparisons() {
  const rows = await db.comparisons.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteComparison(id) {
  await db.comparisons.delete(id);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export async function logUsage(entry) {
  const record = {
    id: `usage-${uid()}`,
    timestamp: Date.now(),
    paperId: entry.paperId || null,
    kind: entry.kind || 'analysis', // analysis | question | comparison | ocr | test
    model: entry.model || '',
    inputTokens: entry.inputTokens || 0,
    outputTokens: entry.outputTokens || 0,
    cacheCreationTokens: entry.cacheCreationTokens || 0,
    cacheReadTokens: entry.cacheReadTokens || 0,
  };
  await db.usage.put(record);
  return record;
}

export async function getUsageSummary() {
  const rows = await db.usage.toArray();
  const summary = {
    requestCount: rows.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    hasCacheData: false,
  };
  for (const r of rows) {
    summary.inputTokens += r.inputTokens || 0;
    summary.outputTokens += r.outputTokens || 0;
    summary.cacheCreationTokens += r.cacheCreationTokens || 0;
    summary.cacheReadTokens += r.cacheReadTokens || 0;
    if (r.cacheCreationTokens || r.cacheReadTokens) summary.hasCacheData = true;
  }
  return summary;
}

export async function clearUsage() {
  await db.usage.clear();
}

// ---------------------------------------------------------------------------
// Backup / restore
//
// Backups intentionally EXCLUDE: settings.apiKey and papers[].fileBlob.
// Everything else needed to reconstruct the reading/analysis state is kept.
// ---------------------------------------------------------------------------

export async function exportBackup() {
  const [papers, analyses, questions, comparisons, settings] = await Promise.all([
    db.papers.toArray(),
    db.analyses.toArray(),
    db.questions.toArray(),
    db.comparisons.toArray(),
    getAllSettings(),
  ]);

  const papersNoBlob = papers.map(({ fileBlob, ...rest }) => rest);
  const { apiKey, ...settingsNoKey } = settings;

  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    papers: papersNoBlob,
    analyses,
    questions,
    comparisons,
    settings: settingsNoKey,
  };
}

export function validateBackup(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['備份檔不是有效的 JSON 物件'] };
  }
  if (typeof data.schemaVersion !== 'number') errors.push('缺少 schemaVersion');
  for (const key of ['papers', 'analyses', 'questions', 'comparisons']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      errors.push(`${key} 應為陣列`);
    }
  }
  if (data.settings !== undefined && typeof data.settings !== 'object') {
    errors.push('settings 應為物件');
  }
  return { valid: errors.length === 0, errors };
}

// Import merges by primary key: same-ID rows are overwritten (put), new
// rows are added. Papers restored from backup have no PDF blob, so the
// caller / UI should indicate re-upload is needed for the file itself.
export async function importBackup(data) {
  const { valid, errors } = validateBackup(data);
  if (!valid) throw new Error(`備份格式錯誤：${errors.join('、')}`);

  await db.transaction('rw', db.papers, db.analyses, db.questions, db.comparisons, db.settings, async () => {
    for (const p of data.papers || []) {
      const existing = await db.papers.get(p.id);
      await db.papers.put({ ...(existing || {}), ...p, fileBlob: existing?.fileBlob });
    }
    for (const a of data.analyses || []) await db.analyses.put(a);
    for (const q of data.questions || []) await db.questions.put(q);
    for (const c of data.comparisons || []) await db.comparisons.put(c);
    if (data.settings) {
      for (const [key, value] of Object.entries(data.settings)) {
        if (key === 'apiKey') continue; // never imported
        await db.settings.put({ key, value });
      }
    }
  });
}

// Clears papers/analyses/questions/comparisons/usage but keeps settings
// (API key, model, research background) intact. This is the ONLY function
// in this file that clears multiple tables at once, and it deliberately
// never touches `settings` — do not add `db.settings.clear()` here, and do
// not call this function from anywhere except a user-confirmed button
// click (see SettingsPage.jsx: it's gated behind a confirm() dialog).
export async function clearAllPaperData() {
  await db.transaction('rw', db.papers, db.analyses, db.questions, db.comparisons, db.usage, async () => {
    await db.papers.clear();
    await db.analyses.clear();
    await db.questions.clear();
    await db.comparisons.clear();
    await db.usage.clear();
  });
}

// ---------------------------------------------------------------------------
// Storage persistence
//
// By default, browsers may treat IndexedDB as "best-effort" storage: under
// disk pressure, or via a "clear cookies/site data on browser close"
// privacy setting, an origin's data can be evicted without any in-app
// action ever running. Requesting persistent storage is a defensive,
// best-effort mitigation — it does not guarantee data survives (the user
// can still clear site data manually, use a private/incognito window, or
// open the app from a different origin — e.g. http://127.0.0.1:5173 and
// http://localhost:5173 are different origins with entirely separate
// IndexedDB storage even though they point at the same dev server).
// ---------------------------------------------------------------------------

export async function requestPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// Returns true/false, or null if the browser doesn't expose this API at all.
export async function isStoragePersisted() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}
