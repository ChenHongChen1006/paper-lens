// pdf.js — everything that talks to pdfjs-dist: text extraction (with page
// geometry used to reconstruct paragraphs), page rendering to images (used
// both for the "open PDF at page" link and for OCR), and PDF metadata.
//
// Generic string-level cleanup (dehyphenation, paragraph joining, segment
// IDs) lives in text.js and is called from here.

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildParagraphsFromLines, buildSegments } from './text.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Standard fonts / CMaps are copied into public/ (see README) so pdf.js
// can render pages whose fonts aren't embedded, and CJK text, correctly —
// without this, rendering (used for OCR page images and metadata) falls
// back to generic glyph shapes.
function assetUrl(relativePath) {
  return new URL(relativePath, document.baseURI).href;
}

export async function loadPdfDocument(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    cMapUrl: assetUrl('pdf-cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('pdf-standard-fonts/'),
  });
  return loadingTask.promise;
}

// Groups a page's text items into lines using pdfjs' hasEOL marker, then
// flags which lines start a new paragraph based on the vertical gap to the
// previous line (bigger than ~1.4x the page's typical line height) or a
// left-indent relative to the previous line.
async function extractPageLines(page) {
  const textContent = await page.getTextContent();
  const items = textContent.items.filter((it) => typeof it.str === 'string');

  const rawLines = [];
  let current = '';
  let startX = null;
  let startY = null;

  for (const item of items) {
    if (current === '') {
      startX = item.transform[4];
      startY = item.transform[5];
    }
    current += item.str;
    if (item.hasEOL) {
      rawLines.push({ text: current, x: startX ?? 0, y: startY ?? 0 });
      current = '';
      startX = null;
      startY = null;
    }
  }
  if (current.trim()) {
    rawLines.push({ text: current, x: startX ?? 0, y: startY ?? 0 });
  }

  const nonEmpty = rawLines.filter((l) => l.text.trim());
  if (nonEmpty.length === 0) return [];

  const gaps = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const gap = Math.abs(nonEmpty[i - 1].y - nonEmpty[i].y);
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const typicalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;

  return nonEmpty.map((line, idx) => {
    if (idx === 0) return { text: line.text, newParagraph: true };
    const prev = nonEmpty[idx - 1];
    const gap = Math.abs(prev.y - line.y);
    const indented = line.x - prev.x > typicalGap * 0.8;
    const newParagraph = gap > typicalGap * 1.4 || indented;
    return { text: line.text, newParagraph };
  });
}

// Extracts every page's text, reconstructs paragraphs/segments, and returns
// everything needed to populate a `papers` record (minus the blob, which
// the caller already has).
export async function extractPdfText(blob, { onProgress } = {}) {
  const pdf = await loadPdfDocument(blob);
  const pageCount = pdf.numPages;

  const pages = [];
  const pagesWithParagraphs = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const lines = await extractPageLines(page);
    const paragraphs = buildParagraphsFromLines(lines);
    const text = paragraphs.join('\n\n');
    pages.push({ page: pageNum, text, charCount: text.length });
    pagesWithParagraphs.push({ page: pageNum, paragraphs });
    onProgress?.({ current: pageNum, total: pageCount });
  }

  const segments = buildSegments(pagesWithParagraphs);
  const metadata = await pdf.getMetadata().catch(() => null);
  const title = metadata?.info?.Title?.trim() || null;

  return { pageCount, pages, segments, title };
}

// Renders a page to a JPEG data URL at a modest resolution (capped width),
// used for both the OCR pipeline and (optionally) previews. Keeping
// resolution capped keeps vision-API token usage reasonable.
export async function renderPageToImage(blob, pageNumber, { maxWidth = 1400, quality = 0.82 } = {}) {
  const pdf = await loadPdfDocument(blob);
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(maxWidth / baseViewport.width, 2.5);
  const viewport = page.getViewport({ scale: Math.max(scale, 0.5) });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { dataUrl, width: canvas.width, height: canvas.height };
}

// Builds an object URL for opening the stored PDF blob directly (optionally
// at a given page via the #page= fragment, which most browser PDF viewers
// honor). Caller is responsible for calling the returned revoke() when done.
export function openPdfBlobAtPage(blob, pageNumber) {
  const url = URL.createObjectURL(blob);
  const href = pageNumber ? `${url}#page=${pageNumber}` : url;
  return { href, revoke: () => URL.revokeObjectURL(url) };
}
