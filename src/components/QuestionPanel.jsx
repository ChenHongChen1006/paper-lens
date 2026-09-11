import { useEffect, useRef, useState } from 'react';
import { Trash2, Send, MessageSquare } from 'lucide-react';
import { Card, Button, Badge, Loading, ErrorAlert, EmptyState } from './ui.jsx';
import { EvidenceModal } from './EvidenceModal.jsx';
import { runCustomQuestion, resolveModelId, translateApiError } from '../lib/api.js';
import { filterSendableSegments, verifyQuote } from '../lib/text.js';
import { getQuestions, saveQuestion, deleteQuestion, logUsage } from '../lib/storage.js';

// Clicking one of these only fills the textarea (see handleQuickQuestion) —
// it never submits automatically, so the user can still edit the question
// or decide not to send it, and no API call happens just from a click.
const QUICK_QUESTIONS = [
  { label: '主要研究什麼？', question: '這篇論文主要在研究什麼？' },
  { label: '最重要的結果？', question: '這篇論文最重要的結果是什麼？' },
  { label: '為什麼用這個方法？', question: '作者為什麼使用這個方法？' },
  { label: '這個結果代表什麼？', question: '這個結果代表什麼？' },
  { label: '有哪些限制？', question: '這篇研究有哪些限制？' },
  { label: '未來可以研究什麼？', question: '未來還可以繼續研究什麼？' },
];

function AnswerItem({ item, paper }) {
  const [openEvidence, setOpenEvidence] = useState(null);
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  return (
    <div className="item-card">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="item-card-title">{item.title}</div>
        <Badge kind={item.kind} />
      </div>
      <p className="mt-0" style={{ marginBottom: evidence.length ? 8 : 0 }}>
        {item.claim}
      </p>
      {evidence.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {evidence.map((ev, idx) => {
            const verification = verifyQuote(ev.quote, paper.segments, {
              hintSegmentId: ev.segmentId,
              hintPage: ev.page,
            });
            return (
              <button
                key={idx}
                type="button"
                className="evidence-chip"
                onClick={() => setOpenEvidence({ ...ev, verification })}
              >
                p.{verification.page ?? ev.page ?? '?'}
                {{ exact: '原文已核對', partial: '部分符合', not_found: '找不到原文' }[verification.status]}
              </button>
            );
          })}
        </div>
      )}
      {openEvidence && <EvidenceModal evidence={openEvidence} paper={paper} onClose={() => setOpenEvidence(null)} />}
    </div>
  );
}

export function QuestionPanel({ paper, settings }) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(null);
  const textareaRef = useRef(null);

  function handleQuickQuestion(text) {
    // Only fills the textarea — replaces whatever was there before. The
    // user still has to press "送出提問" themselves; this never calls the
    // Claude API on its own.
    setQuestion(text);
    textareaRef.current?.focus();
  }

  async function reload() {
    setHistory(await getQuestions(paper.id));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.id]);

  async function handleAsk(e) {
    e.preventDefault();
    if (!question.trim()) return;
    if (!settings.apiKey) {
      setError('請先至「設定」頁輸入 Claude API key。');
      return;
    }
    setError('');
    setAsking(true);
    try {
      const model = resolveModelId(settings);
      const segments = filterSendableSegments(paper.segments, paper.referenceInfo);
      const { data, usage } = await runCustomQuestion({
        apiKey: settings.apiKey,
        model,
        segments,
        question: question.trim(),
        researchBackground: settings.researchBackground,
      });
      await logUsage({ kind: 'question', model, paperId: paper.id, ...usage });
      await saveQuestion(paper.id, question.trim(), { items: data.items || [], status: 'done' });
      setQuestion('');
      await reload();
    } catch (err) {
      setError(translateApiError(err));
    } finally {
      setAsking(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('確定要刪除這筆提問紀錄嗎？')) return;
    await deleteQuestion(id);
    await reload();
  }

  return (
    <div>
      <Card>
        <h3 className="mt-0" style={{ marginBottom: 2 }}>
          問這篇論文
        </h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          直接問你看不懂或想深入了解的地方，回答會盡量附上原文依據。
        </p>

        <div className="field" style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>常見問題</label>
          <div className="quick-question-row mt-1">
            {QUICK_QUESTIONS.map((q) => (
              <Button key={q.label} type="button" size="sm" onClick={() => handleQuickQuestion(q.question)}>
                {q.label}
              </Button>
            ))}
          </div>
        </div>

        <form onSubmit={handleAsk}>
          <textarea
            ref={textareaRef}
            className="textarea"
            rows={3}
            placeholder="想問這篇論文什麼？例如：作者為什麼這樣做？這個結果代表什麼？"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Button type="submit" variant="primary" className="mt-2" disabled={asking || !question.trim()}>
            <Send size={14} />
            {asking ? '分析中...' : '送出提問'}
          </Button>
        </form>
        <ErrorAlert message={error} onDismiss={() => setError('')} />
        {asking && <Loading label="Claude 分析中..." />}
      </Card>

      <div className="mt-3">
        {history === null && <Loading label="載入提問紀錄中..." />}
        {history?.length === 0 && <EmptyState icon={MessageSquare} title="還沒有提問紀錄" />}
        {history?.map((q) => (
          <Card key={q.id} className="mt-2">
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <div>
                <strong>Q：{q.question}</strong>
                <div className="faint">{new Date(q.createdAt).toLocaleString('zh-TW')}</div>
              </div>
              <Button size="sm" variant="danger" onClick={() => handleDelete(q.id)}>
                <Trash2 size={13} />
              </Button>
            </div>
            <div className="stack mt-2">
              {/* Array.isArray guard, not just `|| []` — a non-array
                  truthy value (e.g. a string) would otherwise slip past
                  `|| []` and crash .map(). See AnalysisModule.jsx for the
                  same class of bug this mirrors. */}
              {(Array.isArray(q.answer?.items) ? q.answer.items : []).map((item) => (
                <AnswerItem key={item.id} item={item} paper={paper} />
              ))}
              {!(Array.isArray(q.answer?.items) && q.answer.items.length > 0) && (
                <p className="muted">無回答內容。</p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
