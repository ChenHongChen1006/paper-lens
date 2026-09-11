import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Play, Copy, Download, ArrowLeft } from 'lucide-react';
import { Button, ErrorAlert, InlineNotice, Loading } from '../components/ui.jsx';
import { ParseInfoPanel } from '../components/ParseInfoPanel.jsx';
import { OcrPanel } from '../components/OcrPanel.jsx';
import { AnalysisModule } from '../components/AnalysisModule.jsx';
import { QuestionPanel } from '../components/QuestionPanel.jsx';
import { useSettings } from '../hooks/useSettings.js';
import { MODULES } from '../lib/prompts.js';
import { runModuleAnalysis, resolveModelId, translateApiError } from '../lib/api.js';
import { filterSendableSegments } from '../lib/text.js';
import {
  getPaper,
  getAnalyses,
  saveAnalysis,
  logUsage,
  updatePaper,
  getQuestions,
  isAnalysisCompleted,
} from '../lib/storage.js';
import { buildPaperMarkdown, downloadMarkdown, copyToClipboard } from '../lib/export.js';

const TABS = [
  { id: 'parse', label: '解析資訊' },
  ...MODULES.map((m) => ({ id: m.id, label: m.label })),
  { id: 'ask', label: '問這篇論文' },
];

export function PaperDetailPage() {
  const { paperId } = useParams();
  const [searchParams] = useSearchParams();
  const { settings } = useSettings();
  const [paper, setPaper] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [analyses, setAnalyses] = useState({});
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'parse');
  const [moduleOptions, setModuleOptions] = useState({});
  const [busyModule, setBusyModule] = useState(null);
  const [batchProgress, setBatchProgress] = useState(null);
  const [error, setError] = useState('');
  const [copyNotice, setCopyNotice] = useState('');

  const reloadPaper = useCallback(async () => {
    const p = await getPaper(paperId);
    if (!p) {
      setNotFound(true);
      return;
    }
    setPaper(p);
  }, [paperId]);

  const reloadAnalyses = useCallback(async () => {
    const list = await getAnalyses(paperId);
    const map = {};
    for (const a of list) map[a.module] = a;
    setAnalyses(map);
  }, [paperId]);

  useEffect(() => {
    reloadPaper();
    reloadAnalyses();
  }, [reloadPaper, reloadAnalyses]);

  // Paper ingestion (text extraction) runs in the background right after
  // upload; poll while it's still in progress so this page doesn't show
  // stale "0 pages / no segments" state if the user navigates here fast.
  useEffect(() => {
    if (paper?.extractionStatus !== 'processing') return undefined;
    const id = setInterval(reloadPaper, 1200);
    return () => clearInterval(id);
  }, [paper?.extractionStatus, reloadPaper]);

  if (notFound) {
    return (
      <div>
        <p>找不到這篇論文，可能已被刪除。</p>
        <Link to="/">
          <Button>返回論文列表</Button>
        </Link>
      </div>
    );
  }

  if (!paper || !settings) return <Loading label="載入論文中..." />;

  async function analyzeOne(moduleId) {
    setBusyModule(moduleId);
    try {
      if (!settings.apiKey) {
        throw new Error('請先至「設定」頁輸入 Claude API key。');
      }
      if (!paper.segments || paper.segments.length === 0) {
        throw new Error('這篇論文目前沒有可分析的文字內容（可能還在解析中，或是掃描 PDF 尚未完成 OCR）。');
      }
      const model = resolveModelId(settings);
      const segments = filterSendableSegments(paper.segments, paper.referenceInfo);
      const options = moduleOptions[moduleId] || {};
      const { data, usage } = await runModuleAnalysis({
        apiKey: settings.apiKey,
        model,
        segments,
        moduleId,
        researchBackground: settings.researchBackground,
        comparisonTarget: options.comparisonTarget,
        focusTable: options.focusTable,
      });
      await logUsage({ kind: 'analysis', model, paperId, ...usage });
      const record = await saveAnalysis(paperId, moduleId, { status: 'done', items: data.items || [], usage });
      setAnalyses((prev) => ({ ...prev, [moduleId]: record }));
      return { ok: true };
    } catch (err) {
      const message = translateApiError(err);
      // Full technical detail goes to the console for debugging; the
      // screen only ever shows the short translated message (see
      // ErrorAlert below) — never the raw SDK error object.
      console.error(`[PaperLens] 分析「${moduleId}」失敗：`, err);
      try {
        const record = await saveAnalysis(paperId, moduleId, { status: 'error', items: [], error: message });
        setAnalyses((prev) => ({ ...prev, [moduleId]: record }));
      } catch (saveErr) {
        // Persisting the error record itself failed (e.g. a genuine
        // IndexedDB problem). Don't let that become a second, unhandled
        // rejection that silently resets the UI with no message at all —
        // still return the original failure below so the user sees it.
        console.error('[PaperLens] 儲存分析錯誤狀態時也失敗：', saveErr);
      }
      return { ok: false, message };
    } finally {
      setBusyModule(null);
    }
  }

  async function handleAnalyzeModule(moduleId) {
    setError('');
    const result = await analyzeOne(moduleId);
    if (!result.ok) setError(result.message);
  }

  async function handleAnalyzeAll() {
    setError('');
    const pending = MODULES.filter((m) => !isAnalysisCompleted(analyses[m.id]));
    if (pending.length === 0) return;
    const failures = [];
    for (let i = 0; i < pending.length; i++) {
      setBatchProgress({ current: i + 1, total: pending.length, label: pending[i].label });
      const result = await analyzeOne(pending[i].id);
      if (!result.ok) failures.push(`${pending[i].label}：${result.message}`);
    }
    setBatchProgress(null);
    if (failures.length > 0) setError(`以下面向分析失敗：\n${failures.join('\n')}`);
  }

  async function handleToggleExcludeReferences(disabled) {
    const updated = await updatePaper(paperId, {
      referenceInfo: { ...(paper.referenceInfo || {}), userDisabled: disabled },
    });
    setPaper(updated);
  }

  async function handleExportMarkdown(action) {
    const questions = await getQuestions(paperId);
    const analysesByModule = {};
    for (const m of MODULES) analysesByModule[m.id] = analyses[m.id];
    const markdown = buildPaperMarkdown(paper, analysesByModule, questions);
    if (action === 'copy') {
      await copyToClipboard(markdown);
      setCopyNotice('已複製 Markdown 到剪貼簿。');
      setTimeout(() => setCopyNotice(''), 3000);
    } else {
      downloadMarkdown(`${paper.title}.md`, markdown);
    }
  }

  const completedCount = MODULES.filter((m) => isAnalysisCompleted(analyses[m.id])).length;
  const showOcrBanner = paper.scanInfo?.isScanned;

  return (
    <div>
      <Link to="/" className="row faint" style={{ textDecoration: 'none', marginBottom: 8, gap: 4 }}>
        <ArrowLeft size={13} /> 返回論文列表
      </Link>
      <div className="page-header">
        <h1>{paper.title}</h1>
        <p>
          {paper.fileName} ・ {paper.pageCount} 頁 ・ 分析 {completedCount}/{MODULES.length}
        </p>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError('')} />
      <InlineNotice kind="success" message={copyNotice} />

      {paper.extractionStatus === 'processing' && (
        <div className="inline-feedback inline-feedback-info mb-2">
          <div className="spinner" />
          正在解析 PDF 文字，請稍候...
        </div>
      )}
      {paper.extractionStatus === 'error' && <ErrorAlert message={`PDF 解析失敗：${paper.extractionError}`} />}

      {showOcrBanner && (
        <div className="mb-2">
          <OcrPanel paper={paper} settings={settings} onUpdated={setPaper} />
        </div>
      )}

      <div className="row-between mb-2" style={{ flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={handleAnalyzeAll} disabled={!!busyModule || !!batchProgress}>
          <Play size={14} />
          分析全部未完成面向
        </Button>
        <div className="row">
          <Button onClick={() => handleExportMarkdown('copy')}>
            <Copy size={14} />
            複製 Markdown
          </Button>
          <Button onClick={() => handleExportMarkdown('download')}>
            <Download size={14} />
            下載 Markdown
          </Button>
        </div>
      </div>

      {batchProgress && (
        <div className="card mb-2">
          <div className="row-between">
            <span>
              {batchProgress.current} / {batchProgress.total}　正在分析：{batchProgress.label}
            </span>
            <div className="spinner" />
          </div>
          <div className="progress-bar mt-1">
            <div className="progress-bar-fill" style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }} />
          </div>
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab-btn ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'parse' && <ParseInfoPanel paper={paper} onToggleExcludeReferences={handleToggleExcludeReferences} />}

      {MODULES.some((m) => m.id === activeTab) && (
        <AnalysisModule
          moduleInfo={MODULES.find((m) => m.id === activeTab)}
          analysis={analyses[activeTab]}
          paper={paper}
          busy={busyModule === activeTab || (!!batchProgress && !analyses[activeTab])}
          options={moduleOptions[activeTab]}
          onOptionsChange={(opts) => setModuleOptions((prev) => ({ ...prev, [activeTab]: opts }))}
          onAnalyze={() => handleAnalyzeModule(activeTab)}
        />
      )}

      {activeTab === 'ask' && <QuestionPanel paper={paper} settings={settings} />}
    </div>
  );
}
