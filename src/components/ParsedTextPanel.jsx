// ParsedTextPanel — debug view of what pdf.js actually extracted and what
// will actually be sent to Claude. Reads paper.pages/segments verbatim
// (no re-parsing, no Claude call, no summarizing) so it's trustworthy for
// diagnosing extraction or References/Appendix detection problems.
//
// The include/exclude status shown here MUST come from the same function
// the prompt builder uses (computeExcludedSegmentIds, which
// filterSendableSegments in text.js also calls) — see CLAUDE.md.

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Card, Badge, EmptyState } from './ui.jsx';
import { computeExcludedSegmentIds } from '../lib/text.js';

const STATUS_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'included', label: '會分析的內容' },
  { id: 'excluded', label: '已排除' },
];

export function ParsedTextPanel({ paper }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [pageFilter, setPageFilter] = useState('all');
  const [openPages, setOpenPages] = useState(() => new Set());

  const segments = paper.segments || [];
  const referenceInfo = paper.referenceInfo || {};
  const excludedIds = useMemo(() => computeExcludedSegmentIds(segments, referenceInfo), [segments, referenceInfo]);

  const pageNumbers = useMemo(() => {
    const seen = [];
    const set = new Set();
    for (const s of segments) {
      if (!set.has(s.page)) {
        set.add(s.page);
        seen.push(s.page);
      }
    }
    return seen.sort((a, b) => a - b);
  }, [segments]);

  const query = search.trim().toLowerCase();

  const filteredSegments = useMemo(() => {
    return segments.filter((s) => {
      if (pageFilter !== 'all' && s.page !== Number(pageFilter)) return false;
      const isExcluded = excludedIds.has(s.id);
      if (statusFilter === 'included' && isExcluded) return false;
      if (statusFilter === 'excluded' && !isExcluded) return false;
      if (query && !s.text.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [segments, pageFilter, statusFilter, excludedIds, query]);

  const pagesToShow = useMemo(() => {
    const byPage = new Map();
    for (const s of filteredSegments) {
      if (!byPage.has(s.page)) byPage.set(s.page, []);
      byPage.get(s.page).push(s);
    }
    return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  }, [filteredSegments]);

  // When there's an active search, auto-expand the first page that has a
  // match so results aren't hidden behind a collapsed <details>. Manual
  // toggles (tracked in openPages) are otherwise left alone.
  useEffect(() => {
    if (!query) return;
    const firstMatchPage = pagesToShow[0]?.[0];
    if (firstMatchPage == null) return;
    setOpenPages((prev) => (prev.has(firstMatchPage) ? prev : new Set(prev).add(firstMatchPage)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function togglePage(page, open) {
    setOpenPages((prev) => {
      const next = new Set(prev);
      if (open) next.add(page);
      else next.delete(page);
      return next;
    });
  }

  return (
    <div>
      <Card className="mb-2">
        <p className="muted" style={{ marginBottom: 4, fontSize: 13 }}>
          這裡可以查看 PaperLens 從 PDF 讀出的文字。參考文獻等不需要分析的內容會自動排除。
        </p>
        <p className="faint" style={{ marginBottom: 12 }}>顯示的排除範圍，就是實際送去分析的範圍，兩者一致。</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div className="input-with-action" style={{ maxWidth: 320, flex: 1 }}>
            <Search size={16} style={{ alignSelf: 'center', color: 'var(--text-muted)' }} />
            <input
              className="input"
              placeholder="搜尋段落文字..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="select" style={{ width: 'auto' }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATUS_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <select className="select" style={{ width: 'auto' }} value={pageFilter} onChange={(e) => setPageFilter(e.target.value)}>
            <option value="all">全部頁面</option>
            {pageNumbers.map((p) => (
              <option key={p} value={p}>
                第 {p} 頁
              </option>
            ))}
          </select>
        </div>
        <p className="faint mt-1" style={{ marginBottom: 0 }}>
          共 {segments.length} 個段落，符合目前篩選條件 {filteredSegments.length} 個。
        </p>
      </Card>

      {pagesToShow.length === 0 && (
        <EmptyState icon={Search} title="沒有符合篩選條件的段落" description="請調整搜尋文字或篩選條件。" />
      )}

      {pagesToShow.map(([page, pageSegments]) => (
        <details key={page} className="card mb-2" open={openPages.has(page)} onToggle={(e) => togglePage(page, e.target.open)}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            第 {page} 頁　<span className="faint" style={{ fontWeight: 400 }}>（{pageSegments.length} 段）</span>
          </summary>
          <div className="stack mt-2">
            {pageSegments.map((seg) => (
              <SegmentEntry
                key={seg.id}
                segment={seg}
                excluded={excludedIds.has(seg.id)}
                isReferencesStart={referenceInfo.referencesStart?.segmentId === seg.id}
                isAppendixStart={referenceInfo.appendixStart?.segmentId === seg.id}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function SegmentEntry({ segment, excluded, isReferencesStart, isAppendixStart }) {
  return (
    <>
      {isReferencesStart && (
        <div className="boundary-marker boundary-marker-exclude">參考文獻排除從這裡開始</div>
      )}
      {isAppendixStart && (
        <div className="boundary-marker boundary-marker-include">偵測到附錄標題，從這裡開始重新納入分析</div>
      )}
      <div className="item-card">
        <div className="row-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <code className="faint">{segment.id}</code>
            <span className="faint">第 {segment.page} 頁</span>
          </div>
          {excluded && <Badge kind="not_found">已排除・參考文獻</Badge>}
        </div>
        <p className="mt-1" style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
          {segment.text}
        </p>
      </div>
    </>
  );
}
