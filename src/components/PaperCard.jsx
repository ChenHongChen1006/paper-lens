import { Link } from 'react-router-dom';
import { FileText, ScanText, Trash2 } from 'lucide-react';
import { Card, Button } from './ui.jsx';
import { MODULES } from '../lib/prompts.js';

export function PaperCard({ paper, completedCount, onDelete }) {
  const date = new Date(paper.createdAt).toLocaleDateString('zh-TW');
  return (
    <Card className="paper-card">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 8 }}>
          <FileText size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <Link to={`/papers/${paper.id}`} style={{ fontWeight: 600, textDecoration: 'none', color: 'var(--text)' }}>
              {paper.title}
            </Link>
            <div className="faint">{paper.fileName}</div>
          </div>
        </div>
      </div>

      <div className="row" style={{ fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>{paper.pageCount ? `${paper.pageCount} 頁` : '解析中'}</span>
        <span>·</span>
        <span>{date}</span>
        <span>·</span>
        <span>
          分析 {completedCount}/{MODULES.length}
        </span>
        {paper.extractionMode === 'ocr' && (
          <>
            <span>·</span>
            <span className="row" style={{ gap: 3 }}>
              <ScanText size={12} /> OCR
            </span>
          </>
        )}
        {paper.extractionStatus === 'error' && (
          <>
            <span>·</span>
            <span style={{ color: 'var(--danger)' }}>解析失敗</span>
          </>
        )}
      </div>

      <div className="row-between mt-1">
        <Link to={`/papers/${paper.id}`}>
          <Button size="sm">開啟</Button>
        </Link>
        <Button size="sm" variant="danger" onClick={() => onDelete(paper)}>
          <Trash2 size={13} />
          刪除
        </Button>
      </div>
    </Card>
  );
}
