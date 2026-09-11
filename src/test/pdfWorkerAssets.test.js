// Regression tests for "PDF.js worker fails to load on GitHub Pages
// production, but works locally" — reported as:
//   PDF 解析失敗：Setting up fake worker failed: "Failed to fetch dynamically
//   imported module: https://<user>.github.io/paper-lens/assets/pdf.worker.min-<hash>.mjs"
//
// Investigation (see CLAUDE.md for the full writeup): both the worker URL
// construction (`?url` import, resolved via `import.meta.url`) and the
// cMap/standard-font URLs (resolved via `document.baseURI`) were verified
// — via an actual production build AND live HTTP requests against the
// deployed site — to already be correct: the worker file exists at the
// expected hashed path, is served with `Content-Type: text/javascript`,
// and CORS is open. No code-level URL-construction or MIME-serving bug
// could be reproduced. The most plausible explanations for the reported
// failure are a transient GitHub Pages CDN propagation delay right after
// a fresh deploy, or a client-side privacy/ad-blocking browser extension
// — neither of which a unit test can reproduce (this project doesn't
// spin up a real browser against a live URL). What these tests DO lock
// in: the URL-construction pattern stays Vite-managed (never a
// hand-rolled root-absolute or localhost-hardcoded path, which WOULD be a
// real, code-level bug), and that a worker-load failure now surfaces a
// clear, actionable message instead of pdf.js's raw internal error text.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translatePdfError } from '../lib/pdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const pdfJsSource = readFileSync(path.resolve(repoRoot, 'src/lib/pdf.js'), 'utf8');
const viteConfigSource = readFileSync(path.resolve(repoRoot, 'vite.config.js'), 'utf8');

describe('translatePdfError (pure function)', () => {
  it('recognizes a "fake worker" / dynamically-imported-module failure and returns an actionable message', () => {
    const err = new Error(
      'Setting up fake worker failed: "Failed to fetch dynamically imported module: https://x.github.io/paper-lens/assets/pdf.worker.min-abc123.mjs".'
    );
    const message = translatePdfError(err);
    expect(message).not.toContain('fake worker');
    expect(message).toContain('PDF 解析元件載入失敗');
    expect(message).toContain('隱私／廣告阻擋擴充功能');
  });

  it('is case-insensitive and matches on either half of the known pdf.js wording', () => {
    expect(translatePdfError(new Error('FAKE WORKER setup issue'))).toContain('PDF 解析元件載入失敗');
    expect(translatePdfError(new Error('failed to fetch DYNAMICALLY IMPORTED MODULE: foo'))).toContain('PDF 解析元件載入失敗');
  });

  it('passes unrelated errors through unchanged (e.g. a corrupt/encrypted PDF, or a Claude API error from a shared catch block)', () => {
    expect(translatePdfError(new Error('Invalid PDF structure.'))).toBe('Invalid PDF structure.');
    expect(translatePdfError(new Error('API key 無效或驗證失敗，請至「設定」確認 API key 是否正確。'))).toBe(
      'API key 無效或驗證失敗，請至「設定」確認 API key 是否正確。'
    );
  });

  it('never crashes on a non-Error value', () => {
    expect(() => translatePdfError('a plain string')).not.toThrow();
    expect(() => translatePdfError(undefined)).not.toThrow();
    expect(() => translatePdfError(null)).not.toThrow();
    expect(translatePdfError('a plain string')).toBe('a plain string');
  });
});

