/**
 * Scrapes Google Images search results.
 *
 * IMPORTANT — fragility notice: Google's Images markup is undocumented and
 * unofficial. The class names in SELECTORS below were captured against a live
 * page on 2026-09-16 and WILL break when Google next changes its markup.
 * When that happens, re-inspect the live DOM and update SELECTORS only —
 * nothing else in this file should need to change.
 *
 * How full-res images are resolved: Google ships every result's real image URL,
 * true dimensions and source page in its own page data — inline for the first
 * page of results, and in the XHR responses that serve infinite scroll.
 * page-data.js (main world) reads that data and posts it here, keyed by the
 * result's "docid", which each tile carries as its element id ("e-<docid>").
 *
 * This replaced a click-and-scrape approach: the extension used to synthesize a
 * click on each tile, let Google open its own full-screen panel, and read the
 * DOM the panel produced. Riding Google's reveal that way meant opening a panel
 * we then had to hide — and because Google opens it through the View
 * Transitions API, whose snapshots paint in the top layer above ANY z-index,
 * the viewer intermittently blinked out mid-navigation. Reading the data
 * instead removed the click, the panel, the transition, and with them the
 * panel-hiding CSS, the transition-cancelling CSS, a MutationObserver, a 60ms
 * polling loop, a generation counter, an aspect-ratio identity check and the
 * gstatic-proxy upgrade path. There is nothing left to suppress, and nothing
 * left to race.
 */
(function (global) {
  const SELECTORS = {
    // Each low-res thumbnail <img>. Google embeds most thumbnails as inline
    // base64 data URIs directly on this element — no network fetch needed for
    // the filmstrip.
    thumbImg: 'img[id^="dimg_"]',
    // Nearest ancestor that owns the result. Also the element whose id encodes
    // the docid, and the boundary that excludes shopping/product-listing ads:
    // those match img[id^="dimg_"] too but have none of this wiring.
    clickableAncestorClass: 'DeNS1c',
  };

  // docid -> { full, width, height, page, title }, filled by page-data.js.
  const imageData = new Map();

  window.addEventListener('message', (event) => {
    // Only trust messages this window posted to itself. Anything cross-origin
    // or cross-frame is ignored; the payload is used solely as image metadata.
    if (event.source !== window || event.origin !== window.location.origin) return;
    const records = event.data && event.data.__fivImageRecords;
    if (!Array.isArray(records)) return;
    for (const r of records) {
      if (r && typeof r.docid === 'string' && typeof r.full === 'string' && !imageData.has(r.docid)) {
        imageData.set(r.docid, r);
      }
    }
  });

  // page-data.js starts posting at document_start; this script only loads at
  // document_idle, so the first page's records were already broadcast to an
  // empty room. Ask for a replay now that the listener above is attached.
  window.postMessage({ __fivRequestRecords: true }, window.location.origin);

  // The tile's element id is "e-<docid>"; jsdata carries the same docid as its
  // second field, as a fallback if the id attribute ever stops being set.
  function docIdOf(tile) {
    const id = tile.id || '';
    if (id.startsWith('e-')) return id.slice(2);
    const jsdata = tile.getAttribute('jsdata') || '';
    const parts = jsdata.split(';');
    return parts.length > 1 && parts[1] !== '_' ? parts[1] : null;
  }

  function applyRecord(result, record) {
    if (!record) return false;
    result.fullSrc = record.full;
    result.previewSrc = record.preview || null;
    result.width = record.width;
    result.height = record.height;
    result.sourcePage = record.page;
    if (record.page) {
      try {
        result.domain = new URL(record.page).hostname.replace(/^www\./, '');
      } catch (e) {
        result.domain = null;
      }
    }
    return true;
  }

  /** Scans the current page for result thumbnails. Call again after the user
   * scrolls to pick up newly-loaded results (Google infinite-scrolls). */
  function scrapeResults() {
    const seen = new Set();
    const results = [];
    document.querySelectorAll(SELECTORS.thumbImg).forEach((img) => {
      const rect = img.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) return; // skip filter chips etc.

      // Shopping/product-listing-ad thumbnails (.pla-unit) also match
      // img[id^="dimg_"] but sit outside .DeNS1c and have no result record.
      const container = img.closest(`.${SELECTORS.clickableAncestorClass}`);
      if (!container) return;
      if (seen.has(container)) return;
      seen.add(container);

      const result = {
        id: img.id || `fiv_${results.length}`,
        docId: docIdOf(container),
        thumbSrc: img.currentSrc || img.src,
        clickTarget: container,
        fullSrc: null,
        previewSrc: null,
        width: null,
        height: null,
        domain: null,
        sourcePage: null,
      };
      applyRecord(result, result.docId && imageData.get(result.docId));
      results.push(result);
    });
    return results;
  }

  /** Fills in a result's full-resolution URL and metadata.
   *
   * Almost always instant: the record is already in hand by the time a result
   * is on screen, because Google shipped it with the markup that drew the tile.
   * The short wait covers the narrow case where a tile has been painted but the
   * response carrying its record is still arriving — far better than the old
   * 2.5s reveal timeout, and it blocks nothing: the viewer shows the thumbnail
   * meanwhile and swaps up when this resolves.
   */
  function revealFullRes(result, { timeoutMs = 600, pollMs = 40 } = {}) {
    if (result.fullSrc) return Promise.resolve(result);
    if (applyRecord(result, result.docId && imageData.get(result.docId))) {
      return Promise.resolve(result);
    }
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (applyRecord(result, result.docId && imageData.get(result.docId))) {
          resolve(result);
          return;
        }
        if (Date.now() >= deadline) {
          // No record for this result — show the thumbnail rather than nothing.
          // Deliberately NOT cached onto fullSrc, so a later visit can still
          // pick up a record that arrives after this give-up.
          resolve(result);
          return;
        }
        setTimeout(tick, pollMs);
      };
      tick();
    });
  }

  global.FivScraper = { scrapeResults, revealFullRes };
})(window);
