import { useState } from 'react';
import { ScanText, RotateCcw, AlertTriangle } from 'lucide-react';
import { Card, Button, ErrorAlert } from './ui.jsx';
import { renderPageToImage, translatePdfError } from '../lib/pdf.js';
import { runOcrPage, resolveModelId } from '../lib/api.js';
import { paragraphsFromPlainText, buildSegments, detectReferences } from '../lib/text.js';
import { updatePaper, logUsage } from '../lib/storage.js';

// pageResults: { [pageNumber]: { status: 'pending'|'running'|'done'|'failed', text, error } }
export function OcrPanel({ paper, settings, onUpdated }) {
  const [running, setRunning] = useState(false);
  const [pageResults, setPageResults] = useState({});
  const [error, setError] = useState('');

  const alreadyOcred = paper.extractionMode === 'ocr';
  const canRun = !!paper.fileBlob;
  const modelId = resolveModelId(settings);

  async function ocrOnePage(pageNumber) {
    setPageResults((prev) => ({ ...prev, [pageNumber]: { status: 'running' } }));
    try {
      const { dataUrl } = await renderPageToImage(paper.fileBlob, pageNumber);
      const { text, usage } = await runOcrPage({ apiKey: settings.apiKey, model: modelId, dataUrl, pageNumber });
      await logUsage({ kind: 'ocr', model: modelId, paperId: paper.id, ...usage });
      setPageResults((prev) => ({ ...prev, [pageNumber]: { status: 'done', text } }));
      return { pageNumber, text };
    } catch (err) {
      // translatePdfError() only rewrites the pdf.js worker-loading
      // failure class (see pdf.js) — a Claude API error from runOcrPage()
      // passes through it unchanged, so it's safe to apply here even
      // though this one catch handles both possible error sources.
      const message = translatePdfError(err);
      setPageResults((prev) => ({ ...prev, [pageNumber]: { status: 'failed', error: message } }));
      return { pageNumber, error: message };
    }
  }

  // Merges fresh OCR results with whatever text the paper already had per
  // page, preferring the fresh result. This matters most for a re-run of
  // an already-OCR'd paper ("重新辨識全部頁面"): if this attempt fails for
  // some or all pages (bad API key, rate limit, network blip), we must
  // NOT silently overwrite pages that were successfully OCR'd before —
  // that would destroy good data because of a failed retry, the same
  // class of bug as the saveAnalysis() fix (see CLAUDE.md).
  async function persistResults(results) {
    const freshByPage = new Map(results.filter((r) => r.text !== undefined).map((r) => [r.pageNumber, r.text]));
    const existingByPage = new Map((paper.pages || []).map((p) => [p.page, p.text]));
    const allPageNumbers = new Set([...freshByPage.keys(), ...existingByPage.keys()]);

    const pages = [...allPageNumbers]
      .sort((a, b) => a - b)
      .map((page) => ({ page, text: freshByPage.has(page) ? freshByPage.get(page) : existingByPage.get(page) }))
      .filter((p) => p.text)
      .map((p) => ({ page: p.page, text: p.text, charCount: p.text.length }));

    if (pages.length === 0) {
      // Nothing usable came out of this attempt, and there was nothing
      // usable before either — leave the paper untouched.
      return;
    }

    const pagesWithParagraphs = pages.map((p) => ({ page: p.page, paragraphs: paragraphsFromPlainText(p.text) }));
    const segments = buildSegments(pagesWithParagraphs);
    const referenceInfo = detectReferences(segments);
    const updated = await updatePaper(paper.id, {
      pages,
      segments,
      referenceInfo,
      extractionMode: 'ocr',
      extractionStatus: 'done',
    });
    onUpdated(updated);
  }

  async function handleStart() {
    if (!settings.apiKey) {
      setError('請先至「設定」頁輸入 Claude API key 才能使用 OCR 辨識。');
      return;
    }
    setError('');
    setRunning(true);
    const results = [];
    for (let page = 1; page <= paper.pageCount; page++) {
      const r = await ocrOnePage(page);
      results.push(r);
    }
    const succeededCount = results.filter((r) => r.text !== undefined).length;
    if (succeededCount === 0) {
      setError('OCR 辨識全部失敗，請確認 API key 與網路連線後再試一次；先前已成功辨識的內容不會被清除。');
    } else if (succeededCount < results.length) {
      setError(`有 ${results.length - succeededCount} 頁辨識失敗，可以在下方針對失敗頁面個別重試。`);
    }
    await persistResults(results);
    setRunning(false);
  }

  async function handleRetry(pageNumber) {
    const r = await ocrOnePage(pageNumber);
    const merged = Object.entries({ ...pageResults, [pageNumber]: r.text !== undefined ? { status: 'done', text: r.text } : { status: 'failed' } }).map(
      ([p, v]) => ({ pageNumber: Number(p), text: v.text, error: v.error })
    );
    if (r.text !== undefined) {
      await persistResults(merged.filter((m) => m.text !== undefined));
    }
  }

  const failedPages = Object.entries(pageResults)
    .filter(([, v]) => v.status === 'failed')
    .map(([p]) => Number(p));
  const doneCount = Object.values(pageResults).filter((v) => v.status === 'done').length;

  if (alreadyOcred) {
    return (
      <Card>
        <div className="row" style={{ color: 'var(--info)' }}>
          <ScanText size={16} />
          <strong>此論文為掃描 PDF，引用核對以 OCR 文字為準。</strong>
        </div>
        <Button size="sm" className="mt-2" onClick={handleStart} disabled={running || !canRun}>
          <RotateCcw size={13} />
          重新辨識全部頁面
        </Button>
        {running && (
          <div className="mt-2">
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${(doneCount / paper.pageCount) * 100}%` }} />
            </div>
            <p className="faint mt-1">
              辨識中 {doneCount}/{paper.pageCount} 頁
            </p>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <div className="alert alert-warning">
        <AlertTriangle size={16} style={{ marginTop: 2, flexShrink: 0 }} />
        <div>
          這份 PDF 可能是掃描檔，無法直接取得文字（中位數每頁字數約 {Math.round(paper.scanInfo?.medianCharsPerPage || 0)} 字）。
          可以使用 Claude 圖片辨識建立可搜尋文字，這會依頁數額外使用 API 用量，請確認後再開始。
        </div>
      </div>
      <ErrorAlert message={error} onDismiss={() => setError('')} />
      {!canRun && <p className="muted">找不到此論文的 PDF 檔案（可能是從備份匯入但尚未重新上傳），無法執行 OCR。</p>}
      <Button variant="primary" onClick={handleStart} disabled={running || !canRun}>
        <ScanText size={14} />
        {running ? '辨識中...' : '開始辨識'}
      </Button>
      {running && (
        <div className="mt-2">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${(doneCount / paper.pageCount) * 100}%` }} />
          </div>
          <p className="faint mt-1">
            辨識中 {doneCount}/{paper.pageCount} 頁
          </p>
        </div>
      )}
      {failedPages.length > 0 && (
        <div className="mt-2">
          <p className="muted">以下頁面辨識失敗，可個別重試：</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {failedPages.map((p) => (
              <Button key={p} size="sm" onClick={() => handleRetry(p)}>
                重試第 {p} 頁
              </Button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
