/**
 * Reads the full-resolution image data Google already ships with its own
 * results, and hands it to the extension's content script.
 *
 * WHY THIS FILE EXISTS
 * Until v1.1.0 the extension learned an image's real URL by synthesizing a
 * click on its tile and scraping the panel Google opened in response. That
 * worked, but it meant every navigation opened — and then had to hide — a
 * full-screen panel we never wanted. Google opens that panel through the View
 * Transitions API, whose snapshots paint in the TOP LAYER, above any z-index
 * we can set, so the viewer intermittently blinked out mid-navigation. Every
 * mitigation for that (hiding the panel by class, cancelling the UA transition
 * animations, a MutationObserver walking ancestors, a 60ms poll with a
 * generation counter and proxy-upgrade logic) was a workaround for a panel we
 * opened ourselves.
 *
 * Google ships the same data the panel would reveal — origin URL, true pixel
 * dimensions, source page, title — inline in the results page, and again in
 * the XHR responses that serve infinite-scroll pages. Reading it directly means
 * no click, no panel, no view transition, and therefore nothing to suppress.
 *
 * WHY MAIN WORLD
 * Two reasons, and only the second is strictly necessary:
 *   1. The inline records sit in ordinary <script> text, readable from either
 *      world.
 *   2. The infinite-scroll records arrive in XHR responses that only Google's
 *      own JS ever touches. Patching XMLHttpRequest/fetch to read them requires
 *      sharing the page's globals, which an isolated content script cannot do.
 * Declared in the manifest with "world": "MAIN" + run_at document_start so the
 * patch is installed before any of Google's own requests go out. Manifest
 * declaration (rather than injecting a <script> tag) also sidesteps Google's
 * CSP, which would reject an injected tag without its nonce.
 *
 * SHAPE OF THE DATA (captured live 2026-09-16, same fragility class as the
 * CSS selectors in google-scraper.js):
 *   [0,"<docid>",["https://encrypted-tbn0.gstatic.com/…",th,tw],
 *                ["https://origin.example/photo.jpg",height,width], …
 *    {"2000":[null,"origin.example","247KB"], …
 *     "2003":[null,"<ref>","https://origin.example/page","<title>", …
 * Note the order inside each pair is [url, HEIGHT, WIDTH] — verified against
 * naturalWidth/naturalHeight on real files, which matched exactly.
 * The "<docid>" is the join key: every result tile in the DOM carries it as
 * its element id, prefixed with "e-".
 */
(function () {
  'use strict';

  // Inline page records are plain JSON-ish text; the same records inside an
  // XHR body are JSON-encoded a second time, so their quotes arrive as \" and
  // their escapes as \\u003d. Collapsing both forms up front means ONE pattern
  // can read either source, instead of two near-identical patterns drifting
  // apart. Only run on text that could plausibly contain a record.
  function normalize(text) {
    return text
      .replace(/\\{1,2}"/g, '"')
      .replace(/\\{1,4}u003d/gi, '=')
      .replace(/\\{1,4}u0026/gi, '&')
      .replace(/\\{1,2}\//g, '/');
  }

  const RECORD =
    /\[0,"([A-Za-z0-9_-]{6,})",\["https?:\/\/encrypted-tbn[^"]*",\d{1,6},\d{1,6}\],\["(https?:\/\/[^"]+)",(\d{1,6}),(\d{1,6})\]/g;
  // The source page and title live a little further into the same record.
  const PAGE = /"2003":\[null,"[A-Za-z0-9_-]+","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)"/;

  const seen = new Set();
  // Every record harvested so far. This file runs at document_start and the
  // first page's records are parsed around DOMContentLoaded, but the content
  // script that consumes them only loads at document_idle — so the earliest
  // (and most important) records are posted before anything is listening.
  // Keeping them lets the content script ask for a replay once it is ready.
  const harvested = [];

  function post(records) {
    window.postMessage({ __fivImageRecords: records }, window.location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.__fivRequestRecords && harvested.length) post(harvested);
  });

  function harvest(text) {
    if (!text || text.indexOf('encrypted-tbn') === -1) return;
    const norm = normalize(text);
    const records = [];
    RECORD.lastIndex = 0;
    let m;
    while ((m = RECORD.exec(norm))) {
      const docid = m[1];
      if (seen.has(docid)) continue;
      seen.add(docid);
      const tail = norm.slice(m.index, m.index + 1500);
      const page = PAGE.exec(tail);
      records.push({
        docid,
        full: m[2],
        height: parseInt(m[3], 10),
        width: parseInt(m[4], 10),
        page: page ? page[1] : null,
        title: page ? page[2] : null,
      });
    }
    if (records.length) {
      // postMessage is the only channel between the main world and the
      // isolated content script. The receiver checks the marker and that the
      // message came from this same window.
      for (const r of records) harvested.push(r);
      post(records);
    }
  }

  function harvestInlineScripts() {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) harvest(s.textContent || '');
  }

  // --- The first page's results: already in the document as inline script ---
  // document_start means the body hasn't parsed yet, so scan as content lands
  // rather than once at a fixed moment.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', harvestInlineScripts, { once: true });
  }
  new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeName === 'SCRIPT' && !node.src) harvest(node.textContent || '');
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  harvestInlineScripts();

  // --- Infinite-scroll results: only ever present in the response body ---
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__fivUrl = url;
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      // responseText throws for non-text responseTypes (blob/arraybuffer);
      // those are never results payloads, so ignore them quietly.
      try {
        harvest(this.responseText || '');
      } catch (e) {
        /* not a text response */
      }
    });
    return nativeSend.apply(this, args);
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      promise
        .then((response) => {
          // Read a CLONE — consuming the caller's body would break the page.
          response
            .clone()
            .text()
            .then(harvest)
            .catch(() => {});
        })
        .catch(() => {});
      return promise;
    };
  }
})();
