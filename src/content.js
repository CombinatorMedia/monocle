/**
 * Entry point: intercepts clicks on Google Images results to open our
 * fullscreen viewer instead of Google's own side panel, and responds to the
 * toolbar icon (via background.js) to open at the first result.
 */
(function () {
  let cachedResults = [];

  function refreshResults() {
    cachedResults = window.FivScraper.scrapeResults();
    return cachedResults;
  }

  function openAt(index, originRect) {
    const results = cachedResults.length ? cachedResults : refreshResults();
    window.FivOverlay.open(results, index, originRect);
  }

  // Intercept a click on any result thumbnail (capture phase, before Google's
  // own jsaction handler runs) and open our viewer instead.
  document.addEventListener(
    'click',
    (e) => {
      const img = e.target.closest && e.target.closest('img[id^="dimg_"]');
      if (!img) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) return; // ignore filter chips

      const results = refreshResults();
      const clickTarget = img.closest('.DeNS1c') || img;
      const index = results.findIndex((r) => r.clickTarget === clickTarget);
      if (index === -1) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      // The thumbnail's on-screen box, so the viewer can grow out of the
      // exact tile that was clicked rather than just fading in.
      openAt(index, rect);
    },
    true
  );

  // Re-scrape on scroll (debounced) so infinite-scroll-loaded results join
  // the filmstrip without needing to reopen the viewer.
  let scrollTimer = null;
  window.addEventListener(
    'scroll',
    () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const fresh = refreshResults();
        // root is undefined (not just hidden) until the viewer has been
        // opened at least once — `!root?.hidden` was true in BOTH the
        // "actually open" case and the "never opened yet" case (optional
        // chaining makes root?.hidden undefined, and !undefined is true),
        // so scrolling the page before ever clicking a thumbnail called
        // _renderFilmstrip() on an overlay that was never mount()-ed, where
        // this.els doesn't exist yet — "Cannot read properties of undefined
        // (reading 'filmstrip')".
        if (window.FivOverlay && window.FivOverlay.root && !window.FivOverlay.root.hidden) {
          const activeResult = window.FivOverlay.current;
          window.FivOverlay.results = fresh;
          // Match by id, not object identity — refreshResults() rebuilds all-new
          // result objects every time, so indexOf(activeResult) would never
          // find a match even when it's the same underlying image.
          if (activeResult) {
            const newIndex = fresh.findIndex((r) => r.id === activeResult.id);
            if (newIndex !== -1) window.FivOverlay.activeIndex = newIndex;
          }
          window.FivOverlay._renderFilmstrip();
        }
      }, 400);
    },
    { passive: true }
  );

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'fiv-open-toolbar') {
      openAt(0);
    }
  });
})();
