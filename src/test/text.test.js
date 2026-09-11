import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  verifyQuote,
  detectReferences,
  computeExcludedSegmentIds,
  buildParagraphsFromLines,
  detectScannedPdf,
} from '../lib/text.js';

describe('normalizeText', () => {
  it('collapses whitespace and newlines to single spaces', () => {
    expect(normalizeText('hello   \n  world')).toBe('hello world');
  });

  it('dehyphenates words split across a line break', () => {
    expect(normalizeText('net-\nwork performance')).toBe('network performance');
  });

  it('unifies curly quotes and dashes and lowercases', () => {
    expect(normalizeText('“Latency” is key — really')).toBe('"latency" is key - really');
  });

  it('returns an empty string for falsy input', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText(null)).toBe('');
  });
});

const segments = [
  { id: 'p1-s1', page: 1, text: 'This paper studies congestion control under high load conditions.' },
  { id: 'p1-s2', page: 1, text: 'We propose a new scheme called FastCC that reduces tail latency significantly.' },
  { id: 'p2-s1', page: 2, text: 'FastCC reduces average latency by 40% compared to CoDel in our evaluation.' },
  { id: 'p3-s1', page: 3, text: 'In conclusion, our approach outperforms prior work in most scenarios tested.' },
];

describe('verifyQuote', () => {
  it('returns exact when the quote is a verbatim substring after normalization', () => {
    const result = verifyQuote('reduces tail latency significantly', segments, {
      hintSegmentId: 'p1-s2',
      hintPage: 1,
    });
    expect(result.status).toBe('exact');
    expect(result.segmentId).toBe('p1-s2');
    expect(result.pageMismatch).toBe(false);
  });

  it('finds the quote on a different page than hinted and flags a page mismatch', () => {
    const result = verifyQuote('reduces average latency by 40%', segments, {
      hintSegmentId: 'p1-s2',
      hintPage: 1,
    });
    expect(result.status).toBe('exact');
    expect(result.page).toBe(2);
    expect(result.pageMismatch).toBe(true);
  });

  it('returns partial for a close paraphrase that is not a verbatim match', () => {
    const result = verifyQuote(
      'FastCC reduces the average latency by 40 percent compared with CoDel in evaluation',
      segments
    );
    expect(result.status).toBe('partial');
    expect(result.segmentId).toBe('p2-s1');
    expect(result.similarity).toBeGreaterThan(0.5);
    expect(result.similarity).toBeLessThan(1);
  });

  it('returns not_found for a quote that does not exist anywhere in the paper', () => {
    const result = verifyQuote('the moon is made of green cheese', segments);
    expect(result.status).toBe('not_found');
    expect(result.segmentId).toBeNull();
  });
});

