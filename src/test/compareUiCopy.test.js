// Tests for the final trust/UI polish round on "跨篇比較".
//
// This project deliberately does not do component/DOM tests (see
// comparison.test.js's header comment) — page logic is pulled into pure,
// testable functions in text.js/storage.js instead. But this round's
// request is specifically about UI copy: exact wording, a badge that
// must render unconditionally, and forbidden words that must NOT appear
// in comparison-related UI. None of that is expressible as a pure
// function. Rather than skip verifying it, these tests read
// ComparePage.jsx's (and ui.jsx's, for the single-paper-analysis
// regression check) source as plain text and assert on it — a text-based
// regression guard, not a real component test. It can't catch a broken
// render, but it does lock in exact copy and catch someone accidentally
// reintroducing an overclaiming word like "已驗證" into comparison UI.
//
// Context: source ID whitelist validation (kept from the previous round)
// can prove a comparison finding's cited sources are real, traceable
// analysis items — it cannot prove their content is semantically
// relevant to the finding. Rather than pretend otherwise, this round adds
// honest, low-key UI signals (a page-level explanation, a neutral
// "來源待確認" badge on every finding, and a clearly-labeled source detail
// view) instead of any new automated verification — no second Claude
// call, no embedding model, nothing added to the request/response path
// (see comparisonSourceTrace.test.js and CLAUDE.md for that layer).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const comparePageSource = readFileSync(path.resolve(__dirname, '../pages/ComparePage.jsx'), 'utf8');
const uiSource = readFileSync(path.resolve(__dirname, '../components/ui.jsx'), 'utf8');

