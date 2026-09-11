// text.js — pure text utilities: normalization, paragraph reconstruction,
// reference/appendix detection, scanned-PDF detection, and quote
// verification against the paper's extracted segments.
//
// Everything in this file is a pure function operating on plain data
// (strings / arrays of {id, page, text}) so it can be unit tested without
// touching pdf.js, Dexie, or the network.

import { COMPARISON_TYPES } from './prompts.js';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Normalizes text for comparison purposes: Unicode NFKC, unify quotes/
// dashes, collapse all whitespace (including newlines) to single spaces,
// and lowercase. This is ONLY used for matching, never for display.
export function normalizeText(text) {
  if (!text) return '';
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '') // soft hyphen
    .replace(/-\n\s*/g, '') // dehyphenate across a line break
    .replace(/\n/g, ' ')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function tokenizeWords(normalized) {
  return normalized.split(' ').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Paragraph reconstruction
//
// Geometry-derived line grouping happens in pdf.js (it needs pdfjs item
// positions). This function takes the resulting per-page lines — each
// flagged with whether it starts a new paragraph — and turns them into
// clean paragraph strings: dehyphenating wrapped words, joining wrapped
// lines with a single space, and collapsing extra whitespace.
// ---------------------------------------------------------------------------

const HYPHEN_RE = /[-‐‑]$/;

export function buildParagraphsFromLines(lines) {
  const paragraphs = [];
  let current = '';

  const flush = () => {
    const cleaned = current.replace(/[ \t]+/g, ' ').trim();
    if (cleaned) paragraphs.push(cleaned);
    current = '';
  };

  for (const line of lines) {
    const text = (line.text || '').trim();
    if (!text) continue;

    if (line.newParagraph && current) flush();

    if (!current) {
      current = text;
      continue;
    }

    const prevEndsHyphen = HYPHEN_RE.test(current);
    const nextStartsLower = /^[a-z]/.test(text);
    if (prevEndsHyphen && nextStartsLower) {
      // Likely a word wrapped across the line break: drop the hyphen and
      // join directly. (Heuristic — genuine hyphenated compounds that
      // happen to wrap here will lose their hyphen; see README limitations.)
      current = current.replace(HYPHEN_RE, '') + text;
    } else {
      current += ` ${text}`;
    }
  }
  flush();

  return paragraphs;
}

// Used for OCR output, which already comes back as plain text with blank
// lines between paragraphs rather than pdfjs geometry data.
export function paragraphsFromPlainText(text) {
  return (text || '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

export function segmentIdFor(page, index) {
  return `p${page}-s${index}`;
}

// Turns { page, paragraphs: string[] }[] into a flat segments array with
// stable IDs.
export function buildSegments(pagesWithParagraphs) {
  const segments = [];
  for (const { page, paragraphs } of pagesWithParagraphs) {
    paragraphs.forEach((text, idx) => {
      segments.push({ id: segmentIdFor(page, idx + 1), page, text });
    });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Scanned-PDF detection
// ---------------------------------------------------------------------------

const SCANNED_CHAR_THRESHOLD = 40;

export function detectScannedPdf(pages) {
  if (!pages || pages.length === 0) {
    return { isScanned: false, medianCharsPerPage: 0, lowTextPageRatio: 0 };
  }
  const counts = pages.map((p) => p.charCount ?? (p.text || '').length).sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  const median = counts.length % 2 === 0 ? (counts[mid - 1] + counts[mid]) / 2 : counts[mid];
  const lowTextPageRatio =
    counts.filter((c) => c < SCANNED_CHAR_THRESHOLD).length / counts.length;
  const isScanned = median < SCANNED_CHAR_THRESHOLD || lowTextPageRatio > 0.6;
  return { isScanned, medianCharsPerPage: median, lowTextPageRatio };
}

// ---------------------------------------------------------------------------
// References / Appendix detection
//
// Heuristic, not perfect by design (accuracy > false automation, per spec):
//  - a heading candidate must be a short standalone segment matching a
//    references-like title
//  - it must sit in the second half of the document
//  - the segments that follow it must look bibliography-like (citation
//    patterns), otherwise we don't trust the heading
//  - if an Appendix-like heading appears after References, content from
//    that point back onward is re-included
// ---------------------------------------------------------------------------

const REFERENCES_HEADING_RE =
  /^(references|reference\s*list|bibliography|works\s+cited|參考文獻|参考文献)\s*[:：]?$/i;

const APPENDIX_HEADING_RE =
  /^(appendix(es)?|appendices|supplementary\s+material(s)?|supplement(ary)?|附錄)\b/i;

const CITATION_PATTERN_RE =
  /(\[\d+\])|(\(\d{4}[a-z]?\))|(\bdoi\s*:?\s*10\.)|(\bpp\.\s*\d)|^[A-Z][a-zA-Z.'-]+,\s?[A-Z]\.|et al\.|, \d{4}\./;

function looksLikeHeading(text) {
  return text.length <= 40;
}

function citationScore(segments, startIdx, count = 8) {
  const slice = segments.slice(startIdx, startIdx + count);
  if (slice.length === 0) return 0;
  const hits = slice.filter((s) => CITATION_PATTERN_RE.test(s.text)).length;
  return hits / slice.length;
}

export function detectReferences(segments) {
  const result = {
    referencesStart: null, // { segmentId, page }
    appendixStart: null, // { segmentId, page }
    confidence: 0,
    notes: '',
  };
  if (!segments || segments.length === 0) return result;

  const total = segments.length;
  let refIdx = -1;

  for (let i = 0; i < total; i++) {
    const seg = segments[i];
    const trimmed = seg.text.trim();
    if (!looksLikeHeading(trimmed)) continue;
    if (!REFERENCES_HEADING_RE.test(trimmed)) continue;
    // Must be in the second half of the document.
    if (i / total < 0.4) continue;
    const score = citationScore(segments, i + 1);
    if (score >= 0.35) {
      refIdx = i;
      result.confidence = score;
      break;
    }
  }

  if (refIdx === -1) {
    result.notes = '未偵測到可信的參考文獻區塊。';
    return result;
  }

  result.referencesStart = { segmentId: segments[refIdx].id, page: segments[refIdx].page };
  result.notes = `於第 ${segments[refIdx].page} 頁偵測到參考文獻標題，後續內容引用特徵比例 ${(result.confidence * 100).toFixed(0)}%。`;

  for (let i = refIdx + 1; i < total; i++) {
    const trimmed = segments[i].text.trim();
    if (looksLikeHeading(trimmed) && APPENDIX_HEADING_RE.test(trimmed)) {
      result.appendixStart = { segmentId: segments[i].id, page: segments[i].page };
      result.notes += ` 於第 ${segments[i].page} 頁偵測到附錄標題，其後內容將重新納入分析範圍。`;
      break;
    }
  }

  return result;
}

// Computes the set of excluded segment IDs given detection results and an
// optional user override that cancels exclusion entirely.
export function computeExcludedSegmentIds(segments, referenceInfo) {
  if (!referenceInfo || referenceInfo.userDisabled || !referenceInfo.referencesStart) {
    return new Set();
  }
  const startIdx = segments.findIndex((s) => s.id === referenceInfo.referencesStart.segmentId);
  if (startIdx === -1) return new Set();

  let endIdx = segments.length; // exclusive
  if (referenceInfo.appendixStart) {
    const appendixIdx = segments.findIndex((s) => s.id === referenceInfo.appendixStart.segmentId);
    if (appendixIdx !== -1) endIdx = appendixIdx;
  }

  const excluded = new Set();
  for (let i = startIdx; i < endIdx; i++) excluded.add(segments[i].id);
  return excluded;
}

// Segments actually sent to Claude: everything except the excluded
// (references, unless the user disabled exclusion) range.
export function filterSendableSegments(segments, referenceInfo) {
  const excluded = computeExcludedSegmentIds(segments, referenceInfo);
  if (excluded.size === 0) return segments;
  return segments.filter((s) => !excluded.has(s.id));
}

// ---------------------------------------------------------------------------
// Quote verification
//
// Three tiers: exact (verbatim substring after normalization), partial
// (word-order-preserving fuzzy match above a threshold), not_found.
// Search order: hinted segment -> same page -> whole document.
// ---------------------------------------------------------------------------

export const PARTIAL_MATCH_THRESHOLD = 0.55;

// Longest common subsequence length over word arrays (classic O(n*m) DP).
// Segments/quotes are paragraph-sized, so this stays cheap in practice.
function lcsLength(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

// Similarity of `quote` against `text`, in [0, 1], based on the fraction of
// the quote's words found in the text in the same relative order.
export function wordOrderSimilarity(quote, text) {
  const qWords = tokenizeWords(normalizeText(quote));
  const tWords = tokenizeWords(normalizeText(text));
  if (qWords.length === 0 || tWords.length === 0) return 0;
  const lcs = lcsLength(qWords, tWords);
  return lcs / qWords.length;
}

function buildCandidateOrder(segments, hintSegmentId, hintPage) {
  const hinted = hintSegmentId ? segments.filter((s) => s.id === hintSegmentId) : [];
  const samePage =
    hintPage != null
      ? segments.filter((s) => s.page === hintPage && s.id !== hintSegmentId)
      : [];
  const hintedIds = new Set(hinted.map((s) => s.id));
  const samePageIds = new Set(samePage.map((s) => s.id));
  const rest = segments.filter((s) => !hintedIds.has(s.id) && !samePageIds.has(s.id));
  return { tiers: [hinted, samePage, rest] };
}

// verifyQuote(quote, segments, { hintSegmentId, hintPage }) => {
//   status: 'exact' | 'partial' | 'not_found',
//   segmentId, page, matchedText, similarity, pageMismatch
// }
export function verifyQuote(quote, segments, { hintSegmentId, hintPage } = {}) {
  const base = {
    status: 'not_found',
    segmentId: null,
    page: null,
    matchedText: null,
    similarity: 0,
    pageMismatch: false,
  };
  const normalizedQuote = normalizeText(quote);
  if (!normalizedQuote || !segments || segments.length === 0) return base;

  const { tiers } = buildCandidateOrder(segments, hintSegmentId, hintPage);

  // Tier 1: exact substring match, checked tier by tier.
  for (const tier of tiers) {
    for (const seg of tier) {
      if (normalizeText(seg.text).includes(normalizedQuote)) {
        return {
          status: 'exact',
          segmentId: seg.id,
          page: seg.page,
          matchedText: seg.text,
          similarity: 1,
          pageMismatch: hintPage != null && seg.page !== hintPage,
        };
      }
    }
  }

  // Tier 2: fuzzy match, stop at the first tier that clears the threshold;
  // within a tier, keep the best-scoring segment.
  for (const tier of tiers) {
    let best = null;
    for (const seg of tier) {
      const score = wordOrderSimilarity(quote, seg.text);
      if (!best || score > best.score) best = { seg, score };
    }
    if (best && best.score >= PARTIAL_MATCH_THRESHOLD) {
      return {
        status: 'partial',
        segmentId: best.seg.id,
        page: best.seg.page,
        matchedText: best.seg.text,
        similarity: best.score,
        pageMismatch: hintPage != null && best.seg.page !== hintPage,
      };
    }
  }

  return base;
}

// Best-effort location of `quote` inside `text` for UI highlighting. Used
// only for display — verification itself relies on normalizeText/LCS
// above, not on this. Returns { start, end } (character offsets into the
// original, un-normalized text) or null if no reasonably close contiguous
// match can be found (e.g. for a partial/fuzzy match whose words aren't
// contiguous in the source).
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findQuoteHighlight(text, quote) {
  if (!text || !quote) return null;
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const pattern = escapeRegExp(trimmed)
    .replace(/\s+/g, '\\s+')
    .replace(/['’‘ʼ]/g, "['’‘ʼ]")
    .replace(/["“”]/g, '["“”]')
    .replace(/[-–—]/g, '[-–—]');
  try {
    const match = new RegExp(pattern, 'i').exec(text);
    if (!match) return null;
    return { start: match.index, end: match.index + match[0].length };
  } catch {
    return null;
  }
}

// Cross-paper comparison requires 2-10 selected papers. Pulled out as a
// pure function (rather than inline checks in ComparePage.jsx) so the
// boundary conditions are unit-testable, and so the UI's "select" cap and
// "compare" button share one source of truth for both the limit and the
// message shown to the user.
export function validateComparisonSelection(selectedIds) {
  const count = (selectedIds || []).length;
  if (count < 2) {
    return { valid: false, reason: 'too_few', message: '請至少選擇 2 篇已有分析結果的論文。' };
  }
  if (count > 10) {
    return { valid: false, reason: 'too_many', message: '最多只能選擇 10 篇論文，請先取消勾選其他論文。' };
  }
  return { valid: true, reason: null, message: null };
}

// Cross-paper comparison input can get large fast: up to 10 papers × 5
// completed modules × several items each, with NO evidence quotes
// included (comparison only ever sends title/claim/kind — see
// ComparePage.jsx) but still enough plain items to threaten the output
// budget once Claude has to reason about all of them. Two low-value,
// high-volume shapes are worth trimming before the comparison prompt is
// even built:
//   - `not_mentioned` items: a module can legitimately have many of these
//     (every checklist item a paper didn't cover) and most don't carry
//     cross-paper comparison value on their own — capped per (paper,
//     module) group rather than dropped outright, so the gap is still
//     partly visible instead of silently vanishing entirely
//   - exact duplicate claims within the same (paper, module) — not
//     something normalizeAnalysisItems() is expected to produce, but
//     cheap to guard defensively anyway
// This never touches `fact`/`inference` items, never rewrites a claim,
// and never removes a paper's only items for a module — it only trims
// the more repetitive tail.
export function pruneComparisonItems(items, { maxNotMentionedPerGroup = 3 } = {}) {
  const notMentionedCounts = new Map();
  const seenClaims = new Set();
  const kept = [];
  for (const item of items || []) {
    const groupKey = `${item.paperId}::${item.module}`;
    const claimKey = `${groupKey}::${item.claim}`;
    if (seenClaims.has(claimKey)) continue;
    seenClaims.add(claimKey);

    if (item.kind === 'not_mentioned') {
      const count = notMentionedCounts.get(groupKey) || 0;
      if (count >= maxNotMentionedPerGroup) continue;
      notMentionedCounts.set(groupKey, count + 1);
    }
    kept.push(item);
  }
  return kept;
}

// Cross-paper comparison findings cite { paperId, itemId } pairs. Claude
// must only cite pairs that were actually present in the input list — this
// checks that locally (a deterministic ID whitelist check) rather than
// trusting the model, dropping any source that doesn't correspond to a
// real analysis item and flagging findings that lose all of their sources
// as a result.
//
// IMPORTANT — what this proves, and what it doesn't: this only confirms
// the cited {paperId, itemId} pair is a REAL analysis item that was
// actually shown to Claude (provenance/traceability), never that the
// item's content is semantically relevant to the finding it's attached
// to — that would require actually understanding both texts, which no
// code in this file does or claims to do. Don't present a source that
// passes this check as "evidence verified" or "semantically verified"
// anywhere in the UI — see CLAUDE.md for the full reasoning, and
// ComparePage.jsx's "顯示來源內容" feature, which exists specifically so a
// human can make that judgment instead.
//
// A previous round required Claude to also echo back the item's exact
// claim text (`sourceClaim`) and rejected any source whose echo didn't
// match verbatim — that was removed (see CLAUDE.md) because it turned out
// far too strict in real use: a completely legitimate citation could fail
// this over trivial rewording, punctuation, or Unicode normalization
// differences a language model has no reason to reproduce byte-for-byte,
// and it added no real defense against the actual problem (a citation
// whose content just isn't relevant) since a model motivated to fabricate
// a plausible-looking source could just as easily fabricate a
// plausible-looking exact-copy claim too. The real defenses against
// irrelevant sources are: the prompt's "select sources before writing the
// finding" instruction, and this app never claiming source validation
// proves relevance in the first place — see resolveComparisonSource below
// for how the actually-authoritative claim text is obtained (always from
// this app's own stored data, never from anything Claude returns).
export function verifyComparisonSources(findings, validItemKeys) {
  // Array.isArray, not just `|| []` — a non-array truthy value (Claude
  // returning `findings` or a finding's `sources` as an object instead of
  // a flat array) must not reach `.map()`/`.filter()` directly, the same
  // class of bug that caused a real `analysis.items.map is not a
  // function` crash (see CLAUDE.md).
  const list = Array.isArray(findings) ? findings : [];
  return list.map((finding) => {
    const sources = Array.isArray(finding?.sources) ? finding.sources : [];
    const verifiedSources = sources.filter((s) => validItemKeys.has(`${s?.paperId}::${s?.itemId}`));
    return {
      ...finding,
      sources: verifiedSources,
      unverifiedSourceCount: sources.length - verifiedSources.length,
    };
  });
}

// The single authoritative source of truth for a comparison source's
// display/provenance fields — always resolved from this app's own stored
// comparison-input items (built from real, saved analysis items), NEVER
// from anything Claude's structured output returned (Claude is only ever
// trusted to supply a {paperId, itemId} reference; everything else about
// that source — title, claim, module, etc. — comes from here). `itemIndex`
// is a Map keyed by `${paperId}::${itemId}` (see buildComparisonSourceIndex)
// mapping to the full comparison-input item. Returns null for a key with
// no matching item (shouldn't happen for anything that already passed
// verifyComparisonSources, but this stays defensive rather than assuming).
export function resolveComparisonSource(itemIndex, { paperId, itemId }) {
  const item = itemIndex?.get?.(`${paperId}::${itemId}`);
  if (!item) return null;
  return {
    paperId: item.paperId,
    itemId: item.itemId,
    paperTitle: item.paperTitle,
    module: item.module,
    itemTitle: item.title,
    claim: item.claim,
    kind: item.kind,
    sourceScope: item.sourceScope ?? null,
    weaknessType: item.weaknessType ?? null,
    verificationStatus: item.verificationStatus ?? null,
  };
}

// Builds the `${paperId}::${itemId}` -> item index that
// resolveComparisonSource looks sources up in — one place to build it, so
// every caller (ComparePage.jsx's real flow, tests) is guaranteed to key
// it the same way validKeys/dedup do.
export function buildComparisonSourceIndex(items) {
  const index = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    index.set(`${item.paperId}::${item.itemId}`, item);
  }
  return index;
}

// A finding that ends up with ZERO valid sources after
// verifyComparisonSources() — whether it cited nothing at all, or
// everything it cited turned out to be hallucinated/mismatched — has no
// genuine grounding left. Keeping it as a card would show an unfounded
// claim (possibly with a "0/N sources verified" warning next to it,
// which is worse than just not showing it). This drops the whole finding
// in that case only; a finding that still has at least one real source
// survives untouched (partial invalidity never wholesale-deletes a card
// — only total invalidity does). Applies uniformly to every finding
// `type` (consensus/difference/contradiction/research_gap) — there is no
// per-type exception.
export function dropUnsourcedComparisonFindings(findings) {
  const kept = [];
  const dropped = [];
  (Array.isArray(findings) ? findings : []).forEach((finding, index) => {
    if (Array.isArray(finding?.sources) && finding.sources.length > 0) {
      kept.push(finding);
    } else {
      dropped.push({ index, type: finding?.type, reason: 'no_valid_sources_after_verification' });
    }
  });
  return { kept, dropped };
}

// A cross-paper comparison finding whose surviving (trace-valid) sources
// all come from a single paper isn't actually a cross-paper finding — it
// has nothing to compare, no matter how the `type` is labeled. This is a
// distinct check from dropUnsourcedComparisonFindings (which only asks
// "any sources at all?"): a finding can have 3 valid sources and still
// fail this check if all 3 happen to be from the same paper. Run this
// AFTER dropUnsourcedComparisonFindings (and after dedup — dedup never
// removes a distinct paperId, only exact duplicate paperId+itemId pairs,
// so ordering relative to dedup doesn't change the paperId-count result).
// There is currently no exception for a legitimately single-paper
// finding — if one is ever wanted, it needs its own explicit opt-in
// rather than silently slipping through here.
export function dropSinglePaperFindings(findings) {
  const kept = [];
  const dropped = [];
  (Array.isArray(findings) ? findings : []).forEach((finding, index) => {
    const paperIds = new Set((Array.isArray(finding?.sources) ? finding.sources : []).map((s) => s?.paperId));
    if (paperIds.size >= 2) {
      kept.push(finding);
    } else {
      dropped.push({ index, type: finding?.type, reason: 'single_paper_source', paperCount: paperIds.size });
    }
  });
  return { kept, dropped };
}

// A finding's `sources` array can legitimately end up with the same
// {paperId, itemId} pair more than once — e.g. Claude cites the same
// analysis item twice in one finding, or a duplicate survives whatever
// upstream processing produced it. Rendered as source chips, two
// identical chips convey no extra information and just look like a
// rendering bug. Dedup is keyed on paperId+itemId (the actual identity of
// the underlying analysis item), never on display text — two sources
// that happen to render the same short label but point at different
// items must both stay. Order-preserving: keeps the first occurrence.
export function dedupeComparisonSources(sources) {
  const seen = new Set();
  const deduped = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    const key = `${s?.paperId}::${s?.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }
  return deduped;
}

function truncateForChip(text, maxLength) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxLength) return text;
  // maxLength - 1 to leave room for the ellipsis character itself, so the
  // truncated label never exceeds maxLength visible characters.
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

// Builds a source chip's display label and its full (untruncated) form
// for a `title` attribute / hover tooltip. Format is "paper · module ·
// analysis item title" — the item title is what actually lets a reader
// tell apart two source chips that share the same paper and module (the
// old two-part "paper · module" format was indistinguishable when a
// finding cited two different items from the same module). `itemTitle` is
// optional — old saved comparisons never had per-source item titles
// recorded, and this degrades cleanly to the old two-part format rather
// than showing an empty third segment.
export function formatComparisonSourceLabel({ paperTitle, moduleLabel, itemTitle }, { maxSegmentLength = 16 } = {}) {
  const shortSegments = [truncateForChip(paperTitle, maxSegmentLength), moduleLabel].filter(Boolean);
  if (itemTitle) shortSegments.push(truncateForChip(itemTitle, maxSegmentLength));
  const fullSegments = [paperTitle, moduleLabel, itemTitle].filter(Boolean);
  return { short: shortSegments.join(' · '), full: fullSegments.join(' · ') };
}

// Builds the small, non-sensitive numeric summary saved alongside a
// comparison record (storage.js: saveComparison's `diagnostics` field) so
// a "why did this come back empty" investigation doesn't require having
// had DevTools open at the time the comparison actually ran. Deliberately
// only counts/typeCounts — never the underlying rejection reasons' raw
// `value` fields (which could echo back an arbitrary, possibly long
// string from a malformed Claude response), never finding titles/claims,
// never prompt or PDF text. Missing/unknown stages are reported as 0
// rather than guessed.
//
// Field names use "Finding" (never "Item") for counts of comparison
// findings, to stay unambiguous next to "analysis item" — the two are
// unrelated concepts that both used to get called "item" in this file,
// which was exactly the kind of naming confusion that made an earlier
// bug (a too-strict source-claim check) harder to diagnose than it should
// have been. Source-level counts are named after what they can actually
// prove — see verifyComparisonSources' doc comment — never "verified".
export function buildComparisonDiagnostics({
  rawFindingCount = 0,
  normalizedFindingCount = 0,
  rejections = [],
  rawSourceCount = 0,
  invalidSourceIdCount = 0,
  // Findings still standing after dropUnsourcedComparisonFindings (i.e.,
  // after stripping sources whose {paperId, itemId} isn't a real,
  // whitelisted reference).
  findingsAfterIdValidation = 0,
  // Findings dropped because their surviving (id-valid) sources all
  // collapsed onto a single paper — see dropSinglePaperFindings. A
  // "cross-paper" finding needs at least 2 distinct papers backing it.
  singlePaperFindingCount = 0,
  finalFindings = [],
  // Claude's own top-level comparisonStatus ("compared" |
  // "insufficient_overlap" — see prompts.js: COMPARISON_STATUSES /
  // validateComparisonStatus). Recorded as-is (it's already just a short
  // enum string, not raw content) so a saved comparison's diagnostics can
  // later confirm whether Claude self-reported a legitimate empty result
  // or the caller's own guard caught something inconsistent. `null` when
  // the caller doesn't have one (e.g. old callers, or the field wasn't
  // part of the response at all) — never guessed.
  comparisonStatus = null,
} = {}) {
  // Built from COMPARISON_TYPES (prompts.js) rather than a hardcoded list
  // of keys, so adding a new comparison type there (as `shared_limitation`
  // was added alongside consensus/difference/contradiction/research_gap)
  // automatically shows up here too — no risk of this drifting into a
  // stale subset the way a second hardcoded list could.
  const typeCounts = Object.fromEntries(COMPARISON_TYPES.map((type) => [type, 0]));
  for (const finding of Array.isArray(finalFindings) ? finalFindings : []) {
    if (finding && typeof finding.type === 'string' && finding.type in typeCounts) {
      typeCounts[finding.type] += 1;
    }
  }
  const rejectionList = Array.isArray(rejections) ? rejections : [];
  const finalFindingCount = Array.isArray(finalFindings) ? finalFindings.length : 0;
  return {
    rawFindingCount,
    // JSON parsing is all-or-nothing in this pipeline (tool_use.input is
    // already parsed for us by the SDK; the fallback path either fully
    // parses or throws before any count is available) — same convention
    // as the module-analysis debug log, so there's no separate "parsed
    // but not yet normalized" stage to report.
    parsedFindingCount: rawFindingCount,
    normalizedFindingCount,
    rejectedFindingCount: rejectionList.length,
    invalidTypeCount: rejectionList.filter((r) => r?.reason === 'invalid_type').length,
    rawSourceCount,
    invalidSourceIdCount,
    // A previous round required Claude to echo back an exact copy of each
    // cited item's claim text and rejected mismatches — removed (see
    // CLAUDE.md) because it rejected too many genuinely legitimate
    // citations in real use. This field stays at 0 always, kept explicit
    // rather than removed outright so it's visible in a saved comparison's
    // diagnostics that the mechanism is gone, not just silently absent.
    sourceClaimMismatchCount: 0,
    findingsAfterIdValidation,
    // Same reasoning as sourceClaimMismatchCount: claim validation no
    // longer filters anything, so this stage is a pass-through and always
    // equals findingsAfterIdValidation.
    findingsAfterClaimValidation: findingsAfterIdValidation,
    singlePaperFindingCount,
    // The cross-paper-minimum check (dropSinglePaperFindings) is the last
    // filtering stage, so this always equals finalFindingCount — kept as
    // its own named field so each pipeline stage has a visible count.
    findingsAfterMultiPaperValidation: finalFindingCount,
    finalFindingCount,
    typeCounts,
    comparisonStatus,
  };
}

// Convenience: verify a whole list of evidence items ({ segmentId, page,
// quote }) against a paper's segments, returning the same items augmented
// with a `verification` field.
export function verifyEvidenceList(evidenceList, segments) {
  return (evidenceList || []).map((ev) => ({
    ...ev,
    verification: verifyQuote(ev.quote, segments, {
      hintSegmentId: ev.segmentId,
      hintPage: ev.page,
    }),
  }));
}

// One summary verification status for a whole analysis item's evidence
// list — used where a single value is needed (e.g. cross-paper
// comparison) instead of per-evidence detail. This does NOT change what
// verifyQuote() itself returns; it just picks the best result across
// possibly several evidence entries:
//   exact     — at least one evidence quote verified exact
//   partial   — no exact, but at least one verified partial (still needs
//               a human to actually confirm it — see PARTIAL_MATCH_THRESHOLD)
//   not_found — every evidence quote failed to verify
//   unavailable — there was no evidence to check at all (e.g. kind is
//               inference/not_mentioned with no supporting evidence)
const VERIFICATION_STATUS_PRIORITY = { exact: 3, partial: 2, not_found: 1 };

export function bestVerificationStatus(evidenceList, segments) {
  if (!evidenceList || evidenceList.length === 0) return 'unavailable';
  let best = null;
  for (const ev of evidenceList) {
    const v = verifyQuote(ev.quote, segments, { hintSegmentId: ev.segmentId, hintPage: ev.page });
    if (!best || VERIFICATION_STATUS_PRIORITY[v.status] > VERIFICATION_STATUS_PRIORITY[best]) {
      best = v.status;
    }
  }
  return best;
}
