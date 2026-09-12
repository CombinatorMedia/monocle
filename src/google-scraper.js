/**
 * Scrapes Google Images search results and reveals full-resolution source
 * images on demand.
 *
 * IMPORTANT — fragility notice: Google's Images markup is undocumented and
 * unofficial. The class names in SELECTORS below were captured against a live
 * page on 2026-09-11 and WILL break when Google next changes its markup.
 * When that happens, re-inspect the live DOM and update SELECTORS only —
 * nothing else in this file should need to change.
 *
 * How full-res reveal works: Google does not preload full-resolution URLs for
 * every result. Each thumbnail only loads its full-size image (and the
 * source page link with dimensions/domain) after a click opens Google's own
 * side panel. Rather than reverse-engineer Google's internal JSON, we
 * dispatch a synthetic click on the same element a user would click, wait for
 * Google's own panel to populate, then read the resulting DOM — riding on
 * Google's existing behavior instead of fighting it.
 */
(function (global) {
  const SELECTORS = {
    // Each low-res thumbnail <img>. Google embeds the thumbnail as an inline
    // base64 data URI directly on this element (see _setImagesSrc in page
    // source) — no network fetch needed for the filmstrip.
    thumbImg: 'img[id^="dimg_"]',
    // Nearest ancestor that owns the click (jsaction) to open Google's panel.
    clickableAncestorClass: 'DeNS1c',
    // The revealed full-resolution image once Google's panel has loaded it.
    // Google reuses ONE element for whichever result was last clicked and
    // adds an extra class once the real (non-placeholder) image has loaded.
    revealedImgSelector: 'img.sFlh5c.FyHeAf.YkEcKe',
    // A link near the panel pointing at the source page; its text usually
    // contains "<width> × <height>" and its href's hostname is the domain.
    sourceLinkSelector: 'a[href^="http"]',
    // Google's reveal panel wrapper: position:fixed, full viewport, z-index
    // 1000, opaque background. Captured live 2026-09-11 alongside the rest.
    panelWrapperClass: 'PG8i1e',
  };

  const DIMENSION_RE = /([\d,]+)\s*[×x]\s*([\d,]+)/;

  // Hide Google's panel with a plain stylesheet, installed once, up front.
  // suppressGooglePanel() below can only react AFTER Google has inserted the
  // panel — even from a MutationObserver microtask that leaves a window where
  // the panel is in the DOM, visible and opaque, and the browser may paint it
  // before we get to hide it. That race is what makes the flash intermittent
  // and impossible to fully close by tuning the reaction. A style rule has no
  // such window: the panel is hidden from its very first paint, every time,
  // because the rule is already in the cascade before the element exists.
  //
  // visibility:hidden specifically (not display:none) so the panel still gets
  // laid out — the reveal depends on reading the image's src and the source
  // link's dimensions out of it, and those need real layout boxes.
  // suppressGooglePanel stays as the fallback for when this class name
  // inevitably changes; if it's stale, this rule simply matches nothing.
  //
  // The second rule is the one that actually stops the viewer from blinking
  // out. Google opens this panel through the View Transitions API: from the
  // second result you open onward, every reveal calls startViewTransition,
  // and Chrome then renders ::view-transition-old/new snapshots of the panel
  // for the UA default duration (measured live: ~160ms per navigation). Those
  // pseudo-elements paint in the TOP LAYER, which sits above every z-index —
  // including our overlay's 2147483000 — so a full-viewport snapshot of
  // Google's opaque panel covered the whole viewer, and nothing we did to the
  // live panel element could prevent it: the snapshot is captured up front and
  // renders independently of the element's own visibility. That's why hiding
  // the panel harder never helped, and why the badge appeared to survive
  // while everything else vanished. Cancelling the UA animations makes the
  // transition resolve in a single frame with nothing drawn over us.
  const panelStyle = document.createElement('style');
  panelStyle.textContent = `
    .${SELECTORS.panelWrapperClass} { visibility: hidden !important; }
    ::view-transition-group(*),
    ::view-transition-image-pair(*),
    ::view-transition-old(*),
    ::view-transition-new(*) {
      animation: none !important;
      mix-blend-mode: normal !important;
    }`;
  document.documentElement.appendChild(panelStyle);

  /** Scans the current page for result thumbnails. Call again after the user
   * scrolls to pick up newly-loaded results (Google infinite-scrolls). */
  function scrapeResults() {
    const seen = new Set();
    const results = [];
    document.querySelectorAll(SELECTORS.thumbImg).forEach((img) => {
      const rect = img.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) return; // skip filter chips etc.

      // Shopping/product-listing-ad thumbnails (.pla-unit) also match
      // img[id^="dimg_"] but have none of the jsaction wiring the
      // .DeNS1c container provides for organic results — Google's own click
      // handling for them can navigate straight to the merchant's site
      // instead of opening the reveal panel. Dispatching our synthetic click
      // on one was following it off the page entirely (arrow-key navigation
      // landing on an ad thumbnail triggered a real navigation). Requiring
      // the .DeNS1c ancestor excludes ads and anything else that doesn't
      // support the reveal mechanism we depend on, rather than special-
      // casing ads by name.
      const container = img.closest(`.${SELECTORS.clickableAncestorClass}`);
      if (!container) return;

      const clickTarget = container;
      if (seen.has(clickTarget)) return;
      seen.add(clickTarget);
      results.push({
        id: img.id || `fiv_${results.length}`,
        thumbSrc: img.currentSrc || img.src,
        clickTarget,
        fullSrc: null,
        width: null,
        height: null,
        domain: null,
        sourcePage: null,
      });
    });
    return results;
  }

  function dispatchClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // The real element responsible for the flash is Google's side panel
  // wrapper — position:fixed, pinned to the right edge of the viewport
  // (right: ~20px), with a solid white background. It sits ~13-14 ancestors
  // above the revealed <img>, far past a shallow walk-up, and being
  // fixed-positioned it's pinned to the SCREEN, not the page, which is why
  // it reads as "the panel pegged to the right side" independent of scroll.
  // Everything below it in the tree is position:static/relative — ordinary
  // in-flow content — so searching for the nearest fixed/sticky ancestor
  // targets it specifically rather than guessing a fixed depth.
  // Back to visibility:hidden (not opacity:0). Opacity was only ever needed
  // because findDimensionLink used to read link.innerText, and innerText
  // treats visibility:hidden as "not rendered," returning "" for anything
  // inside it. That's no longer true: findDimensionLink now walks text
  // nodes directly via matchDimensionText, using textContent per node — a
  // read that is NOT affected by CSS visibility at all. So the original
  // reason to avoid visibility:hidden is gone, and visibility:hidden is the
  // version that was actually confirmed to suppress the flash; reverting to
  // it rather than leaving opacity as an unnecessary, unverified variable.
  function suppressGooglePanel(revealedImg) {
    let el = revealedImg.parentElement;
    let innerCardHidden = false;
    for (let i = 0; i < 24 && el; i++) {
      const style = getComputedStyle(el);
      if (!innerCardHidden) {
        const bg = style.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
          innerCardHidden = true;
        }
      }
      if (style.position === 'fixed' || style.position === 'sticky') {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        return;
      }
      el = el.parentElement;
    }
  }

  // The reveal poll below only checks every 60ms, which is slower than a
  // single frame (~16ms) — long enough for Google's own panel update to
  // actually paint once before we catch up and suppress it. A
  // MutationObserver callback runs as a microtask, effectively before the
  // next paint, so it reacts fast enough to suppress the panel before it's
  // ever visible at all. Set up once for the page's lifetime; the callback
  // itself is cheap (one querySelector), so firing on every DOM change from
  // Google's own infinite-scroll/lazy-load churn is not a concern.
  //
  // A previous version of this also walked every mutation's addedNodes and
  // called getComputedStyle() on each one looking for position:fixed. That
  // was a real regression: getComputedStyle() forces a synchronous style
  // recalculation, and Google's panel-opening process inserts many nodes
  // across many mutations — checking each one synchronously inside this
  // callback caused serious main-thread jank (long freezes, and the reveal
  // poll's own setTimeout getting delayed enough to time out). Reverted back
  // to the cheap, targeted check.
  const panelObserver = new MutationObserver(() => {
    const placeholder = document.querySelector('img.sFlh5c.FyHeAf');
    if (placeholder) suppressGooglePanel(placeholder);
  });
  panelObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'style', 'class'],
  });

  // Verified directly against Google's live markup: the dimension label
  // lives in TWO identical <span class="UWuvyf" style="display:none">
  // elements inside the source link — never actually shown on screen at
  // all, seemingly present only for accessibility/structured-data purposes.
  // link.textContent concatenates both with no separator, which is what
  // produced garbled values like "14402160" (two "1440 × 2160" runs run
  // together). link.innerText doesn't fix that: innerText excludes ALL
  // display:none content by definition, so it returns "" for this link
  // every time regardless of anything our own suppression does — that was
  // the real cause of the very next regression (every reveal timing out
  // with a permanently blank badge). Walking each text node individually
  // sidesteps both failure modes: we read Google's string exactly as
  // written, once, whether or not it's display:none.
  function matchDimensionText(link) {
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text) continue;
      const match = DIMENSION_RE.exec(text);
      if (match) return match;
    }
    return null;
  }

  function findDimensionLink(scope) {
    const links = Array.from(scope.querySelectorAll(SELECTORS.sourceLinkSelector));
    for (const link of links) {
      const rect = link.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const match = matchDimensionText(link);
      if (match) return { link, match };
    }
    return null;
  }

  function parseDimensionsAndSource(revealedImg) {
    // Scope the search to a container near the just-revealed image rather
    // than the whole document — otherwise an unrelated link elsewhere on the
    // page (a related-image thumbnail, a previous result) that happens to
    // match the dimension pattern can get attributed to the wrong image.
    // Climb a few ancestors to get past the <img>/<a> themselves into a
    // reasonably-scoped panel container; fall back to the whole document if
    // that scope comes up empty.
    let found = null;
    if (revealedImg) {
      let el = revealedImg;
      for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
      found = findDimensionLink(el);
    }
    if (!found) found = findDimensionLink(document);
    if (!found) return null;

    const { link, match } = found;
    let domain = null;
    try {
      domain = new URL(link.href).hostname.replace(/^www\./, '');
    } catch (e) {
      domain = null;
    }
    return {
      width: parseInt(match[1].replace(/,/g, ''), 10),
      height: parseInt(match[2].replace(/,/g, ''), 10),
      domain,
      sourcePage: link.href,
    };
  }

  // Google has exactly ONE shared panel/image element, reused for whichever
  // result was clicked most recently. If the user navigates again before a
  // previous reveal finishes polling, that older poll would otherwise read
  // the panel at the wrong moment and permanently cache the WRONG image onto
  // its result (result.fullSrc is cached — see the early-return above — so a
  // bad write here means that thumbnail shows the wrong photo forever after).
  // A generation counter lets every in-flight call notice it's been
  // superseded and bail out instead of trusting stale/shared panel state.
  let revealGeneration = 0;

  /** Reveals a result's full-resolution image + metadata. Resolves with the
   * mutated result object (also mutates in place so repeat calls are cheap)
   * as soon as the IMAGE is ready — metadata (dimensions/domain/source link)
   * is best-effort and must never hold up the image.
   *
   * That split matters because the overlay keeps the currently-displayed
   * image invisible (a CSS crossfade) for as long as this promise is
   * pending. An earlier version of this function only resolved once BOTH
   * the image AND its metadata were found, to fix a first-click-of-session
   * case where the metadata link's text lagged the image by a tick. That
   * fixed the badge, but for any result whose dimension link is slow to lay
   * out to a non-zero size (seen on some shopping-style results — see
   * findDimensionLink's rect check) or never resolves at all, the image
   * stayed hidden for the FULL timeout waiting on metadata that was never
   * coming — "the UI disappearing for half a second" (or worse) on
   * ordinary navigation, not just the first click. onMetaReady lets the
   * caller catch metadata that arrives after the image already resolved,
   * so the badge still fills in without blocking the photo. */
  function revealFullRes(result, { timeoutMs = 2500, metaCatchUpMs = 1200, pollMs = 60, onMetaReady } = {}) {
    if (result.fullSrc) return Promise.resolve(result);

    const myGeneration = ++revealGeneration;

    // Google reuses ONE panel element across every click. Checking only "is
    // there a non-placeholder src" is not enough — on the very first click of
    // a session, that element can already hold a stale/default image from
    // before we ever clicked anything, and we'd grab that immediately (first
    // poll tick) instead of waiting for it to actually update to what we just
    // clicked. Recording its src beforehand and requiring a CHANGE closes
    // that gap.
    const beforeEl = document.querySelector(SELECTORS.revealedImgSelector);
    const beforeSrc = beforeEl ? beforeEl.src : null;

    dispatchClick(result.clickTarget);

    // Suppress immediately too — the panel is visible (white background,
    // placeholder thumbnail) for the whole gap between click and full-res
    // load, not just at the end of it.
    const placeholder = document.querySelector('img.sFlh5c.FyHeAf');
    if (placeholder) suppressGooglePanel(placeholder);

    return new Promise((resolve) => {
      const start = Date.now();
      let imageResolved = false;
      let metaDeadline = null; // starts counting only once the image itself is ready
      const tick = () => {
        if (myGeneration !== revealGeneration) {
          // A newer navigation superseded us — the shared panel no longer
          // reflects OUR click. Don't touch result.fullSrc at all; leave it
          // null so a later revisit tries again instead of being stuck with
          // nothing (or worse, someone else's image).
          if (!imageResolved) resolve(result);
          return;
        }
        const revealed = document.querySelector(SELECTORS.revealedImgSelector);
        const isNewImage = revealed && revealed.src && !revealed.src.startsWith('data:') && revealed.src !== beforeSrc;
        if (isNewImage) {
          suppressGooglePanel(revealed);
          const meta = parseDimensionsAndSource(revealed);
          if (meta) {
            result.width = meta.width;
            result.height = meta.height;
            result.domain = meta.domain;
            result.sourcePage = meta.sourcePage;
          }
          if (!imageResolved) {
            imageResolved = true;
            result.fullSrc = revealed.src;
            resolve(result);
            if (meta) return; // both ready — done
            metaDeadline = Date.now() + metaCatchUpMs; // give metadata a short grace period
          } else if (meta) {
            if (onMetaReady) onMetaReady(result);
            return;
          }
        }
        const hardTimedOut = Date.now() - start > timeoutMs;
        const metaGraceExpired = metaDeadline !== null && Date.now() > metaDeadline;
        if (hardTimedOut || metaGraceExpired) {
          if (!imageResolved) {
            // Fall back to the thumbnail so the viewer still shows
            // something even if the image itself never showed up.
            result.fullSrc = result.thumbSrc;
            resolve(result);
          }
          // Otherwise the image already resolved; metadata just never
          // showed up in time — leave it null and give up quietly.
          return;
        }
        setTimeout(tick, pollMs);
      };
      tick();
    });
  }

  global.FivScraper = { scrapeResults, revealFullRes };
})(window);
