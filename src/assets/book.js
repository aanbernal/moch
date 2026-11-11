// Book UI: hash routing, page visibility, navigation, zoom, and basic flip animation.
// Uses pure helpers from book-logic.js. Progressive enhancement: .page-nav links work without JS.
import {
  modeFromViewport,
  resolveHash,
  stepTarget,
  nearWindow,
  videoPlan,
} from "./book-logic.js";

(() => {
  try {
    const html = document.documentElement;
    const book = document.getElementById("book");
    if (!book) return;
    const sections = Array.from(book.querySelectorAll("section.page"));
    if (!sections.length) return;

    // Build page descriptors from DOM
    const pages = sections.map((el) => ({
      id: el.id,
      kind: el.dataset.kind || "",
      el,
    }));
    const byId = new Map(pages.map((p) => [p.id, p]));
    const phoneList = pages.filter((p) => p.kind !== "blank");
    const phoneIds = phoneList.map((p) => p.id);

    const barPrev = document.querySelector(".bar .nav.prev");
    const barNext = document.querySelector(".bar .nav.next");
    const barToc = document.querySelector(".bar .nav.toc");
    const announce = document.getElementById("anuncio");
    const zoomDialog = document.querySelector("dialog.zoom");
    const zoomStage = zoomDialog ? zoomDialog.querySelector(".zoom-stage") : null;

    let mode = modeFromViewport(window.innerWidth, window.innerHeight);
    let cursor = 0; // phone: index in phoneList, desktop: spread index
    let lastFocus = null;
    const lastDisplayed = new Set();

    function total() {
      return mode === 2 ? Math.ceil(pages.length / 2) : phoneList.length;
    }

    function displayedIds() {
      if (mode === 2) {
        const i = cursor * 2 - 1;
        const ids = [];
        if (cursor === 0) {
          ids.push(pages[0].id);
        } else {
          if (pages[i]) ids.push(pages[i].id);
          if (pages[i + 1]) ids.push(pages[i + 1].id);
        }
        return ids;
      }
      const p = phoneList[cursor];
      return p ? [p.id] : [pages[0].id];
    }

    function currentHashId() {
      const ids = displayedIds();
      // prefer non-cover, non-toc-ish first visible meaningful id; else first
      return ids[0] || "portada";
    }

    function setInert(el, inert) {
      if (inert) {
        el.setAttribute("inert", "");
        el.setAttribute("aria-hidden", "true");
        el.classList.remove("is-active", "is-left", "is-right");
      } else {
        el.removeAttribute("inert");
        el.removeAttribute("aria-hidden");
        el.classList.add("is-active");
      }
    }

    function updateVideoUi(box) {
      const video = box.querySelector("video");
      if (!video) return;
      const soundBtn = box.querySelector(".v-sound");
      const badge = box.querySelector(".v-badge");
      const paused = video.paused || video.ended;
      if (badge) badge.hidden = !paused;
      if (soundBtn) {
        const on = !video.muted;
        soundBtn.setAttribute("aria-pressed", on ? "true" : "false");
        soundBtn.setAttribute("aria-label", on ? "Silenciar" : "Sonido");
      }
    }

    function syncVideos() {
      const displayed = new Set(displayedIds());
      for (const p of pages) {
        const videos = p.el.querySelectorAll("video");
        if (!videos.length) continue;
        const isDisplayed = displayed.has(p.id) && !document.hidden;
        for (const video of videos) {
          if (isDisplayed) {
            if (!lastDisplayed.has(p.id)) {
              // entering: start from beginning, muted autoplay
              try { video.currentTime = 0; } catch {}
              video.muted = true;
            }
            const pr = video.play();
            if (pr && typeof pr.catch === "function") pr.catch(() => {});
          } else {
            try { video.pause(); } catch {}
          }
          const box = video.closest(".video-box");
          if (box) updateVideoUi(box);
        }
      }
      lastDisplayed.clear();
      for (const id of displayed) lastDisplayed.add(id);
    }

    function render(opts = {}) {
      mode = modeFromViewport(window.innerWidth, window.innerHeight);
      const max = total();
      if (cursor < 0) cursor = 0;
      if (cursor >= max) cursor = max - 1;

      // hide all
      for (const p of pages) {
        setInert(p.el, true);
        p.el.classList.remove("is-left", "is-right", "spread-single");
      }

      let ids = displayedIds();
      if (mode === 2) {
        // Avoid showing structural blank padding pages: show the content page alone instead.
        const filtered = ids.filter((id) => (byId.get(id)?.kind || "") !== "blank");
        if (filtered.length === 1) ids = filtered;
        else if (filtered.length === 0) ids = [ids[0]].filter(Boolean);
        book.dataset.pages = ids.length === 1 ? "1" : "2";
        if (ids.length === 1) {
          const p = byId.get(ids[0]);
          if (p) { setInert(p.el, false); p.el.classList.add("spread-single"); }
        } else {
          const left = byId.get(ids[0]);
          const right = byId.get(ids[1]);
          if (left) { setInert(left.el, false); left.el.classList.add("is-left"); }
          if (right) { setInert(right.el, false); right.el.classList.add("is-right"); }
        }
      } else {
        book.dataset.pages = "1";
        const p = byId.get(ids[0]);
        if (p) { setInert(p.el, false); p.el.classList.add("spread-single"); }
      }

      // announce
      if (announce) {
        const first = byId.get(ids[0]);
        announce.textContent = first && first.el.dataset.label ? first.el.dataset.label : "";
      }

      // update hash without scrolling
      if (opts.updateHash !== false) {
        const hashId = currentHashId();
        const want = "#" + hashId;
        if (location.hash !== want) {
          history.replaceState(null, "", want);
        }
      }

      syncVideos();
    }

    function goToCursor(next, opts = {}) {
      const max = total();
      if (next == null || next < 0 || next >= max) return;
      const prev = cursor;
      cursor = next;
      // simple flip animation class
      if (opts.animate !== false) {
        const dir = next > prev ? "flip-next" : "flip-prev";
        book.classList.remove("flip-next", "flip-prev");
        // force reflow
        void book.offsetWidth;
        book.classList.add(dir);
        window.setTimeout(() => book.classList.remove("flip-next", "flip-prev"), 500);
      }
      render(opts);
    }

    function goToHash(hash, opts = {}) {
      cursor = resolveHash(hash || location.hash, pages, mode);
      render({ ...opts, updateHash: true });
      // sync cursor after possible mode; resolveHash used current mode
    }

    function step(dir) {
      const next = stepTarget(cursor, dir, total());
      if (next != null) goToCursor(next, { animate: true, updateHash: true });
    }

    // Navigation buttons
    if (barPrev) barPrev.addEventListener("click", (e) => { e.preventDefault(); step(-1); });
    if (barNext) barNext.addEventListener("click", (e) => { e.preventDefault(); step(1); });
    if (barToc) barToc.addEventListener("click", (e) => {
      e.preventDefault();
      // go to indice page
      cursor = resolveHash("#indice", pages, mode);
      render({ animate: true, updateHash: true });
    });

    // Intercept in-page nav links and TOC links
    document.addEventListener("click", (e) => {
      const a = e.target.closest("a[href^='#']");
      if (!a) return;
      const hash = a.getAttribute("href");
      if (!hash || hash === "#") return;
      // zoom-open links handled below
      if (a.classList.contains("zoom-open")) return;
      const id = hash.slice(1);
      if (!byId.has(id) && id !== "indice") return;
      e.preventDefault();
      cursor = resolveHash(hash, pages, mode);
      render({ animate: true, updateHash: true });
      // focus book for keyboard
      book.focus && book.focus();
    });

    // Keyboard
    document.addEventListener("keydown", (e) => {
      if (zoomDialog && zoomDialog.open) {
        if (e.key === "Escape") { e.preventDefault(); zoomDialog.close(); }
        return;
      }
      const tag = (e.target && e.target.tagName) || "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "Home") { e.preventDefault(); goToCursor(0, { animate: true }); }
      else if (e.key === "End") { e.preventDefault(); goToCursor(total() - 1, { animate: true }); }
    });

    // Touch swipe
    let touch = null;
    book.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { touch = null; return; }
      const t = e.target;
      if (t.closest("[data-no-swipe], video, a, button, dialog, input, textarea, select")) { touch = null; return; }
      touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    book.addEventListener("touchend", (e) => {
      if (!touch || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - touch.x;
      const dy = e.changedTouches[0].clientY - touch.y;
      touch = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      if (dx < 0) step(1); else step(-1);
    }, { passive: true });

    // Zoom for letters/images
    if (zoomDialog) {
      document.addEventListener("click", (e) => {
        const btn = e.target.closest(".zoom-open");
        if (!btn) return;
        // turn into zoom action (progressive enhancement: link works without JS)
        e.preventDefault();
        lastFocus = btn;
        const src = btn.dataset.zoom || btn.getAttribute("href");
        const img = btn.querySelector("img");
        const alt = img ? img.getAttribute("alt") || "" : "";
        const w = btn.dataset.zoomWidth || (img ? img.getAttribute("width") : "");
        const h = btn.dataset.zoomHeight || (img ? img.getAttribute("height") : "");
        if (zoomStage) {
          zoomStage.innerHTML = "";
          const big = document.createElement("img");
          big.src = src;
          big.alt = alt;
          if (w) big.width = Number(w);
          if (h) big.height = Number(h);
          zoomStage.appendChild(big);
        }
        try { zoomDialog.showModal(); } catch { zoomDialog.setAttribute("open", ""); }
      });
      zoomDialog.addEventListener("close", () => {
        if (zoomStage) zoomStage.innerHTML = "";
        if (lastFocus && typeof lastFocus.focus === "function") {
          try { lastFocus.focus(); } catch {}
        }
      });
      zoomDialog.addEventListener("click", (e) => {
        if (e.target === zoomDialog) zoomDialog.close();
      });
    }

    // Video controls: tap video toggles play/pause, Sonido toggles sound. No navigation/open.
    document.addEventListener("click", (e) => {
      if (e.target.closest("a[href$='.mp4']")) { e.preventDefault(); e.stopPropagation(); }
      const soundBtn = e.target.closest(".v-sound");
      const badge = e.target.closest(".v-badge");
      const box = e.target.closest(".video-box");
      if (!box) return;
      const video = box.querySelector("video");
      if (!video) return;
      if (soundBtn) {
        e.preventDefault(); e.stopPropagation();
        video.muted = !video.muted;
        if (!video.muted) { video.play().catch(() => {}); }
        updateVideoUi(box);
        return;
      }
      // tap on video/badge/box toggles play/pause only
      if (badge || e.target.closest("video") || e.target === box) {
        e.preventDefault(); e.stopPropagation();
        if (video.paused || video.ended) video.play().catch(() => {});
        else video.pause();
        updateVideoUi(box);
      }
    });
    document.addEventListener("play", (e) => { const box = e.target.closest?.(".video-box"); if (box) updateVideoUi(box); }, true);
    document.addEventListener("pause", (e) => { const box = e.target.closest?.(".video-box"); if (box) updateVideoUi(box); }, true);
    document.addEventListener("volumechange", (e) => { const box = e.target.closest?.(".video-box"); if (box) updateVideoUi(box); }, true);
    document.addEventListener("error", (e) => {
      const v = e.target;
      if (v && v.tagName === "VIDEO") {
        try { v.load(); } catch {}
        const box = v.closest(".video-box");
        if (box) updateVideoUi(box);
      }
    }, true);

    // Hash changes (back/forward)
    window.addEventListener("hashchange", () => {
      cursor = resolveHash(location.hash, pages, mode);
      render({ animate: false, updateHash: false });
    });

    // Resize/orientation: mode may change
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const newMode = modeFromViewport(window.innerWidth, window.innerHeight);
        const currentId = currentHashId();
        mode = newMode;
        lastDisplayed.clear();
        cursor = resolveHash("#" + currentId, pages, mode);
        render({ animate: false, updateHash: true });
      }, 120);
    });

    document.addEventListener("visibilitychange", syncVideos);

    // Click/tap on cover opens the book
    const cover = byId.get("portada");
    if (cover) {
      cover.el.addEventListener("click", (e) => {
        if (e.target.closest("a, button, input, textarea, select, [data-no-swipe]")) return;
        if (displayedIds().includes("portada")) step(1);
      });
    }

    // Initial render
    html.classList.remove("no-js");
    html.classList.add("js");
    mode = modeFromViewport(window.innerWidth, window.innerHeight);
    cursor = resolveHash(location.hash, pages, mode);
    render({ animate: false, updateHash: true });

    // Service worker (best effort)
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  } catch (err) {
    console.error("book.js failed", err);
  }
})();
