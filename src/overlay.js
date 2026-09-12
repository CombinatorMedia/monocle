/**
 * Builds and controls the fullscreen viewer overlay inside a Shadow DOM host
 * so none of Google's page styles leak in (and vice versa).
 */
(function (global) {
  const ICONS = {
    close: '<path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    starFilled: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" fill="currentColor"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    download: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    filmstripToggle: '<rect x="3" y="4" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/><rect x="3" y="18" width="4" height="3" rx="1" fill="currentColor"/><rect x="10" y="18" width="4" height="3" rx="1" fill="currentColor"/><rect x="17" y="18" width="4" height="3" rx="1" fill="currentColor"/>',
  };

  function svg(name) {
    return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${ICONS[name]}</svg>`;
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  class FivOverlay {
    constructor() {
      this.results = [];
      this.activeIndex = 0;
      this.pinned = new Set();
      this.mode = 'default'; // default | fullscreen | grid
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this._holdTimer = null;
      this._holdSpeed = 0;
      this._mounted = false;
      this._loadToken = 0;
    }

    mount() {
      if (this._mounted) return;
      this._mounted = true;

      this.host = document.createElement('div');
      this.host.id = 'fiv-host';
      document.documentElement.appendChild(this.host);
      this.shadow = this.host.attachShadow({ mode: 'open' });

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('src/overlay.css');
      // Stylesheet loading is asynchronous even for a local extension file —
      // on the very first open() of a page session, open() calls
      // _renderFilmstrip()/_centerActiveThumb() synchronously right after
      // appending this link, before the browser has actually applied it.
      // _centerActiveThumb() reads the filmstrip's clientWidth to compute a
      // scroll position, so if that read happens pre-stylesheet (default
      // unstyled layout), it scrolls to the wrong position — the active
      // thumb ends up correctly highlighted but scrolled out of view. Once
      // the sheet finishes loading, recompute using the now-correct layout.
      link.addEventListener('load', () => this._centerActiveThumb());
      this.shadow.appendChild(link);

      this.root = el(`
        <div class="fiv-root" hidden>
          <div class="fiv-panel"></div>
          <div class="fiv-minimap">
            <div class="fiv-minimap-extent"></div>
            <div class="fiv-minimap-crop"></div>
          </div>
          <div class="fiv-image-frame">
            <img alt="" class="fiv-photo is-active" />
            <img alt="" class="fiv-photo" />
          </div>
          <div class="fiv-badge">
            <span class="fiv-dim"></span><span class="fiv-dot">·</span><a class="fiv-domain" target="_blank" rel="noopener noreferrer"></a>
          </div>
          <div class="fiv-grid"></div>
          <div class="fiv-shortlist-pill" title="Click to view only starred images (S)"><span class="fiv-count"></span></div>
          <div class="fiv-icon-cluster">
            <button class="fiv-icon-btn fiv-close" title="Close (Esc)">${svg('close')}</button>
            <button class="fiv-icon-btn fiv-filmstrip-toggle is-active" title="Toggle filmstrip / fullscreen (F)">${svg('filmstripToggle')}</button>
            <button class="fiv-icon-btn fiv-star" title="Shortlist (Space)">${svg('star')}</button>
            <button class="fiv-icon-btn fiv-grid-toggle" title="Compare mode (G)">${svg('grid')}</button>
            <button class="fiv-icon-btn fiv-copy" title="Copy image (C)">${svg('copy')}</button>
            <button class="fiv-icon-btn fiv-download" title="Download image (D)">${svg('download')}</button>
          </div>
          <div class="fiv-filmstrip"></div>
          <div class="fiv-zoom-pill"></div>
          <div class="fiv-toast"></div>
          <div class="fiv-hint"><span>Scroll to zoom</span><span class="fiv-dot">·</span><span class="fiv-secondary">⌘/Ctrl or Shift + Scroll to pan</span></div>
        </div>
      `);
      this.shadow.appendChild(this.root);

      this._cacheEls();
      this._bindEvents();
    }

    _cacheEls() {
      const q = (s) => this.root.querySelector(s);
      this.els = {
        imageFrame: q('.fiv-image-frame'),
        // Two stacked photos so one can fade in while the other fades out.
        // A single <img> can't crossfade: swapping its src is instant, and
        // fading it means fading to empty frame and back, which is the
        // blank-between-photos problem itself.
        photos: Array.from(this.root.querySelectorAll('.fiv-photo')),
        badgeDim: q('.fiv-badge .fiv-dim'),
        badgeDomain: q('.fiv-badge .fiv-domain'),
        filmstrip: q('.fiv-filmstrip'),
        starBtn: q('.fiv-star'),
        gridToggleBtn: q('.fiv-grid-toggle'),
        filmstripToggleBtn: q('.fiv-filmstrip-toggle'),
        copyBtn: q('.fiv-copy'),
        downloadBtn: q('.fiv-download'),
        closeBtn: q('.fiv-close'),
        shortlistPillEl: q('.fiv-shortlist-pill'),
        shortlistPill: q('.fiv-shortlist-pill .fiv-count'),
        hint: q('.fiv-hint'),
        zoomPill: q('.fiv-zoom-pill'),
        toast: q('.fiv-toast'),
        minimap: q('.fiv-minimap'),
        minimapCrop: q('.fiv-minimap-crop'),
        grid: q('.fiv-grid'),
      };
    }

    _bindEvents() {
      this.els.closeBtn.addEventListener('click', () => this.close());
      this.els.starBtn.addEventListener('click', () => this.togglePin());
      this.els.filmstripToggleBtn.addEventListener('click', () => this.toggleFullscreen());
      this.els.gridToggleBtn.addEventListener('click', () => this.toggleGrid());
      this.els.copyBtn.addEventListener('click', () => this.copyCurrent());
      this.els.downloadBtn.addEventListener('click', () => this.downloadCurrent());
      this.els.shortlistPillEl.addEventListener('click', () => this.toggleShortlistView());

      this.els.imageFrame.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      this.els.imageFrame.addEventListener('mousedown', (e) => this._onPanStart(e));
      this.els.photos.forEach((p) => p.addEventListener('click', (e) => this._onImageClick(e)));

      this._keydownHandler = (e) => this._onKeydown(e);
      document.addEventListener('keydown', this._keydownHandler, true);
      this._keyupHandler = (e) => this._onKeyup(e);
      document.addEventListener('keyup', this._keyupHandler, true);

      // Resizing the window doesn't touch the filmstrip's contents, so
      // nothing else would re-run the centering math.
      window.addEventListener('resize', () => this._centerActiveThumb());
    }

    open(results, startIndex) {
      this.results = results;
      this.mount();
      this.root.hidden = false;
      this.goTo(startIndex || 0);
      this._renderFilmstrip();
      // Pins persist across close/reopen (see togglePin) — if you starred
      // things last time you had the viewer open, the pill should already
      // be showing that count rather than only appearing after the next
      // star/unstar action.
      this._updateShortlistPill();
    }

    close() {
      if (this.root) this.root.hidden = true;
      this._clearHold();
    }

    get current() {
      return this.results[this.activeIndex];
    }

    get visibleList() {
      return this.mode === 'shortlist' ? this.results.filter((r) => this.pinned.has(r.id)) : this.results;
    }

    // ---------- Navigation ----------

    goTo(index) {
      if (!this.results.length) return;
      this.activeIndex = ((index % this.results.length) + this.results.length) % this.results.length;
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      // Clears a drag flag left over from panning the PREVIOUS image. It's
      // only ever reset inside _onPanStart, which only runs on a mousedown
      // while zoomed in — so zoom+pan on image A, then navigate to image B
      // (now at zoom 1, where a plain click never touches _onPanStart at
      // all) left the stale "true" in place, and _onImageClick swallowed
      // the very next click on B as if it were the tail end of a drag. That
      // click did reset the flag afterward, so only every OTHER image's
      // click-to-open-source-page ever worked — intermittent by design.
      this._imgDidDrag = false;
      this._applyTransform();
      this._loadCurrent();
      this._renderFilmstrip();
    }

    // Steps within whatever list is actually showing in the filmstrip right
    // now (visibleList) rather than the raw results array — otherwise arrow
    // keys in shortlist view kept walking the full linear results, ignoring
    // the filter entirely. Wraps within that subset, and if the current
    // image somehow isn't in the visible list at all (e.g. it got un-starred
    // out from under you), falls back to just starting at the first item.
    _stepIndex(direction) {
      const list = this.visibleList;
      if (!list.length) return this.activeIndex;
      const posInList = list.indexOf(this.current);
      const nextPos = ((posInList === -1 ? 0 : posInList + direction) + list.length) % list.length;
      return this.results.indexOf(list[nextPos]);
    }

    next() { this.goTo(this._stepIndex(1)); }
    prev() { this.goTo(this._stepIndex(-1)); }

    async _loadCurrent() {
      const result = this.current;
      if (!result) return;
      // Every load takes a ticket, and only the newest ticket may touch the
      // <img>. Replaces an identity check against this.current, which had a
      // hole: content.js re-scrapes on scroll and assigns a brand-new
      // results array, so this.current stops being the same OBJECT as the
      // result we started with even when it's the same image — the check
      // then failed and this returned early.
      const token = ++this._loadToken;
      // onMetaReady: revealFullRes resolves as soon as the IMAGE is ready,
      // without waiting on metadata (dimensions/domain/source link) that
      // can occasionally lag behind or never show up. If metadata does
      // arrive a little late, this fills in the badge on its own.
      const revealed = await global.FivScraper.revealFullRes(result, {
        onMetaReady: (r) => { if (this.current === r) this._updateBadge(r); },
      });
      if (token !== this._loadToken) return; // a newer load owns the <img> now
      this._updateBadge(revealed);
      this._setStarIcon(this.pinned.has(revealed.id));
      this._swapImage(revealed.fullSrc || revealed.thumbSrc, token);
    }

    // Loads the next photo into whichever of the two stacked <img>s is
    // currently hidden, and only once it has actually decoded does it
    // crossfade the two. The outgoing photo holds at full opacity the entire
    // time, so there is never a frame with nothing in the viewer.
    //
    // The old single-<img> version hid the photo (opacity 0) BEFORE awaiting
    // the reveal and only un-hid it from a successful load event. That blanked
    // the viewer for the whole reveal + download of every navigation, and three
    // paths left it blank for good: an early return (nothing un-hid it), a load
    // error (no load event fires), and re-showing an already-cached src (no
    // load event either — the case backward navigation hits most, since
    // revisited results resolve instantly from cache).
    _swapImage(src, token) {
      const outgoing = this.els.photos.find((p) => p.classList.contains('is-active')) || this.els.photos[0];
      const incoming = this.els.photos.find((p) => p !== outgoing);
      const show = () => {
        if (token !== this._loadToken) return; // a newer load owns the frame now
        incoming.classList.add('is-active');
        outgoing.classList.remove('is-active');
      };
      if (outgoing.src === src) return; // already showing this photo
      incoming.onload = show;
      // On error, swap anyway — a broken-image state is more honest than
      // leaving the previous photo up underneath the new badge.
      incoming.onerror = show;
      if (incoming.src !== src) incoming.src = src;
      // Already decoded (same src as last time it was used, or a cache hit):
      // no load event is coming, so fade it in directly.
      if (incoming.complete && incoming.naturalWidth > 0) show();
    }

    _updateBadge(result) {
      this.els.badgeDim.textContent = result.width && result.height ? `${result.width.toLocaleString()} × ${result.height.toLocaleString()}` : '';
      this.els.badgeDomain.textContent = result.domain || '';
      if (result.sourcePage) {
        this.els.badgeDomain.href = result.sourcePage;
      } else {
        this.els.badgeDomain.removeAttribute('href');
      }
    }

    // Starred state is shown by swapping to a solid-filled star (not an
    // outline ring around the button, like the other active icons) — so the
    // icon itself has to change, not just get a color/outline toggled.
    _setStarIcon(isStarred) {
      this.els.starBtn.classList.toggle('is-starred', isStarred);
      this.els.starBtn.innerHTML = svg(isStarred ? 'starFilled' : 'star');
    }

    // ---------- Filmstrip ----------

    _renderFilmstrip() {
      const list = this.visibleList;
      this.els.filmstrip.innerHTML = '';
      list.forEach((result) => {
        const realIndex = this.results.indexOf(result);
        const thumb = el(`<div class="fiv-thumb" style="background-image:url('${result.thumbSrc}')"></div>`);
        if (realIndex === this.activeIndex) thumb.classList.add('is-active');
        if (this.pinned.has(result.id)) {
          thumb.classList.add('is-pinned');
          thumb.appendChild(el(`<div class="fiv-pin">${svg('starFilled')}</div>`));
          thumb.querySelector('.fiv-pin svg').style.color = '#ffb454';
        }
        thumb.addEventListener('click', () => this.goTo(realIndex));
        this.els.filmstrip.appendChild(thumb);
      });
      this._centerActiveThumb();
    }

    // The filmstrip spans edge-to-edge (left:0; right:0), so centering the
    // active thumb within the filmstrip's own scroll viewport IS centering
    // it in the window. Computed explicitly (rather than scrollIntoView,
    // which centers relative to whatever the browser decides is the nearest
    // scrollable ancestor) so it stays exact — including after a window
    // resize, when nothing else about the filmstrip changes to trigger it.
    // A thumb near the very start or end of the list has too few neighbors
    // on one side to ever be scrolled to center — there's simply no track
    // left to scroll into (scrollLeft clamps at 0/max, which is why the
    // first several thumbs always looked stuck at the left edge). The fix
    // used by every center-anchored carousel: pad both ends of the scrolling
    // track with "runway" equal to half the viewport (minus half a thumb),
    // so even the very first or last thumb has room to reach center.
    _updateFilmstripRunway() {
      const runway = Math.max(16, this.els.filmstrip.clientWidth / 2 - 40);
      this.els.filmstrip.style.paddingLeft = `${runway}px`;
      this.els.filmstrip.style.paddingRight = `${runway}px`;
    }

    _centerActiveThumb() {
      this._updateFilmstripRunway();
      const activeEl = this.els.filmstrip.querySelector('.is-active');
      if (!activeEl) return;
      const target = activeEl.offsetLeft + activeEl.offsetWidth / 2 - this.els.filmstrip.clientWidth / 2;
      this.els.filmstrip.scrollLeft = Math.max(0, target);
    }

    // ---------- Shortlist ----------

    togglePin() {
      const result = this.current;
      if (!result) return;
      // Tracked by the image's own stable id, not its array index — indices
      // shift every time the page is re-scraped (which happens on every
      // open, and again on scroll), so an index-based pin would silently
      // point at a different image next time. Also intentionally never
      // cleared on close(): starring should survive closing and reopening
      // the viewer on this same results page (a real page reload/new search
      // naturally resets it anyway, since the whole script reinitializes).
      if (this.pinned.has(result.id)) this.pinned.delete(result.id);
      else this.pinned.add(result.id);
      this._setStarIcon(this.pinned.has(result.id));
      this._updateShortlistPill();
      // Un-starring the last item while already filtered to shortlist-only
      // would otherwise leave the view showing nothing with no way back.
      if (this.mode === 'shortlist' && this.pinned.size === 0) this.toggleShortlistView();
      this._renderFilmstrip();
    }

    _updateShortlistPill() {
      this.els.shortlistPill.textContent = `Shortlist · ${this.pinned.size}`;
      this.els.shortlistPillEl.classList.toggle('is-visible', this.pinned.size > 0);
    }

    toggleShortlistView() {
      this.mode = this.mode === 'shortlist' ? 'default' : 'shortlist';
      this.root.classList.toggle('is-shortlist', this.mode === 'shortlist');
      // Switching into shortlist view while looking at a non-starred image
      // would otherwise leave the main image showing something that isn't
      // even in the filtered filmstrip, with no thumbnail marked active.
      const current = this.current;
      if (this.mode === 'shortlist' && (!current || !this.pinned.has(current.id))) {
        const list = this.visibleList;
        if (list.length) {
          this.goTo(this.results.indexOf(list[0]));
          return; // goTo() already re-renders the filmstrip
        }
      }
      this._renderFilmstrip();
    }

    // ---------- Fullscreen (filmstrip hidden) ----------

    toggleFullscreen() {
      const isFull = this.root.classList.toggle('is-fullscreen');
      this.els.filmstripToggleBtn.classList.toggle('is-active', !isFull);
    }

    // ---------- Grid compare ----------

    toggleGrid() {
      const isGrid = this.root.classList.toggle('is-grid');
      this.els.gridToggleBtn.classList.toggle('is-active', isGrid);
      if (isGrid) this._renderGrid();
    }

    async _renderGrid() {
      let source;
      if (this.pinned.size >= 2) {
        // The shortlist itself is uncapped (star as many as you want — they
        // all show in the filtered filmstrip), but Grid Compare's layout is
        // a fixed 2x2, so it shows your 4 MOST RECENTLY starred rather than
        // capping/evicting the shortlist itself. Set iteration order is
        // insertion order, so the last 4 ids are the most recent stars.
        // Resolved by id against the current results (not stored indices),
        // and silently dropped if an id no longer appears in this scrape.
        source = [...this.pinned]
          .slice(-4)
          .map((id) => this.results.find((r) => r.id === id))
          .filter(Boolean);
      } else {
        source = this.results.slice(this.activeIndex, this.activeIndex + 4);
      }
      this.els.grid.innerHTML = '';
      const cells = source.slice(0, 4).map((result) => {
        const cell = el(`<div class="fiv-grid-cell">
          <img alt="" src="${result.thumbSrc}" />
          <div class="fiv-badge"><span class="fiv-dim">${result.width ? result.width + ' × ' + result.height : ''}</span><span class="fiv-dot">·</span><span class="fiv-domain">${result.domain || ''}</span></div>
        </div>`);
        this.els.grid.appendChild(cell);
        return { cell, result };
      });
      // Reveal one at a time. Google's panel is a single shared element —
      // revealFullRes's generation guard makes a NEWER reveal supersede an
      // older in-flight one (which is what we want during fast arrow-key
      // navigation), but firing all four grid cells at once meant three of
      // them got superseded before ever finishing, leaving their badges
      // blank. Awaiting each in turn keeps them from racing each other.
      // Compare-mode badges are display-only (no link) — the source link
      // stays on the main and shortlist views only.
      for (const { cell, result } of cells) {
        const r = await global.FivScraper.revealFullRes(result);
        cell.querySelector('img').src = r.fullSrc || r.thumbSrc;
        cell.querySelector('.fiv-dim').textContent = r.width ? `${r.width} × ${r.height}` : '';
        cell.querySelector('.fiv-domain').textContent = r.domain || '';
      }
    }

    // ---------- Zoom + pan ----------

    _applyTransform() {
      // Both photos, so zoom/pan carries across a crossfade instead of the
      // incoming one snapping back to 1x mid-fade.
      const t = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
      this.els.photos.forEach((p) => { p.style.transform = t; });
      const zoomed = this.zoom > 1.01;
      this.els.zoomPill.textContent = `${Math.round(this.zoom * 100)}%`;
      this.els.zoomPill.style.opacity = zoomed ? '1' : '0';
      this.els.minimap.classList.toggle('is-visible', zoomed);
      // This was never actually wired up before — the hint pill's CSS only
      // shows it via an .is-visible class that nothing ever toggled, so it
      // was permanently invisible regardless of zoom state.
      this.els.hint.classList.toggle('is-visible', zoomed);
      if (zoomed) this._updateMinimap();
    }

    _updateMinimap() {
      const w = 94 / this.zoom;
      const h = 54 / this.zoom;
      const cx = 8 + 47 - w / 2 - (this.pan.x / 300) * 47;
      const cy = 8 + 27 - h / 2 - (this.pan.y / 300) * 27;
      Object.assign(this.els.minimapCrop.style, {
        left: `${Math.max(8, Math.min(94, cx))}px`,
        top: `${Math.max(8, Math.min(54, cy))}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
    }

    _onWheel(e) {
      e.preventDefault();
      const isPanModifier = e.metaKey || e.ctrlKey;
      const isShiftPan = e.shiftKey && !isPanModifier;
      if (isPanModifier) {
        this.pan.x -= e.deltaX;
        this.pan.y -= e.deltaY;
      } else if (isShiftPan) {
        // Horizontal-only pan. Some trackpads/browsers already convert a
        // shift+vertical scroll into deltaX before this handler sees it;
        // fall back to deltaY so it works the same either way.
        this.pan.x -= (e.deltaX !== 0 ? e.deltaX : e.deltaY);
      } else {
        const delta = -e.deltaY * 0.0015;
        this.zoom = Math.min(4, Math.max(1, this.zoom + delta));
        if (this.zoom === 1) this.pan = { x: 0, y: 0 };
      }
      this._applyTransform();
    }

    _onPanStart(e) {
      if (this.zoom <= 1) return;
      const start = { x: e.clientX, y: e.clientY };
      const startPan = { ...this.pan };
      // Tracks whether this gesture actually moved (vs. a plain click) so
      // the click handler below can tell a pan-drag apart from a click
      // intended to open the source page — the native "click" event still
      // fires on mouseup regardless of how far the pointer traveled.
      this._imgDidDrag = false;
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - start.x) > 3 || Math.abs(ev.clientY - start.y) > 3) {
          this._imgDidDrag = true;
        }
        this.pan.x = startPan.x + (ev.clientX - start.x);
        this.pan.y = startPan.y + (ev.clientY - start.y);
        this._applyTransform();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    // Clicking the main image opens its source page — the same destination
    // as the badge's domain link — but only for a genuine click, not the
    // mouseup at the end of a pan-drag.
    _onImageClick() {
      if (this._imgDidDrag) {
        this._imgDidDrag = false;
        return;
      }
      const sourcePage = this.current && this.current.sourcePage;
      if (sourcePage) window.open(sourcePage, '_blank', 'noopener,noreferrer');
    }

    // ---------- Copy / download ----------

    // Most third-party image hosts don't send CORS headers, so a fetch()
    // from here (bound by the page's own CORS rules) fails silently on
    // exactly the images this feature exists for. The background service
    // worker fetches instead — with host_permissions for the origin, its
    // fetch bypasses CORS entirely — and hands the bytes back as a data URL.
    _fetchViaBackground(src) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'fiv-fetch-image', url: src }, async (response) => {
          // needsPermission is distinct from a failure: the user simply
          // hasn't granted access to third-party image hosts, so the caller
          // should degrade rather than treat it as an error.
          if (response && response.needsPermission) { resolve({ needsPermission: true }); return; }
          if (!response || !response.ok) { resolve(null); return; }
          try {
            const res = await fetch(response.dataUrl); // data: URL, not a network request
            resolve({ blob: await res.blob() });
          } catch (e) {
            resolve(null);
          }
        });
      });
    }

    // navigator.clipboard.write pastes most reliably as image/png across
    // other apps, regardless of the source format (jpeg/webp/etc).
    // Converting via a data:-sourced canvas avoids any cross-origin taint.
    async _toPngBlob(blob) {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }

    async copyCurrent() {
      const src = this.current && (this.current.fullSrc || this.current.thumbSrc);
      if (!src) return;
      try {
        const result = await this._fetchViaBackground(src);
        if (result && result.needsPermission) {
          // Copying the image bytes needs access to whichever host serves it,
          // which is an optional permission granted from the options page.
          // Until then, put the URL on the clipboard — still useful, and it
          // needs no permission at all.
          await navigator.clipboard.writeText(src);
          this._flash('Image URL copied · enable image copying in settings');
          return;
        }
        if (!result || !result.blob) throw new Error('background fetch failed');
        const pngBlob = await this._toPngBlob(result.blob);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        this._flash('Image copied');
      } catch (e) {
        try {
          await navigator.clipboard.writeText(src);
          this._flash('Image URL copied');
        } catch (_) {
          this._flash("Couldn't copy this image");
        }
      }
    }

    _flash(message) {
      const el = this.els.toast;
      el.textContent = message;
      el.classList.add('is-visible');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
    }

    downloadCurrent() {
      const src = this.current && (this.current.fullSrc || this.current.thumbSrc);
      if (!src) return;
      chrome.runtime.sendMessage({ type: 'fiv-download', url: src });
    }

    // ---------- Keyboard ----------

    _onKeydown(e) {
      if (!this.root || this.root.hidden) return;
      switch (e.key) {
        // Escape steps back out one layer at a time rather than closing
        // outright, so the shortlist always has a way back to the single
        // image view even if the pill is missed or mis-clicked.
        case 'Escape':
          if (this.mode === 'shortlist') this.toggleShortlistView();
          else this.close();
          break;
        case 'ArrowRight': this._startHold(1); break;
        case 'ArrowLeft': this._startHold(-1); break;
        case ' ': e.preventDefault(); this.togglePin(); break;
        case 'f': case 'F': this.toggleFullscreen(); break;
        case 'g': case 'G': this.toggleGrid(); break;
        case 'c': case 'C': this.copyCurrent(); break;
        case 'd': case 'D': this.downloadCurrent(); break;
        case 's': case 'S': this.toggleShortlistView(); break;
        default: return;
      }
      e.preventDefault();
    }

    _onKeyup(e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') this._clearHold();
    }

    _startHold(dir) {
      if (this._holdTimer) return;
      this.goTo(this._stepIndex(dir));
      let interval = 260;
      const step = () => {
        this.goTo(this._stepIndex(dir));
        interval = Math.max(60, interval * 0.8);
        this._holdTimer = setTimeout(step, interval);
      };
      this._holdTimer = setTimeout(step, interval);
    }

    _clearHold() {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
  }

  global.FivOverlay = new FivOverlay();
})(window);
