import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { computeExcludedSegmentIds } from '../lib/text.js';
import { Card, Button } from './ui.jsx';
import { ParsedTextPanel } from './ParsedTextPanel.jsx';

export function ParseInfoPanel({ paper, onToggleExcludeReferences }) {
  const [showParsedText, setShowParsedText] = useState(false);
  const totalChars = (paper.pages || []).reduce((sum, p) => sum + (p.charCount || p.text?.length || 0), 0);
  const referenceInfo = paper.referenceInfo || {};
  const excludedIds = computeExcludedSegmentIds(paper.segments || [], referenceInfo);

  return (
    <div>
      <Card>
        <h3 className="mt-0">解析資訊</h3>
        <table className="simple-table">
          <tbody>
            <tr>
              <th>總頁數</th>
              <td>{paper.pageCount}</td>
            </tr>
            <tr>
              <th>擷取字數</th>
              <td>{totalChars.toLocaleString()} 字</td>
            </tr>
            <tr>
              <th>擷取方式</th>
              <td>{paper.extractionMode === 'ocr' ? 'OCR（掃描 PDF）' : '文字 PDF'}</td>
            </tr>
            <tr>
              <th>判定參考文獻</th>
              <td>{referenceInfo.referencesStart ? `第 ${referenceInfo.referencesStart.page} 頁開始` : '未偵測到'}</td>
            </tr>
            <tr>
              <th>是否找到附錄</th>
              <td>{referenceInfo.appendixStart ? `是，第 ${referenceInfo.appendixStart.page} 頁開始（重新納入分析）` : '否'}</td>
            </tr>
            <tr>
              <th>不送給 Claude 的段落</th>
              <td>{excludedIds.size > 0 ? `${excludedIds.size} 段（參考文獻區塊）` : '無'}</td>
            </tr>
          </tbody>
        </table>
        {referenceInfo.notes && <p className="faint mt-1">{referenceInfo.notes}</p>}

        {referenceInfo.referencesStart && (
          <label className="checkbox-row mt-2">
            <input
              type="checkbox"
              checked={!!referenceInfo.userDisabled}
              onChange={(e) => onToggleExcludeReferences(e.target.checked)}
            />
            <span className="checkbox-row-label">
              取消排除參考文獻（如果自動判斷錯誤，可以勾選讓參考文獻區塊也送給 Claude 分析）
            </span>
          </label>
        )}

        <div className="mt-2">
          <Button size="sm" onClick={() => setShowParsedText((v) => !v)}>
            {showParsedText ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {showParsedText ? '隱藏解析出的文字' : '查看解析出的文字'}
          </Button>
        </div>
      </Card>

      {showParsedText && (
        <div className="mt-2">
          <ParsedTextPanel paper={paper} />
        </div>
      )}
    </div>
  );
}
