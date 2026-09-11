import { useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import { Badge, Button, Loading, EmptyState, ErrorAlert, InlineNotice } from './ui.jsx';
import { isAnalysisCompleted } from '../lib/storage.js';
import { EvidenceModal } from './EvidenceModal.jsx';
import { verifyQuote } from '../lib/text.js';
import { normalizeSourceScope, normalizeWeaknessType } from '../lib/prompts.js';

const STATUS_ICON = { exact: CheckCircle2, partial: AlertTriangle, not_found: XCircle };
const STATUS_LABEL = { exact: '原文已核對', partial: '部分符合', not_found: '找不到原文' };

function EvidenceChip({ evidence, paper, onOpen }) {
  const verification = verifyQuote(evidence.quote, paper.segments, {
    hintSegmentId: evidence.segmentId,
    hintPage: evidence.page,
  });
  const Icon = STATUS_ICON[verification.status];
  return (
    <button type="button" className="evidence-chip" onClick={() => onOpen({ ...evidence, verification })}>
      <Icon size={13} />
      p.{verification.page ?? evidence.page ?? '?'}　{STATUS_LABEL[verification.status]}
    </button>
  );
}

function ItemCard({ item, paper, showSourceScope, showWeaknessType }) {
  const [openEvidence, setOpenEvidence] = useState(null);
  const weaknessType = showWeaknessType ? normalizeWeaknessType(item.weaknessType) : undefined;
  // Defensive: normalizeAnalysisItems() guarantees this for anything
  // saved going forward, but an individual item inside an otherwise-valid
  // items array could still be very old, pre-normalization data.
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  return (
    <div className="item-card">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="item-card-title">{item.title}</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Badge kind={item.kind} />
          {showSourceScope && <Badge kind={normalizeSourceScope(item.sourceScope)} />}
          {weaknessType && <Badge kind={weaknessType} />}
        </div>
      </div>
      <p className="mt-0" style={{ marginBottom: evidence.length ? 8 : 0 }}>
        {item.claim}
      </p>
      {evidence.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {evidence.map((ev, idx) => (
            <EvidenceChip key={idx} evidence={ev} paper={paper} onOpen={setOpenEvidence} />
          ))}
        </div>
      )}
      {item.kind === 'fact' && evidence.length === 0 && (
        <div className="inline-feedback inline-feedback-warning">
          <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
          缺少可核對原文
        </div>
      )}
      {openEvidence && <EvidenceModal evidence={openEvidence} paper={paper} onClose={() => setOpenEvidence(null)} />}
    </div>
  );
}

export function AnalysisModule({ moduleInfo, analysis, paper, onAnalyze, onOptionsChange, options, busy }) {
  // Never assume analysis.items is an array just because it's present —
  // storage.js's saveAnalysis() now guarantees this for anything saved
  // going forward, but a record written before that invariant existed
  // could still be sitting in IndexedDB with items as an object/string/
  // null (see CLAUDE.md: this is exactly what caused a real
  // `analysis.items.map is not a function` crash). `items` below is the
  // one safe array ever passed to .map(); hasMalformedItems flags that
  // legacy shape specifically so the UI can say so instead of either
  // crashing or silently treating it as "no result".
  const hasMalformedItems = analysis?.items !== undefined && !Array.isArray(analysis.items);
  const items = Array.isArray(analysis?.items) ? analysis.items : [];
  const hasResult = items.length > 0;

  return (
    <div>
      <div className="row-between mt-0 mb-2" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3 className="mt-0" style={{ marginBottom: 2 }}>
            {moduleInfo.label}
          </h3>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            {moduleInfo.shortDescription}
          </p>
          {moduleInfo.id === 'reproducibility' && (
            <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
              可復現性：如果另一個研究者只看這篇論文，能不能照作者寫的方法，把研究重新做一次，而且大致得到相同的流程或結果。
            </p>
          )}
        </div>
        <Button variant="primary" onClick={onAnalyze} disabled={busy}>
          <RefreshCw size={14} />
          {busy ? '分析中...' : hasResult ? '重新分析' : '開始分析'}
        </Button>
      </div>

      {moduleInfo.id === 'methodology' && (
        <div className="field" style={{ maxWidth: 320 }}>
          <label>指定比較對象（選填）</label>
          <p className="muted" style={{ fontSize: 13, marginTop: -2, marginBottom: 8 }}>
            想特別比較的模型、演算法或既有研究；沒有就留空。
          </p>
          <input
            className="input"
            placeholder="例如：ResNet、BERT、CoDel、某篇既有方法"
            value={options?.comparisonTarget || ''}
            onChange={(e) => onOptionsChange({ ...options, comparisonTarget: e.target.value })}
          />
        </div>
      )}
      {moduleInfo.id === 'data' && (
        <div className="field" style={{ maxWidth: 320 }}>
          <label>指定圖表（選填）</label>
          <p className="muted" style={{ fontSize: 13, marginTop: -2, marginBottom: 8 }}>
            想優先分析某張表格或圖，例如 Table 3、Figure 4；沒有就留空。
          </p>
          <input
            className="input"
            placeholder="例如：Table 3、Figure 4"
            value={options?.focusTable || ''}
            onChange={(e) => onOptionsChange({ ...options, focusTable: e.target.value })}
          />
        </div>
      )}

      {busy && <Loading label="分析中，請稍候..." />}

      {/* Legacy malformed record (items isn't an array at all) — this can
          only happen for data saved before saveAnalysis()'s invariant
          existed; new saves can never produce this shape. Takes priority
          over the other status-based messages below since the record's
          `status` field can't be trusted either in this case. */}
      {!busy && hasMalformedItems && (
        <InlineNotice kind="warning" message="先前分析資料格式異常，請重新分析。" />
      )}

      {!busy && !hasMalformedItems && analysis?.status === 'error' && (
        <ErrorAlert message={`分析失敗：${analysis.error}`} />
      )}

      {/* status: 'done' but with zero items is a legacy record from before
          the "empty result must be an error" fix (see CLAUDE.md) — it is
          NOT a completed analysis. Never show it as one; prompt a re-run
          instead of the generic "尚未分析" wording so it's clear this
          used to look successful and wasn't. */}
      {!busy && !hasMalformedItems && analysis?.status === 'done' && !isAnalysisCompleted(analysis) && (
        <InlineNotice kind="warning" message="先前分析沒有取得完整結果，請重新分析。" />
      )}

      {/* A re-analysis attempt failed, but this module already had a
          genuinely successful result — that result is still shown below
          (status stays 'done', items are untouched, see storage.js:
          saveAnalysis), this just notes the failed retry on the side. */}
      {!busy && isAnalysisCompleted(analysis) && analysis.lastAttemptError && (
        <InlineNotice kind="warning" message="最近一次重新分析失敗，目前顯示上一次成功結果。" />
      )}

      {!busy && hasResult && moduleInfo.id === 'data' && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          數據來源：這個數字／結果，到底是這篇論文自己產生的、引用別人的研究，還是作者整理多篇研究後得到的結論。
        </p>
      )}

      {!busy && hasResult && (
        <div className="stack">
          {items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              paper={paper}
              showSourceScope={moduleInfo.id === 'data'}
              showWeaknessType={moduleInfo.id === 'limitations'}
            />
          ))}
        </div>
      )}

      {!busy && !hasResult && !hasMalformedItems && analysis?.status !== 'error' && analysis?.status !== 'done' && (
        <EmptyState title="尚未分析" description={`點擊「開始分析」讓 Claude 分析「${moduleInfo.label}」面向。`} />
      )}
    </div>
  );
}
