import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Search, FileText } from 'lucide-react';
import { Button, EmptyState, ErrorAlert, Loading } from '../components/ui.jsx';
import { PaperCard } from '../components/PaperCard.jsx';
import { listPapers, deletePaper, db, isAnalysisCompleted } from '../lib/storage.js';
import { ingestPdfFile } from '../lib/ingest.js';

export function PapersPage() {
  const [papers, setPapers] = useState(null);
  const [completedCounts, setCompletedCounts] = useState({});
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const reload = useCallback(async () => {
    const [list, analyses] = await Promise.all([listPapers(), db.analyses.toArray()]);
    setPapers(list);
    const counts = {};
    for (const a of analyses) {
      if (!isAnalysisCompleted(a)) continue;
      counts[a.paperId] = (counts[a.paperId] || 0) + 1;
    }
    setCompletedCounts(counts);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) {
      setError('請選擇 PDF 檔案。');
      return;
    }
    setError('');
    setUploading(true);

    // Uploading never overwrites or deletes an existing paper — every
    // upload always creates a brand-new paper record with its own ID
    // (see ingest.js). This is just a courtesy heads-up so the user isn't
    // surprised by an unintentional duplicate; canceling simply skips
    // that one file, nothing existing is ever touched.
    const knownFileNames = new Set((papers || []).map((p) => p.fileName.toLowerCase()));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (knownFileNames.has(file.name.toLowerCase())) {
        const proceed = confirm(
          `已經有一篇檔名相同的論文「${file.name}」。繼續上傳「不會」覆蓋或刪除現有論文與分析結果，而是新增為另一篇獨立的論文。是否繼續？`
        );
        if (!proceed) continue;
      }
      knownFileNames.add(file.name.toLowerCase());

      setUploadProgress({ fileIndex: i + 1, fileCount: files.length, fileName: file.name, page: null });
      try {
        await ingestPdfFile(file, {
          onProgress: ({ current, total }) =>
            setUploadProgress({ fileIndex: i + 1, fileCount: files.length, fileName: file.name, page: `${current}/${total}` }),
        });
      } catch (err) {
        setError((prev) => `${prev ? prev + '\n' : ''}${file.name} 解析失敗：${err.message || err}`);
      }
      await reload();
    }
    setUploading(false);
    setUploadProgress(null);
  }

  async function handleDelete(paper) {
    if (!confirm(`確定要刪除「${paper.title}」嗎？相關的分析結果、提問紀錄也會一併刪除。`)) return;
    await deletePaper(paper.id);
    await reload();
  }

  const filtered = (papers || []).filter((p) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return p.title.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q);
  });

  return (
    <div>
      <div className="page-header">
        <h1>論文</h1>
        <p>上傳 PDF、檢視解析狀態，並進入單篇論文進行分析與提問。</p>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError('')} />

      <div
        className={`dropzone ${dragOver ? 'dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <Upload size={22} style={{ marginBottom: 8 }} />
        <p style={{ marginBottom: 10 }}>拖曳 PDF 到這裡，或</p>
        <Button variant="primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          選擇 PDF 檔案（可多選）
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
        {uploadProgress && (
          <div className="mt-2" style={{ maxWidth: 360, margin: '10px auto 0' }}>
            <Loading
              label={`正在解析 (${uploadProgress.fileIndex}/${uploadProgress.fileCount})：${uploadProgress.fileName}${
                uploadProgress.page ? `　第 ${uploadProgress.page} 頁` : ''
              }`}
            />
          </div>
        )}
      </div>

      {papers && papers.length > 5 && (
        <div className="field mt-2" style={{ maxWidth: 320 }}>
          <div className="input-with-action">
            <Search size={16} style={{ alignSelf: 'center', color: 'var(--text-muted)' }} />
            <input
              className="input"
              placeholder="搜尋標題或檔名..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="mt-3">
        {papers === null && <Loading label="載入論文列表中..." />}
        {papers !== null && filtered.length === 0 && papers.length === 0 && (
          <EmptyState icon={FileText} title="還沒有任何論文" description="上傳第一篇 PDF 開始使用 PaperLens。" />
        )}
        {papers !== null && filtered.length === 0 && papers.length > 0 && (
          <EmptyState icon={Search} title="沒有符合搜尋條件的論文" />
        )}
        {filtered.length > 0 && (
          <div className="paper-grid">
            {filtered.map((p) => (
              <PaperCard key={p.id} paper={p} completedCount={completedCounts[p.id] || 0} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