describe('detectReferences', () => {
  it('detects a References heading in the back half of the document with citation-like content after it', () => {
    const segs = [
      { id: 'p1-s1', page: 1, text: 'Introduction to the problem space and motivation for this work.' },
      { id: 'p1-s2', page: 1, text: 'Prior systems have struggled to handle bursty traffic gracefully.' },
      { id: 'p2-s1', page: 2, text: 'We evaluate our system against several baselines in this section.' },
      { id: 'p2-s2', page: 2, text: 'Our design consists of three main components described below.' },
      { id: 'p3-s1', page: 3, text: 'References' },
      { id: 'p3-s2', page: 3, text: '[1] Smith, J. (2020). A study of networks. In Proc. SIGCOMM, pp. 1-10.' },
      { id: 'p3-s3', page: 3, text: '[2] Doe, A. et al. (2019). Congestion control revisited. doi:10.1145/12345' },
      { id: 'p3-s4', page: 3, text: '[3] Lee, K. (2018). Fast networks. In Proc. NSDI, pp. 20-33.' },
    ];
    const result = detectReferences(segs);
    expect(result.referencesStart).not.toBeNull();
    expect(result.referencesStart.segmentId).toBe('p3-s1');
    expect(result.appendixStart).toBeNull();
  });

  it('re-includes content after an Appendix heading that follows References', () => {
    const segs = [
      { id: 'p1-s1', page: 1, text: 'Introduction to the problem space and motivation for this work.' },
      { id: 'p1-s2', page: 1, text: 'Prior systems have struggled to handle bursty traffic gracefully.' },
      { id: 'p2-s1', page: 2, text: 'We evaluate our system against several baselines in this section.' },
      { id: 'p2-s2', page: 2, text: 'Our design consists of three main components described below.' },
      { id: 'p3-s1', page: 3, text: 'References' },
      { id: 'p3-s2', page: 3, text: '[1] Smith, J. (2020). A study of networks. In Proc. SIGCOMM, pp. 1-10.' },
      { id: 'p3-s3', page: 3, text: '[2] Doe, A. et al. (2019). Congestion control revisited. doi:10.1145/12345' },
      { id: 'p4-s1', page: 4, text: 'Appendix A' },
      { id: 'p4-s2', page: 4, text: 'Here we provide additional experimental details omitted from the main text.' },
    ];
    const result = detectReferences(segs);
    expect(result.referencesStart.segmentId).toBe('p3-s1');
    expect(result.appendixStart).not.toBeNull();
    expect(result.appendixStart.segmentId).toBe('p4-s1');

    const excluded = computeExcludedSegmentIds(segs, result);
    expect(excluded.has('p3-s1')).toBe(true);
    expect(excluded.has('p3-s2')).toBe(true);
    expect(excluded.has('p4-s1')).toBe(false);
    expect(excluded.has('p4-s2')).toBe(false);
    expect(excluded.has('p1-s1')).toBe(false);
  });

  it('excludes at segment granularity, not whole-page: body text sharing a page with the References heading stays included, and body text sharing a page with the Appendix heading is re-included', () => {
    const segs = [
      { id: 'p1-s1', page: 1, text: 'Introduction to the problem space and motivation for this work.' },
      { id: 'p1-s2', page: 1, text: 'Prior systems have struggled to handle bursty traffic gracefully.' },
      { id: 'p2-s1', page: 2, text: 'We evaluate our system against several baselines in this section.' },
      { id: 'p2-s2', page: 2, text: 'Our design consists of three main components described below.' },
      // References heading appears partway down page 3, after real body text.
      { id: 'p3-s1', page: 3, text: 'In conclusion, our approach outperforms prior work in most scenarios tested.' },
      { id: 'p3-s2', page: 3, text: 'References' },
      { id: 'p3-s3', page: 3, text: '[1] Smith, J. (2020). A study of networks. In Proc. SIGCOMM, pp. 1-10.' },
      { id: 'p3-s4', page: 3, text: '[2] Doe, A. et al. (2019). Congestion control revisited. doi:10.1145/12345' },
      // Appendix heading appears partway down page 4, followed by more body text on the SAME page.
      { id: 'p4-s1', page: 4, text: '[3] Lee, K. (2018). Fast networks. In Proc. NSDI, pp. 20-33.' },
      { id: 'p4-s2', page: 4, text: 'Appendix A' },
      { id: 'p4-s3', page: 4, text: 'Here we provide additional experimental details omitted from the main text.' },
    ];
    const result = detectReferences(segs);
    expect(result.referencesStart.segmentId).toBe('p3-s2');
    expect(result.appendixStart.segmentId).toBe('p4-s2');

    const excluded = computeExcludedSegmentIds(segs, result);
    // Body text before the References heading, even on the same page, is kept.
    expect(excluded.has('p3-s1')).toBe(false);
    // The heading itself and the bibliography entries after it are excluded...
    expect(excluded.has('p3-s2')).toBe(true);
    expect(excluded.has('p3-s3')).toBe(true);
    expect(excluded.has('p3-s4')).toBe(true);
    expect(excluded.has('p4-s1')).toBe(true);
    // ...but the Appendix heading and body text after it, even sharing page 4
    // with an excluded bibliography entry, are re-included.
    expect(excluded.has('p4-s2')).toBe(false);
    expect(excluded.has('p4-s3')).toBe(false);
  });

  it('does not flag a References-like mention early in the document as the heading', () => {
    const segs = [
      { id: 'p1-s1', page: 1, text: 'References to prior work are common in the introduction of a paper.' },
      { id: 'p2-s1', page: 2, text: 'More body text that continues the discussion of the system design.' },
    ];
    const result = detectReferences(segs);
    expect(result.referencesStart).toBeNull();
  });
});

describe('computeExcludedSegmentIds', () => {
  it('returns an empty set when the user has disabled exclusion', () => {
    const segs = [{ id: 'p1-s1', page: 1, text: 'References' }];
    const excluded = computeExcludedSegmentIds(segs, {
      referencesStart: { segmentId: 'p1-s1', page: 1 },
      userDisabled: true,
    });
    expect(excluded.size).toBe(0);
  });
});

describe('buildParagraphsFromLines', () => {
  it('joins wrapped lines within a paragraph and starts new paragraphs on the marker', () => {
    const lines = [
      { text: 'This is the first sentence of a paragraph that', newParagraph: true },
      { text: 'wraps onto a second line before it ends.', newParagraph: false },
      { text: 'This starts a new paragraph entirely.', newParagraph: true },
    ];
    const paragraphs = buildParagraphsFromLines(lines);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toBe(
      'This is the first sentence of a paragraph that wraps onto a second line before it ends.'
    );
    expect(paragraphs[1]).toBe('This starts a new paragraph entirely.');
  });

  it('dehyphenates a word wrapped across a line break', () => {
    const lines = [
      { text: 'We evaluate network-', newParagraph: true },
      { text: 'ing performance under load.', newParagraph: false },
    ];
    const paragraphs = buildParagraphsFromLines(lines);
    expect(paragraphs[0]).toBe('We evaluate networking performance under load.');
  });
});

describe('detectScannedPdf', () => {
  it('flags a PDF as scanned when the median per-page character count is very low', () => {
    const pages = [
      { page: 1, charCount: 5 },
      { page: 2, charCount: 3 },
      { page: 3, charCount: 8 },
    ];
    expect(detectScannedPdf(pages).isScanned).toBe(true);
  });

  it('does not flag a normal text PDF, even if the cover page has little text', () => {
    const pages = [
      { page: 1, charCount: 20 },
      { page: 2, charCount: 2200 },
      { page: 3, charCount: 1900 },
      { page: 4, charCount: 2100 },
    ];
    expect(detectScannedPdf(pages).isScanned).toBe(false);
  });
});