describe('1. every comparison finding shows a "來源待確認" badge', () => {
  it('the badge markup is present, unconditional (not inside an if/data-dependent branch), and styled neutral', () => {
    expect(comparePageSource).toContain('<Badge kind="source_pending">來源待確認</Badge>');
    // "source_pending" is deliberately not a key in ui.jsx's
    // BADGE_VARIANTS — Badge() falls back to the neutral badge-neutral
    // class for any unrecognized kind, so this badge is guaranteed to
    // render with a muted/grey style, never a warning/danger color, just
    // by using a kind that was never given a colored preset.
    expect(uiSource).not.toMatch(/source_pending:\s*\{/);
  });

  it('is rendered inside the per-finding .map() alongside the type badge, so it appears on every card, old or new', () => {
    const findingCardBlock = comparePageSource.slice(
      comparePageSource.indexOf('(Array.isArray(c.findings) ? c.findings : []).map'),
      comparePageSource.indexOf('(Array.isArray(c.findings) ? c.findings : []).map') + 2500
    );
    expect(findingCardBlock).toContain('TYPE_BADGE[f.type]');
    expect(findingCardBlock).toContain('來源待確認');
  });
});

describe('2. the "來源待確認" badge is a UI-only statement, never persisted per comparison', () => {
  it('handleCompare() never writes a "source_pending"/pending-related field into the saved comparison record', () => {
    const handleCompareBlock = comparePageSource.slice(
      comparePageSource.indexOf('async function handleCompare'),
      comparePageSource.indexOf('async function handleDelete')
    );
    expect(handleCompareBlock).not.toContain('source_pending');
    expect(handleCompareBlock).not.toContain('sourcePending');
  });
});

describe('3. single-paper analysis wording (AnalysisModule/ui.jsx) is completely untouched', () => {
  it('the original three verification labels still exist, unrenamed, in ui.jsx', () => {
    expect(uiSource).toContain("label: '原文已核對'");
    expect(uiSource).toContain("label: '部分符合'");
    expect(uiSource).toContain("label: '原文找不到這句'");
  });

  it('ComparePage.jsx never redefines or shadows these single-paper labels', () => {
    expect(comparePageSource).not.toContain('原文已核對');
    expect(comparePageSource).not.toContain('部分符合');
    expect(comparePageSource).not.toContain('原文找不到這句');
  });
});

describe('4. "查看來源分析" button only touches local component state — no API call', () => {
  it('the button label was renamed from "顯示來源內容" to "查看來源分析"/"隱藏來源分析"', () => {
    expect(comparePageSource).toContain("'隱藏來源分析' : '查看來源分析'");
    expect(comparePageSource).not.toContain('顯示來源內容');
    expect(comparePageSource).not.toContain('隱藏來源內容');
  });

  it('toggleSourceContent() is a synchronous state setter with no await/API call inside it', () => {
    const fnStart = comparePageSource.indexOf('function toggleSourceContent(key) {');
    const fnEnd = comparePageSource.indexOf('\n  }', fnStart);
    const fnBody = comparePageSource.slice(fnStart, fnEnd);
    expect(fnBody).toContain('setExpandedSourceContentKeys');
    expect(fnBody).not.toContain('await');
    expect(fnBody).not.toMatch(/runComparison|fetch\(|Anthropic|logUsage/);
  });

  it('the onClick handler for this button calls only toggleSourceContent, nothing else', () => {
    const buttonBlock = comparePageSource.slice(
      comparePageSource.indexOf("onClick={() => toggleSourceContent(sourceContentKey)}") - 50,
      comparePageSource.indexOf("onClick={() => toggleSourceContent(sourceContentKey)}") + 60
    );
    expect(buttonBlock).toContain('onClick={() => toggleSourceContent(sourceContentKey)}');
  });
});

describe('5. expanded source detail shows labeled fields sourced from local data, never a Claude-echoed sourceClaim', () => {
  it('the expanded view labels each field: 論文／面向／分析項目／來源分析內容', () => {
    expect(comparePageSource).toContain('論文：{paper?.title || s.paperId}');
    expect(comparePageSource).toContain('面向：{moduleLabel}');
    expect(comparePageSource).toContain('分析項目：{s.itemTitle}');
    expect(comparePageSource).toContain('來源分析內容：「{s.itemClaim}」');
  });

  it('renders from s.itemClaim (resolved locally in handleCompare via resolveComparisonSource — see comparisonSourceTrace.test.js case 3), never from a field named sourceClaim', () => {
    const expandedBlock = comparePageSource.slice(
      comparePageSource.indexOf('{sourceContentExpanded && ('),
      comparePageSource.indexOf('{sourceContentExpanded && (') + 700
    );
    expect(expandedBlock).toContain('s.itemClaim');
    expect(expandedBlock).not.toContain('s.sourceClaim');
  });

  it('shows the short, non-alarming confirmation prompt at the top of the expanded view, not a boxed alert', () => {
    expect(comparePageSource).toContain('請確認下列來源分析是否真的支持上方的跨篇比較結論。');
    // Rendered as a plain .faint <div>, not through ErrorAlert/InlineNotice
    // (the boxed/colored components this app reserves for actual errors
    // and warnings).
    const hintLine = comparePageSource.slice(
      comparePageSource.indexOf('請確認下列來源分析是否真的支持上方的跨篇比較結論。') - 60,
      comparePageSource.indexOf('請確認下列來源分析是否真的支持上方的跨篇比較結論。')
    );
    expect(hintLine).toContain('className="faint"');
  });
});

describe('6. source chip click-through is unchanged', () => {
  it('still links to the correct paper + module tab', () => {
    expect(comparePageSource).toContain("to={`/papers/${s.paperId}?tab=${s.module || 'overview'}`}");
  });
});

describe('7. comparison UI never overclaims verification', () => {
  it('does not use "已驗證"/"原文證據"/"已證實"/"來源已核對" anywhere in ComparePage.jsx', () => {
    for (const forbidden of ['已驗證', '原文證據', '已證實', '來源已核對']) {
      expect(comparePageSource).not.toContain(forbidden);
    }
  });

  it('does not claim the comparison conclusion itself has been verified against source text', () => {
    expect(comparePageSource).not.toContain('比較結論已被原文驗證');
    expect(comparePageSource).not.toContain('來源已證明此結論');
  });

  it('uses "來源分析"/"來源待確認"/"來源可追溯"-style wording instead', () => {
    expect(comparePageSource).toContain('來源分析');
    expect(comparePageSource).toContain('來源待確認');
    expect(comparePageSource).toContain('可追溯');
  });
});

describe('page-level explanation text', () => {
  it('the new trust-boundary explanation line is present, as plain muted text (not a boxed warning)', () => {
    const needle = '跨篇比較是 AI 根據已保存的單篇分析進行綜合整理；來源分析可追溯，但比較結論與來源的語意關係仍建議人工確認。';
    expect(comparePageSource).toContain(needle);
    const idx = comparePageSource.indexOf(needle);
    const precedingTag = comparePageSource.slice(comparePageSource.lastIndexOf('<p', idx), idx);
    expect(precedingTag).toContain('className="muted"');
    // Explicitly not routed through ErrorAlert/InlineNotice/a red or
    // boxed element — those are reserved for actual errors/warnings in
    // this app's established design language.
    expect(precedingTag).not.toContain('InlineNotice');
    expect(precedingTag).not.toContain('ErrorAlert');
    expect(precedingTag).not.toContain('alert');
  });
});
