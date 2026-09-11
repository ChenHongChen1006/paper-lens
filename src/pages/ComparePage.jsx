import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GitCompare, Trash2, AlertTriangle } from 'lucide-react';
import { Card, Button, Badge, Loading, ErrorAlert, InlineNotice, EmptyState } from '../components/ui.jsx';
import { useSettings } from '../hooks/useSettings.js';
import {
  listPapers,
  getAnalyses,
  listComparisons,
  saveComparison,
  deleteComparison,
  logUsage,
  isAnalysisCompleted,
} from '../lib/storage.js';
import { runComparison, resolveModelId, translateApiError } from '../lib/api.js';
import {
  verifyComparisonSources,
  dropUnsourcedComparisonFindings,
  dropSinglePaperFindings,
  dedupeComparisonSources,
  formatComparisonSourceLabel,
  buildComparisonDiagnostics,
  buildComparisonSourceIndex,
  resolveComparisonSource,
  bestVerificationStatus,
  validateComparisonSelection,
  pruneComparisonItems,
} from '../lib/text.js';
import { MODULES, getModule, COMPARISON_TYPE_LABELS } from '../lib/prompts.js';

// COMPARISON_TYPE_LABELS (prompts.js) already covers old data (consensus /
// contradiction / research_gap only) and the newer `difference` /
// `shared_limitation` types — reused directly here so this page never
// drifts out of sync with the tool schema's `type` enum. `consensus`'s
// label is "共同點", not "共識" — see prompts.js for why.
const TYPE_LABEL = COMPARISON_TYPE_LABELS;
// shared_limitation reuses the same neutral/grey "not_mentioned" badge
// style already used elsewhere in the app for "absent/missing" info
// (AnalysisModule.jsx's not_mentioned kind) — it's visually distinct from
// difference (amber) and contradiction (red), and "共同缺少的東西" fits
// that same neutral, non-alarming register.
const TYPE_BADGE = {
  consensus: 'exact',
  difference: 'partial',
  contradiction: 'not_found',
  shared_limitation: 'not_mentioned',
  research_gap: 'inference',
};