describe('worker/asset URL construction stays Vite-managed (source-level regression guard)', () => {
  it('the worker is imported via the Vite `?url` asset pattern, not a hand-built path', () => {
    expect(pdfJsSource).toContain("import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'");
    expect(pdfJsSource).toContain('pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl');
  });

  it('never hardcodes localhost/127.0.0.1 as an asset origin', () => {
    expect(pdfJsSource).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it('never hardcodes a root-absolute worker/asset path (which would drop the GitHub Pages /<repo>/ prefix)', () => {
    // A literal '/assets/...' or '/pdf-worker...' string assigned as a
    // path — as opposed to the relative 'pdf-cmaps/' / 'pdf-standard-fonts/'
    // strings this file legitimately uses with assetUrl(), which resolves
    // them against document.baseURI (itself already /<repo>/-aware).
    expect(pdfJsSource).not.toMatch(/['"]\/assets\//);
    expect(pdfJsSource).not.toMatch(/['"]\/pdf-worker/i);
  });

  it('cMap/standard-font URLs are resolved via document.baseURI, not window.location.origin alone', () => {
    // window.location.origin (e.g. "https://user.github.io") does NOT
    // include the "/paper-lens/" repo path segment — building a URL from
    // origin alone would silently point at the wrong (nonexistent) path
    // on GitHub Pages. document.baseURI already includes it. (The source
    // file's own comments mention `window.location.origin` by name to
    // explain why it's the wrong approach — this checks the actual
    // function body, not the whole file, so that explanatory comment
    // doesn't trip this assertion.)
    expect(pdfJsSource).toContain('new URL(relativePath, document.baseURI)');
    const assetUrlFnBody = pdfJsSource.slice(
      pdfJsSource.indexOf('function assetUrl('),
      pdfJsSource.indexOf('}', pdfJsSource.indexOf('function assetUrl('))
    );
    expect(assetUrlFnBody).not.toContain('window.location.origin');
  });

  it('vite.config.js still uses the relative base that makes all of the above work under any repo name/subpath', () => {
    expect(viteConfigSource).toContain("base: './'");
  });
});

// These checks need an actual `npm run build` output to inspect — CI runs
// `npm test` BEFORE `npm run build` (see .github/workflows/deploy.yml), so
// dist/ may not exist yet at test time there. Skip gracefully rather than
// fail when it's absent; when it IS present (e.g. after running `npm run
// build` locally, as this audit did), verify the actual emitted files —
// this is the closest a unit test can get to validating deployment
// without a real browser hitting a real GitHub Pages URL (see this file's
// header comment for what was instead verified via live HTTP requests).
const distDir = path.resolve(repoRoot, 'dist');
const distExists = existsSync(distDir);

describe.runIf(distExists)('build-output inspection (dist/ present)', () => {
  it('the built worker .mjs file actually exists in dist/assets/', () => {
    const assetFiles = readdirSync(path.resolve(distDir, 'assets'));
    const workerFiles = assetFiles.filter((f) => /^pdf\.worker\.min-.*\.mjs$/.test(f));
    expect(workerFiles.length).toBeGreaterThan(0);
  });

  it('the main JS bundle references the worker via import.meta.url-relative construction, not a root-absolute path', () => {
    const indexHtml = readFileSync(path.resolve(distDir, 'index.html'), 'utf8');
    const mainScriptMatch = indexHtml.match(/src="\.\/(assets\/index-[^"]+\.js)"/);
    expect(mainScriptMatch).toBeTruthy();
    const mainJs = readFileSync(path.resolve(distDir, mainScriptMatch[1]), 'utf8');
    expect(mainJs).toMatch(/new URL\("pdf\.worker\.min-[^"]+\.mjs",\s*import\.meta\.url\)/);
    expect(mainJs).not.toMatch(/["']\/assets\/pdf\.worker/);
  });

  it('dist/index.html has no hardcoded localhost/127.0.0.1 reference', () => {
    const indexHtml = readFileSync(path.resolve(distDir, 'index.html'), 'utf8');
    expect(indexHtml).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it('cMap and standard-font static assets were copied into dist (needed at runtime by cMapUrl/standardFontDataUrl)', () => {
    expect(existsSync(path.resolve(distDir, 'pdf-cmaps'))).toBe(true);
    expect(readdirSync(path.resolve(distDir, 'pdf-cmaps')).length).toBeGreaterThan(0);
    expect(existsSync(path.resolve(distDir, 'pdf-standard-fonts'))).toBe(true);
    expect(readdirSync(path.resolve(distDir, 'pdf-standard-fonts')).length).toBeGreaterThan(0);
  });
});

describe.skipIf(distExists)('build-output inspection skipped', () => {
  it('dist/ was not present at test time (e.g. CI runs `npm test` before `npm run build`) — this is expected and not a failure', () => {
    expect(distExists).toBe(false);
  });
});
