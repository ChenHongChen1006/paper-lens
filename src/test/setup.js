// Vitest setup: polyfills IndexedDB (jsdom doesn't implement it) so
// storage.js (Dexie) can be exercised in tests.
import 'fake-indexeddb/auto';

// Polyfill for Node 18 (our target runtime, see README), which lacks
// Promise.withResolvers (added in Node 22 / modern browsers). pdfjs-dist's
// Node-environment detection path uses it; the actual app never takes
// this path in a real browser, but the test environment does.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
