import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Modal, Badge, Button, InlineNotice } from './ui.jsx';
import { findQuoteHighlight } from '../lib/text.js';
import { openPdfBlobAtPage } from '../lib/pdf.js';

function HighlightedText({ text, quote }) {
  const range = findQuoteHighlight(text, quote);
  if (!range) return <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;
  return (
    <p style={{ whiteSpace: 'pre-wrap' }}>
      {text.slice(0, range.start)}
      <mark className="pl-highlight">{text.slice(range.start, range.end)}</mark>
      {text.slice(range.end)}
    </p>
  );
}

// evidence: { segmentId, page, quote, verification: { status, segmentId, page, matchedText, similarity, pageMismatch } }
export function EvidenceModal({ evidence, paper, onClose }) {
  const [pdfLink, setPdfLink] = useState(null);
  const v = evidence.verification;
  const segment = v?.segmentId ? paper.segments.find((s) => s.id === v.segmentId) : null;

  useEffect(() => {
    if (!paper.fileBlob) return undefined;
    const page = v?.page || evidence.page;
    const { href, revoke } = openPdfBlobAtPage(paper.fileBlob, page);
    setPdfLink(href);
    return revoke;
  }, [paper.fileBlob, v?.page, evidence.page]);

  const statusLabel = { exact: '原文已核對', partial: '部分符合', not_found: '原文找不到這句' }[v?.status] || '未核對';
  const statusBadgeKind = v?.status || 'not_found';

  return (
    <Modal title="原文依據" onClose={onClose} wide>
      <div className="row mb-2" style={{ flexWrap: 'wrap' }}>
        <Badge kind={statusBadgeKind}>{statusLabel}</Badge>
        <span className="faint">
          Claude 標示頁碼：p.{evidence.page}
          {v?.pageMismatch ? `（本機核對實際在 p.${v.page}）` : ''}
        </span>
        {paper.extractionMode === 'ocr' && <span className="faint">此論文為掃描 PDF，核對以 OCR 文字為準</span>}
      </div>

      <div className="card" style={{ background: 'var(--bg)' }}>
        <div className="faint mt-0" style={{ marginBottom: 6 }}>
          Claude 引用的句子：
        </div>
        <p style={{ fontStyle: 'italic' }}>「{evidence.quote}」</p>
      </div>

      {v?.status === 'not_found' && (
        <div className="mt-2">
          <InlineNotice
            kind="danger"
            message="在論文全文中找不到與此引用相符的句子。可能原因：Claude 改寫了原文、PDF 解析有誤，或這是 AI 幻覺內容，請謹慎採信這一項重點。"
          />
        </div>
      )}

      {segment && (
        <div className="mt-2">
          <div className="faint" style={{ marginBottom: 6 }}>
            {v.status === 'partial' ? '比對到的段落（相似度 ' + Math.round(v.similarity * 100) + '%）：' : '原文段落：'}　第 {segment.page} 頁・{segment.id}
          </div>
          <HighlightedText text={segment.text} quote={v.status === 'exact' ? evidence.quote : ''} />
        </div>
      )}

      <div className="row mt-2">
        {pdfLink ? (
          <a href={pdfLink} target="_blank" rel="noreferrer">
            <Button>
              <ExternalLink size={14} />
              在 PDF 開啟第 {v?.page || evidence.page} 頁
            </Button>
          </a>
        ) : (
          <span className="faint">找不到此論文的 PDF 檔案（可能是從備份匯入但尚未重新上傳 PDF）。</span>
        )}
      </div>
      {pdfLink && (
        <p className="faint mt-1">若瀏覽器的 PDF 檢視器不支援自動跳頁，開啟後請自行前往第 {v?.page || evidence.page} 頁。</p>
      )}
    </Modal>
  );
}
