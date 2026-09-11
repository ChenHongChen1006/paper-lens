// ingest.js — orchestrates turning an uploaded PDF File into a stored
// `papers` record: extract text, detect scanned PDFs, detect references,
// and persist everything. Thin glue between pdf.js, text.js and storage.js.

import { extractPdfText } from './pdf.js';
import { detectScannedPdf, detectReferences } from './text.js';
import { createPaper, updatePaper } from './storage.js';

function titleFromFileName(fileName) {
  return fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || fileName;
}

// Creates the paper record immediately (status: processing) so it shows up
// in the list right away, then extracts text in the background and
// updates the record. Returns the initial record.
export async function ingestPdfFile(file, { onProgress } = {}) {
  const paper = await createPaper({
    title: titleFromFileName(file.name),
    fileName: file.name,
    fileBlob: file,
    extractionStatus: 'processing',
  });

  try {
    const { pageCount, pages, segments, title } = await extractPdfText(file, { onProgress });
    const scanInfo = detectScannedPdf(pages);
    const referenceInfo = segments.length ? detectReferences(segments) : { referencesStart: null, appendixStart: null };

    await updatePaper(paper.id, {
      title: title || paper.title,
      pageCount,
      pages,
      segments,
      scanInfo,
      referenceInfo,
      extractionMode: 'text',
      extractionStatus: 'done',
    });
  } catch (err) {
    await updatePaper(paper.id, {
      extractionStatus: 'error',
      extractionError: err?.message || String(err),
    });
  }

  return paper.id;
}
