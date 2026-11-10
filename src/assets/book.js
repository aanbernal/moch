// Digital album book interaction (design 3, Req 1.3, 1.8, 1.9, 1.10, 19.1, 19.5).
// Swipe, arrow-key navigation, dialog zoom with focus restoration, next-page prefetch,
// and service worker registration. Wrapped so any error leaves standard link navigation working.

(() => {
  try {
    // 1. Service worker registration on public pages
    if ("serviceWorker" in navigator && !window.location.pathname.startsWith("/admin")) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {
          // SW registration failed, non-fatal
        });
      });
    }

    // 2. Next-page prefetch
    const nextLink = document.querySelector('a.next, a[rel="next"]');
    if (nextLink && nextLink.href) {
      const linkEl = document.createElement("link");
      linkEl.rel = "prefetch";
      linkEl.href = nextLink.href;
      document.head.appendChild(linkEl);
    }

    // 3. Zoom dialog handling with focus restoration
    let lastActiveElement = null;

    document.addEventListener("click", (e) => {
      const trigger = e.target.closest("a.zoom-open, [data-zoom]");
      if (trigger) {
        const dialogId = trigger.dataset.zoom || trigger.getAttribute("data-zoom");
        const dialog = dialogId ? document.getElementById(dialogId) : null;
        if (dialog && typeof dialog.showModal === "function") {
          e.preventDefault();
          lastActiveElement = trigger;
          dialog.showModal();
        }
      }
    });

    document.addEventListener("close", (e) => {
      if (e.target && e.target.nodeName === "DIALOG" && e.target.classList.contains("zoom")) {
        if (lastActiveElement && typeof lastActiveElement.focus === "function") {
          lastActiveElement.focus();
        }
      }
    }, true);

    // Close zoom dialog on backdrop click
    document.addEventListener("click", (e) => {
      if (e.target && e.target.nodeName === "DIALOG" && e.target.classList.contains("zoom")) {
        e.target.close();
      }
    });

    // 4. Arrow keys navigation (ignored when dialog is open or user is typing)
    document.addEventListener("keydown", (e) => {
      const openDialog = document.querySelector("dialog[open]");
      if (openDialog) {
        if (e.key === "Escape") {
          openDialog.close();
        }
        return;
      }

      const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select" || document.activeElement?.isContentEditable) {
        return;
      }

      if (e.key === "ArrowLeft") {
        const prev = document.querySelector('a.prev, a[rel="prev"]');
        if (prev) {
          prev.click();
        }
      } else if (e.key === "ArrowRight") {
        const next = document.querySelector('a.next, a[rel="next"]');
        if (next) {
          next.click();
        }
      }
    });

    // 5. Touch swipe navigation (at least 60 px, |dx| > 1.5 * |dy|, ignored on video, dialog, [data-no-swipe])
    let touchStartX = 0;
    let touchStartY = 0;
    let ignoreSwipe = false;

    document.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) {
        ignoreSwipe = true;
        return;
      }
      const target = e.target;
      if (target.closest("video, dialog, [data-no-swipe]")) {
        ignoreSwipe = true;
        return;
      }
      ignoreSwipe = false;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener("touchend", (e) => {
      if (ignoreSwipe) return;
      if (!e.changedTouches || e.changedTouches.length === 0) return;

      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const dx = touchEndX - touchStartX;
      const dy = touchEndY - touchStartY;

      if (Math.abs(dx) >= 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        if (dx < 0) {
          // Swipe left -> Next
          const next = document.querySelector('a.next, a[rel="next"]');
          if (next) next.click();
        } else {
          // Swipe right -> Prev
          const prev = document.querySelector('a.prev, a[rel="prev"]');
          if (prev) prev.click();
        }
      }
    }, { passive: true });

  } catch (err) {
    // Non-fatal: standard link navigation remains intact
    console.warn("book.js initialization failed:", err);
  }
})();