export function ComparePage() {
  const { settings } = useSettings();
  const [papers, setPapers] = useState(null);
  const [selected, setSelected] = useState([]);
  const [focusQuestion, setFocusQuestion] = useState('');
  const [comparisons, setComparisons] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Dev-only: which comparison cards currently have their diagnostics
  // panel expanded. Never touched/rendered in production — see the
  // import.meta.env.DEV guard around its only usage below.
  const [expandedDiagnosticsIds, setExpandedDiagnosticsIds] = useState(() => new Set());
  // Production feature (not DEV-only): which findings currently have
  // their sources' underlying "來源分析內容" (stored analysis claim text)
  // expanded, keyed by `${comparisonId}-${findingIndex}`. Lets a reader
  // judge for themselves whether a source actually supports the finding
  // it's attached to — see CLAUDE.md: local source-trace validation only
  // proves a source's ID is real and traceable to a saved analysis item,
  // never that its content is semantically relevant to the finding.
  const [expandedSourceContentKeys, setExpandedSourceContentKeys] = useState(() => new Set());

  async function reload() {
    const list = await listPapers();
    // Every uploaded paper is shown — including ones with zero analysis
    // yet, per the fix below. analysisCount decides whether its checkbox
    // is selectable, it no longer decides whether the paper appears at all
    // (hiding unanalyzed papers made it look like upload/comparison was
    // broken, since a paper the user just uploaded would simply vanish
    // from this page).
    const withAnalyses = [];
    for (const p of list) {
      const analyses = await getAnalyses(p.id);
      const count = analyses.filter(isAnalysisCompleted).length;
      withAnalyses.push({ ...p, analysisCount: count });
    }
    setPapers(withAnalyses);
    setComparisons(await listComparisons());
    // A selected paper that was deleted since should drop out of the
    // selection rather than silently linger and get sent to Claude later.
    const stillExistingIds = new Set(withAnalyses.map((p) => p.id));
    setSelected((prev) => prev.filter((id) => stillExistingIds.has(id)));
  }

  useEffect(() => {
    reload();
  }, []);

  function toggleSelect(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // Defensive: the checkbox is already `disabled` for a 0-analysis
      // paper, so this shouldn't normally fire from a real click — but
      // never let an unanalyzed paper make it into the comparison either way.
      const paper = papers?.find((p) => p.id === id);
      if (!paper || paper.analysisCount === 0) return prev;
      const next = [...prev, id];
      const check = validateComparisonSelection(next);
      if (!check.valid && check.reason === 'too_many') {
        setNotice(check.message);
        return prev;
      }
      setNotice('');
      return next;
    });
  }

  async function handleCompare() {
    const selectionCheck = validateComparisonSelection(selected);
    if (!selectionCheck.valid) {
      setError(selectionCheck.message);
      return;
    }
    if (!settings?.apiKey) {
      setError('請先至「設定」頁輸入 Claude API key。');
      return;
    }
    setError('');
    setNotice('');
    setRunning(true);
    try {
      const rawItems = [];
      const missingPaperIds = [];
      let usablePaperCount = 0;

      for (const paperId of selected) {
        // Defensive: a paper selected earlier could in principle have been
        // deleted since (e.g. from another tab) — skip it instead of
        // crashing on `paper.title` below.
        const paper = papers.find((p) => p.id === paperId);
        if (!paper) {
          missingPaperIds.push(paperId);
          continue;
        }
        const analyses = await getAnalyses(paperId);
        let paperHasItems = false;
        // Only genuinely completed modules feed the comparison — a module
        // whose most recent attempt errored (even if it still has old
        // preserved items for the user to look at on its own tab) isn't a
        // reliable source for a NEW cross-paper comparison.
        for (const a of analyses.filter(isAnalysisCompleted)) {
          for (const item of a.items || []) {
            // verificationStatus mirrors PaperLens' own vocabulary for a
            // quote's local check: exact / partial / not_found / (here)
            // unavailable when there's no evidence to check at all. The
            // `verified` boolean is a strict derivative of it — partial
            // still needs a human to confirm, so it must NOT count as
            // verified, only exact does.
            const verificationStatus = bestVerificationStatus(item.evidence, paper.segments);
            rawItems.push({
              paperId,
              paperTitle: paper.title,
              itemId: item.id,
              module: a.module,
              title: item.title,
              claim: item.claim,
              kind: item.kind,
              verificationStatus,
              verified: item.kind === 'fact' && verificationStatus === 'exact',
              // Only 數據細節 (data) items carry sourceScope and only
              // 弱點與延伸 (limitations) items carry weaknessType — pass
              // through whatever the item actually has so Claude can use
              // it (e.g. weaknessType helps it judge whether a
              // not_mentioned item is a genuine shared_limitation
              // candidate). buildComparisonUserContent only emits the
              // XML attribute when the value is present.
              ...(item.sourceScope ? { sourceScope: item.sourceScope } : {}),
              ...(item.weaknessType ? { weaknessType: item.weaknessType } : {}),
            });
            paperHasItems = true;
          }
        }
        if (paperHasItems) usablePaperCount += 1;
      }

      if (usablePaperCount < 2) {
        setError('至少需要 2 篇「目前仍存在且有分析結果」的論文才能比較，請重新選擇。');
        return;
      }

      // Prune BEFORE building the source index — Claude is only ever shown
      // the pruned set (runComparison prunes again internally, but pruning
      // is deterministic so the two agree), so local source validation
      // must match exactly what was actually sent, not the larger
      // pre-prune set.
      const items = pruneComparisonItems(rawItems);
      // The ONE authoritative source of truth for every field a source
      // chip needs (paperTitle, module, itemTitle, claim, ...) — see
      // text.js: resolveComparisonSource. Claude is only ever trusted to
      // supply {paperId, itemId}; everything else about a source always
      // comes from this index, never from anything Claude's structured
      // output returns (a previous round had Claude echo back the claim
      // text for local verification — removed, see CLAUDE.md, because it
      // rejected too many legitimate citations over trivial wording/
      // punctuation differences without adding real protection against
      // the actual problem, irrelevant-but-real citations).
      const sourceIndex = buildComparisonSourceIndex(items);
      const validKeys = new Set(sourceIndex.keys());

      const model = resolveModelId(settings);
      const { data, usage, diagnostics } = await runComparison({ apiKey: settings.apiKey, model, items, focusQuestion });
      await logUsage({ kind: 'comparison', model, ...usage });

      // runComparison() already threw if comparisonStatus was internally
      // inconsistent with data.findings (see prompts.js:
      // validateComparisonStatus) — by this point comparisonStatus is
      // trustworthy relative to the pre-source-validation findings count.
      // emptyReason is only ever meaningful when findings was empty; kept
      // as plain text (same trust level as any other finding `summary` —
      // prompt-constrained to describe only "why no comparison", not a
      // new claim) for display, not folded into the numeric diagnostics.
      const emptyReason = typeof data.emptyReason === 'string' ? data.emptyReason.trim() : '';

      // `data.findings` has already been through normalizeComparisonFindings
      // (api.js) — malformed entries and finding.type values outside
      // COMPARISON_TYPES are already gone, with their reasons recorded in
      // `diagnostics.rejections`. What's left here is source ID
      // validation: is each cited {paperId, itemId} a real item that was
      // actually sent to Claude? That's a provenance/traceability check —
      // NOT semantic support verification. Passing it proves the citation
      // points at a real, correctly-identified item; it does not and
      // cannot prove that item's content actually supports the finding
      // it's attached to (see verifyComparisonSources' doc comment in
      // text.js, and CLAUDE.md, for the full reasoning — including why an
      // earlier attempt at a stronger claim-text check was removed for
      // being too strict without adding real protection).
      const rawFindingCount = diagnostics?.rawItemCount ?? (Array.isArray(data.findings) ? data.findings.length : 0);
      const rawFindings = Array.isArray(data.findings) ? data.findings : [];
      const rawSourceCount = rawFindings.reduce((sum, f) => sum + (Array.isArray(f?.sources) ? f.sources.length : 0), 0);

      const idChecked = verifyComparisonSources(rawFindings, validKeys);
      const validSourceIdCount = idChecked.reduce((sum, f) => sum + f.sources.length, 0);
      const invalidSourceIdCount = rawSourceCount - validSourceIdCount;

      // Dedup AFTER id validation, BEFORE dropUnsourcedComparisonFindings —
      // a finding whose only sources are the same analysis item cited
      // twice must not be treated any differently than one with a single
      // citation; dedup never turns a non-empty sources array into an
      // empty one, so ordering relative to the empty-source guard doesn't
      // matter, but doing it here means every downstream consumer
      // (diagnostics counts, the saved record, the rendered chips)
      // already sees the deduped set.
      const sourceVerified = idChecked.map((f) => ({ ...f, sources: dedupeComparisonSources(f.sources) }));

      // A finding whose sources are ALL invalid (either it cited nothing
      // at all, or everything it cited turned out to be hallucinated) has
      // no genuine trace left to show — keeping it as a "0/N sources"
      // card would just be displaying an unfounded claim with a warning
      // icon next to it. Reject the whole card in that case; a card with
      // at least one real source stays, with only the bad ones stripped
      // (never dropped wholesale just for having *some* invalid sources —
      // see verifyComparisonSources).
      const { kept: withValidSources, dropped: droppedForNoSources } = dropUnsourcedComparisonFindings(sourceVerified);
      const findingsAfterIdValidation = withValidSources.length;

      // A "cross-paper" finding whose surviving sources all collapse onto
      // a single paper isn't actually cross-paper — reject it too. This is
      // a distinct filter from dropUnsourcedComparisonFindings (a finding
      // can have several valid sources and still fail this one if they're
      // all from the same paper).
      const { kept: withMultiPaperSources, dropped: droppedForSinglePaper } = dropSinglePaperFindings(withValidSources);

      // Built BEFORE the processing-error check below (not after) so the
      // counts are available for both the DEV console log AND the thrown
      // error message on a failed attempt — a "this came back empty, was
      // it Claude or was it us" investigation needs these regardless of
      // which path this run takes. Only counts/typeCounts, per the design
      // — see buildComparisonDiagnostics' own comment for what it
      // deliberately excludes (raw rejection `value`s, finding text,
      // source claim/title text, prompt/PDF content, the API key).
      const diagnosticsSummary = buildComparisonDiagnostics({
        rawFindingCount,
        normalizedFindingCount: diagnostics?.normalizedItemCount ?? 0,
        rejections: diagnostics?.rejections ?? [],
        rawSourceCount,
        invalidSourceIdCount,
        findingsAfterIdValidation,
        singlePaperFindingCount: droppedForSinglePaper.length,
        finalFindings: withMultiPaperSources,
        comparisonStatus: typeof data.comparisonStatus === 'string' ? data.comparisonStatus : null,
      });

      if (import.meta.env.DEV) {
        console.debug('[PaperLens] Comparison debug', {
          'selected papers': selected.length,
          'input analysis items': rawItems.length,
          'items after pruning': items.length,
          ...diagnosticsSummary,
        });
      }

      // A comparison that "succeeds" (no max_tokens truncation, no API
      // error) but where Claude DID try to produce findings and every
      // single one got filtered out during processing is the same class
      // of bug as the single-paper "fake success" case (see CLAUDE.md):
      // status would look like a normal, complete comparison with zero
      // cards, indistinguishable in the UI from "AI genuinely found
      // nothing to compare". Those are different situations and must be
      // handled differently — a genuine 0-from-Claude result (rawFindingCount
      // === 0) is a legitimate, save-able outcome; losing everything
      // DURING local processing (invalid source IDs OR single-paper
      // rejection) is a processing error that must surface to the user
      // instead of silently saving an empty "success" (and must NOT be
      // persisted with diagnostics attached — there is nothing legitimate
      // to save here). The message is deliberately short — internal
      // pipeline-stage details (which sources were invalid, why) belong in
      // the DEV diagnostics log and the persisted diagnostics, not in a
      // wall of text a normal user has no use for.
      if (rawFindingCount > 0 && withMultiPaperSources.length === 0) {
        throw new Error('比較失敗：產生的結果無法可靠連結到來源分析，請重新比較。');
      }

      const findings = withMultiPaperSources.map((f) => ({
        ...f,
        sources: f.sources.map((s) => {
          // Claude is only ever trusted for {paperId, itemId} — every
          // other field comes from this app's own stored data via
          // resolveComparisonSource, never from Claude's response.
          const resolved = resolveComparisonSource(sourceIndex, s);
          return {
            paperId: s.paperId,
            itemId: s.itemId,
            module: resolved?.module ?? null,
            itemTitle: resolved?.itemTitle ?? null,
            itemClaim: resolved?.claim ?? null,
          };
        }),
      }));

      const usedPaperIds = selected.filter((id) => !missingPaperIds.includes(id));
      await saveComparison({
        paperIds: usedPaperIds,
        focusQuestion,
        findings,
        status: 'done',
        diagnostics: diagnosticsSummary,
        // Only meaningful (and only ever non-empty) when findings is
        // empty — a non-empty comparison has nothing to explain.
        emptyReason: findings.length === 0 ? emptyReason : '',
      });
      await reload();
      setSelected([]);
      setFocusQuestion('');
      if (missingPaperIds.length > 0) {
        setNotice(`有 ${missingPaperIds.length} 篇選取的論文已不存在，比較時已自動略過。`);
      }
    } catch (err) {
      setError(translateApiError(err));
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('確定要刪除這筆比較結果嗎？')) return;
    await deleteComparison(id);
    await reload();
  }

  function toggleDiagnostics(id) {
    setExpandedDiagnosticsIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSourceContent(key) {
    setExpandedSourceContentKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (papers === null) return <Loading label="載入中..." />;

  const analyzedCount = papers.filter((p) => p.analysisCount > 0).length;

  return (
    <div>
      <div className="page-header">
        <h1>跨篇比較</h1>
        <p>選擇 2-10 篇論文進行比較。尚未分析的論文需要先完成至少一個分析面向。</p>
      </div>

      <p className="muted" style={{ fontSize: 13 }}>
        跨篇比較會根據各篇已保存的分析結果整理共同點、差異與研究空缺，不會重新讀取 PDF 全文；尚未分析的面向不會被納入。
      </p>
      <p className="muted" style={{ fontSize: 13 }}>
        跨篇比較是 AI 根據已保存的單篇分析進行綜合整理；來源分析可追溯，但比較結論與來源的語意關係仍建議人工確認。
      </p>

      <ErrorAlert message={error} onDismiss={() => setError('')} />
      <InlineNotice kind="warning" message={notice} />

      {papers.length === 0 ? (
        <EmptyState
          icon={GitCompare}
          title="還沒有上傳任何論文"
          description="請先到「論文」頁面上傳 PDF，並完成至少一個分析面向，才能加入比較。"
        />
      ) : (
        <Card>
          <h3 className="mt-0">選擇論文（已選 {selected.length}/10）</h3>
          {analyzedCount < 2 && (
            <InlineNotice kind="warning" message="至少需要 2 篇有分析結果的論文才能開始比較。" />
          )}
          <div className="stack mt-1">
            {papers.map((p) => {
              const disabled = p.analysisCount === 0;
              return (
                <label
                  key={p.id}
                  className="checkbox-row"
                  style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    disabled={disabled}
                    onChange={() => toggleSelect(p.id)}
                  />
                  <span className="checkbox-row-label">
                    {p.title}
                    {disabled ? (
                      <span className="faint">　尚未分析，請先完成至少 1 個分析面向</span>
                    ) : (
                      <span className="faint">
                        　（已完成 {p.analysisCount}/{MODULES.length} 個面向）
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="field mt-2">
            <label>聚焦問題（選填）</label>
            <input
              className="input"
              placeholder="例如：高負載下的延遲表現"
              value={focusQuestion}
              onChange={(e) => setFocusQuestion(e.target.value)}
            />
          </div>

          <Button variant="primary" onClick={handleCompare} disabled={running || selected.length < 2}>
            {running ? '比較中...' : '開始比較'}
          </Button>
        </Card>
      )}

      <div className="mt-3">
        <h3>比較結果紀錄</h3>
        {comparisons?.length === 0 && <p className="muted">還沒有比較結果。</p>}
        {comparisons?.map((c) => (
          <Card key={c.id} className="mt-2">
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="faint">{new Date(c.createdAt).toLocaleString('zh-TW')}</div>
                {c.focusQuestion && <strong>聚焦問題：{c.focusQuestion}</strong>}
                <div className="faint mt-1">{Array.isArray(c.paperIds) ? c.paperIds.length : 0} 篇論文</div>
              </div>
              <Button size="sm" variant="danger" onClick={() => handleDelete(c.id)}>
                <Trash2 size={13} />
              </Button>
            </div>
            <div className="stack mt-2">
              {/* Array.isArray guard: a comparison record's findings should
                  always be an array (see verifyComparisonSources), but
                  render defensively against old/malformed data anyway
                  rather than crashing the whole page. This state is only
                  reachable via a genuinely-saved comparison (see
                  handleCompare's rawFindingCount>0-but-all-filtered guard,
                  which throws instead of saving in that case) — so an
                  empty findings array here really does mean Claude itself
                  concluded there was little to compare, not that
                  something got silently dropped during processing. The
                  copy below must not claim "沒有共識／矛盾／研究缺口" —
                  that overstates the AI's certainty and (before this fix)
                  also omitted the newer 差異 type entirely. Prefer
                  Claude's own `emptyReason` (comparisonStatus=
                  "insufficient_overlap", validated for internal
                  consistency in api.js) when the record has one — it says
                  specifically what Claude judged insufficient, instead of
                  a generic guess. Old records (saved before this field
                  existed) fall back to the generic line. */}
              {!(Array.isArray(c.findings) && c.findings.length > 0) && (
                <div>
                  <p className="muted" style={{ marginBottom: 4 }}>目前沒有產生可用的跨篇比較結果。</p>
                  <p className="muted mt-0" style={{ fontSize: 13 }}>
                    {c.emptyReason || '可能是兩篇研究的重疊範圍較少，或現有單篇分析不足以支持可靠比較。'}
                  </p>
                </div>
              )}
              {(Array.isArray(c.findings) ? c.findings : []).map((f, idx) => {
                // Defensive re-dedup at render time (already deduped at
                // save time in handleCompare) — cheap, idempotent, and
                // covers any saved record that predates the dedup fix.
                // Keyed on paperId+itemId, never on display text.
                const sources = dedupeComparisonSources(f.sources);
                const sourceContentKey = `${c.id}-${idx}`;
                const sourceContentExpanded = expandedSourceContentKeys.has(sourceContentKey);
                return (
                  <div key={idx} className="item-card">
                    <div className="row-between" style={{ alignItems: 'flex-start' }}>
                      <div className="item-card-title">{f.title}</div>
                      <div className="row" style={{ gap: 4, alignItems: 'center', flexShrink: 0 }}>
                        <Badge kind={TYPE_BADGE[f.type]}>{TYPE_LABEL[f.type] || f.type}</Badge>
                        {/* Low-key, neutral — never the primary badge, and
                            never colored to look like an error. PaperLens
                            has confirmed the sources below are real,
                            traceable analysis items (see the page intro
                            text) but has NOT automatically confirmed their
                            content is semantically relevant to this
                            finding — that distinction is the whole point
                            of this badge. Applies to every finding
                            uniformly (old and new comparisons alike),
                            since it's a statement about what this
                            pipeline can and can't prove, not per-record
                            data — so it's rendered unconditionally here,
                            never persisted. */}
                        <Badge kind="source_pending">來源待確認</Badge>
                      </div>
                    </div>
                    <p className="mt-0">{f.summary}</p>
                    {f.unverifiedSourceCount > 0 && (
                      <div className="row faint" style={{ color: 'var(--warning)' }}>
                        <AlertTriangle size={12} />
                        有 {f.unverifiedSourceCount} 筆引用來源找不到對應的分析項目，已略過。
                      </div>
                    )}
                    {sources.length > 0 && (
                      <>
                        <div className="row mt-1" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                          <span className="faint">來源分析：</span>
                          {sources.map((s, sIdx) => {
                            const paper = papers.find((p) => p.id === s.paperId);
                            const moduleLabel = getModule(s.module)?.label || s.module;
                            // itemTitle/itemClaim are only present on
                            // comparisons saved after this fix —
                            // formatComparisonSourceLabel degrades cleanly
                            // to the old two-part "paper · module" format
                            // when itemTitle is missing.
                            const { short, full } = formatComparisonSourceLabel({
                              paperTitle: paper?.title || s.paperId,
                              moduleLabel,
                              itemTitle: s.itemTitle,
                            });
                            return (
                              <Link
                                key={sIdx}
                                to={`/papers/${s.paperId}?tab=${s.module || 'overview'}`}
                                className="evidence-chip"
                                style={{ textDecoration: 'none' }}
                                title={full}
                              >
                                {short}
                              </Link>
                            );
                          })}
                          {/* This is a production feature (every user can
                              use it), not a DEV-only tool: local
                              source-trace validation only proves each
                              source's ID is real and traceable — it can't
                              prove the source is actually relevant to the
                              finding, so showing the real, locally-stored
                              content (never anything Claude returned) lets
                              a reader judge that for themselves. Skipped
                              when no source here has itemClaim recorded
                              (old comparisons saved before this feature
                              existed). */}
                          {sources.some((s) => s.itemClaim) && (
                            <button
                              type="button"
                              className="faint"
                              style={{
                                fontSize: 12,
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                                textDecoration: 'underline',
                              }}
                              onClick={() => toggleSourceContent(sourceContentKey)}
                            >
                              {sourceContentExpanded ? '隱藏來源分析' : '查看來源分析'}
                            </button>
                          )}
                        </div>
                        {sourceContentExpanded && (
                          <div className="stack mt-1" style={{ fontSize: 13 }}>
                            <div className="faint">請確認下列來源分析是否真的支持上方的跨篇比較結論。</div>
                            {sources
                              .filter((s) => s.itemClaim)
                              .map((s, sIdx) => {
                                const paper = papers.find((p) => p.id === s.paperId);
                                const moduleLabel = getModule(s.module)?.label || s.module;
                                return (
                                  <div key={sIdx} className="faint" style={{ lineHeight: 1.6 }}>
                                    <div>論文：{paper?.title || s.paperId}</div>
                                    {moduleLabel && <div>面向：{moduleLabel}</div>}
                                    {s.itemTitle && <div>分析項目：{s.itemTitle}</div>}
                                    <div>來源分析內容：「{s.itemClaim}」</div>
                                  </div>
                                );
                              })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Dev-only diagnostics viewer — never shown in production
                (GitHub Pages), and deliberately low-key even in dev (a
                plain text-button, not a prominent action) since it's a
                debugging aid, not a feature for normal use. Persisted
                diagnostics (storage.js: saveComparison's `diagnostics`
                field, only counts — never the API key, prompt, PDF text,
                or a Claude response body) exist specifically so this is
                readable even if DevTools wasn't open when the comparison
                actually ran. */}
            {import.meta.env.DEV && (
              <div className="mt-2">
                <button
                  type="button"
                  className="faint"
                  style={{
                    fontSize: 12,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                  onClick={() => toggleDiagnostics(c.id)}
                >
                  {expandedDiagnosticsIds.has(c.id) ? '隱藏診斷資訊' : '查看診斷資訊'}
                </button>
                {expandedDiagnosticsIds.has(c.id) && (
                  <div className="faint" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
                    {c.diagnostics ? (
                      <>
                        {/* `?? '—'`, not `?? 0` — older diagnostics shapes
                            used different field names for these exact
                            stages (see CLAUDE.md's dated entries), so a
                            genuinely-missing field here means "not
                            recorded in this comparison's format", not
                            "recorded as zero". Distinguishing those two
                            matters for a diagnostics panel whose whole
                            point is not guessing numbers. */}
                        <div>Raw findings：{c.diagnostics.rawFindingCount ?? '—'}</div>
                        <div>Normalized：{c.diagnostics.normalizedFindingCount ?? '—'}</div>
                        <div>Raw sources：{c.diagnostics.rawSourceCount ?? '—'}</div>
                        <div>Invalid source ID：{c.diagnostics.invalidSourceIdCount ?? '—'}</div>
                        <div>After ID validation：{c.diagnostics.findingsAfterIdValidation ?? '—'}</div>
                        <div>Single-paper rejected：{c.diagnostics.singlePaperFindingCount ?? '—'}</div>
                        <div>Final：{c.diagnostics.finalFindingCount ?? '—'}</div>
                        {c.diagnostics.comparisonStatus && <div>comparisonStatus：{c.diagnostics.comparisonStatus}</div>}
                        <div className="mt-1">類型：</div>
                        <div>共同點 {c.diagnostics.typeCounts?.consensus ?? 0}</div>
                        <div>差異 {c.diagnostics.typeCounts?.difference ?? 0}</div>
                        <div>矛盾 {c.diagnostics.typeCounts?.contradiction ?? 0}</div>
                        {/* Old diagnostics (saved before shared_limitation existed) simply
                            have no typeCounts.shared_limitation key — `?? 0` covers that
                            the same way it already covers every other type here. */}
                        <div>共同限制 {c.diagnostics.typeCounts?.shared_limitation ?? 0}</div>
                        <div>研究缺口 {c.diagnostics.typeCounts?.research_gap ?? 0}</div>
                      </>
                    ) : (
                      <div>此筆比較沒有診斷資訊（舊資料，或儲存時尚未記錄）。</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
