// Integration test: exercises the real pdfjs-dist extraction pipeline
// (not a mock) against a small real PDF fixture, so we have genuine
// confidence extraction actually works end-to-end, not just that the
// pure string-processing helpers in text.js are correct in isolation.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Blob } from 'node:buffer';
import path from 'node:path';
import * as pdfjsLib from 'pdfjs-dist';
import { extractPdfText } from '../lib/pdf.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.pdf');

// pdf.js normally loads its worker via a URL served by Vite (which works
// fine in the dev server / built app — see `npm run build`). Vitest runs
// this file directly under Node with no dev server, so we point the
// worker at its real on-disk location instead; this only affects the
// test environment, not the app.
const workerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'node_modules',
  'pdfjs-dist',
  'build',
  'pdf.worker.min.mjs'
);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

describe('extractPdfText (real pdf.js pipeline)', () => {
  it('extracts real text with correct page numbers from an actual PDF file', async () => {
    const bytes = readFileSync(fixturePath);
    // node:buffer's Blob (not jsdom's) — it implements arrayBuffer() the
    // way real browsers do; jsdom's Blob polyfill doesn't in this version.
    const blob = new Blob([bytes], { type: 'application/pdf' });

    const { pageCount, pages, segments } = await extractPdfText(blob);

    expect(pageCount).toBe(2);
    expect(pages).toHaveLength(2);
    expect(pages[0].text).toContain('congestion control');
    expect(pages[1].text).toContain('FastCC');

    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => typeof s.page === 'number')).toBe(true);
    expect(segments.every((s) => /^p\d+-s\d+$/.test(s.id))).toBe(true);

    const page1Segments = segments.filter((s) => s.page === 1);
    const page2Segments = segments.filter((s) => s.page === 2);
    expect(page1Segments.some((s) => s.text.includes('congestion control'))).toBe(true);
    expect(page2Segments.some((s) => s.text.includes('FastCC'))).toBe(true);
  });
});
