/**
 * The walkthrough's inline page behavior: theme cycling, expand/collapse,
 * scrollspy + progress, keyboard navigation, relocating finding cards under
 * their diff lines, deep links with flash highlight, copy buttons, print
 * expansion. Plain inline JS with zero dependencies so
 * the page works from file://; every feature no-ops when its markup is
 * absent, and without JS the page degrades to the static layout.
 */
export const walkthroughScript = `
(function () {
  "use strict";
  var doc = document;
  var root = doc.documentElement;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var scrollBehavior = reduceMotion ? "auto" : "smooth";

  /* ---- theme: auto -> light -> dark, persisted ---- */
  var THEME_STORAGE = "smithers-review-theme";
  var THEMES = ["auto", "light", "dark"];
  var themeBtn = doc.getElementById("theme-toggle");
  function storedTheme() {
    try { var t = localStorage.getItem(THEME_STORAGE); return THEMES.indexOf(t) >= 0 ? t : "auto"; } catch (_) { return "auto"; }
  }
  /* The applied theme, read back from the page. The hosted copy is served
     under "sandbox allow-scripts", so it runs on an opaque origin where
     storedTheme() answers "auto" forever; cycling off it would never reach
     dark. The document always knows what applyTheme last set. */
  function activeTheme() {
    var applied = root.getAttribute("data-theme");
    return THEMES.indexOf(applied) >= 0 ? applied : "auto";
  }
  function applyTheme(theme) {
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    if (themeBtn) {
      var glyph = theme === "light" ? "\\u2600" : theme === "dark" ? "\\u263E" : "\\u25D0";
      themeBtn.textContent = glyph + " " + theme.charAt(0).toUpperCase() + theme.slice(1);
      themeBtn.setAttribute("aria-label", "Theme: " + theme + " (click to change)");
    }
    window.dispatchEvent(new Event("walkthrough-theme"));
  }
  applyTheme(storedTheme());
  if (themeBtn) themeBtn.addEventListener("click", function () {
    var next = THEMES[(THEMES.indexOf(activeTheme()) + 1) % THEMES.length];
    try { localStorage.setItem(THEME_STORAGE, next); } catch (_) {}
    applyTheme(next);
  });

  /* ---- expand / collapse all diffs ---- */
  function setAllDiffs(open) {
    doc.querySelectorAll("article.file details").forEach(function (d) { d.open = open; });
  }
  var expandAll = doc.getElementById("expand-all");
  var collapseAll = doc.getElementById("collapse-all");
  if (expandAll) expandAll.addEventListener("click", function () { setAllDiffs(true); });
  if (collapseAll) collapseAll.addEventListener("click", function () { setAllDiffs(false); });

  /* ---- reading progress (narrow layouts) ---- */
  var progressFill = doc.querySelector(".progress-fill");
  if (progressFill) {
    var progressTick = false;
    var updateProgress = function () {
      progressTick = false;
      var max = doc.documentElement.scrollHeight - window.innerHeight;
      progressFill.style.width = (max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0) + "%";
    };
    window.addEventListener("scroll", function () {
      if (!progressTick) { progressTick = true; requestAnimationFrame(updateProgress); }
    }, { passive: true });
    updateProgress();
  }

  /* ---- scrollspy ---- */
  var tocLinks = {};
  doc.querySelectorAll("nav.toc:not(.toc-mobile) a[href^='#']").forEach(function (a) { tocLinks[a.getAttribute("href").slice(1)] = a; });
  var spyTargets = doc.querySelectorAll("section[id], article.file[id]");
  if (Object.keys(tocLinks).length > 0 && "IntersectionObserver" in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var link = tocLinks[entry.target.id];
        if (!link) return;
        Object.keys(tocLinks).forEach(function (id) { tocLinks[id].classList.remove("active"); tocLinks[id].removeAttribute("aria-current"); });
        link.classList.add("active");
        link.setAttribute("aria-current", "true");
      });
    }, { rootMargin: "-8% 0px -78% 0px" });
    spyTargets.forEach(function (el) { spy.observe(el); });
  }

  /* ---- keyboard: j/k next/prev file, x toggle its diff ---- */
  var fileCards = Array.prototype.slice.call(doc.querySelectorAll("article.file"));
  function currentFile() {
    for (var i = fileCards.length - 1; i >= 0; i -= 1) {
      if (fileCards[i].getBoundingClientRect().top <= 90) return i;
    }
    return -1;
  }
  doc.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var tag = (event.target && event.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (event.target && event.target.isContentEditable)) return;
    if (event["key"] === "j" || event["key"] === "k") {
      var index = currentFile() + (event["key"] === "j" ? 1 : -1);
      if (index >= 0 && index < fileCards.length) {
        fileCards[index].scrollIntoView({ behavior: scrollBehavior, block: "start" });
        event.preventDefault();
      }
    } else if (event["key"] === "x") {
      var current = fileCards[Math.max(0, currentFile())];
      if (current) {
        var details = current.querySelector("details");
        if (details) details.open = !details.open;
        event.preventDefault();
      }
    }
  });

  /* ---- relocate finding cards under their diff lines ---- */
  function pierreRowFor(body, line) {
    var rows = body.querySelectorAll("[data-content] > [data-line]");
    var fallback = null;
    for (var i = 0; i < rows.length; i += 1) {
      if (Number(rows[i].getAttribute("data-line")) !== line) continue;
      if (rows[i].getAttribute("data-line-type") === "change-deletion") { fallback = fallback || rows[i]; continue; }
      return rows[i];
    }
    return fallback;
  }
  function relocate(card) {
    var line = Number(card.getAttribute("data-start-line"));
    if (!line) return;
    var article = card.closest("article.file");
    if (!article) return;
    var body = article.querySelector("details .diff-body");
    if (!body) return;
    var severity = card.getAttribute("data-severity") || "minor";
    var slot = doc.createElement("div");
    slot.className = "finding-slot";
    var row = pierreRowFor(body, line);
    if (row) {
      var content = row.parentElement;
      var gutter = content.previousElementSibling;
      if (!gutter || !gutter.hasAttribute("data-gutter")) return;
      var index = Array.prototype.indexOf.call(content.children, row);
      slot.appendChild(card);
      content.insertBefore(slot, row.nextSibling);
      var marker = doc.createElement("div");
      marker.className = "finding-gutter sev-" + severity;
      gutter.insertBefore(marker, gutter.children[index + 1] || null);
      content.style.gridRow = "span " + content.children.length;
      gutter.style.gridRow = "span " + gutter.children.length;
      card.setAttribute("data-anchored", "true");
      return;
    }
    var tr = body.querySelector('tr[data-new="' + line + '"]') || body.querySelector('tr[data-old="' + line + '"]');
    if (tr) {
      var cardRow = doc.createElement("tr");
      var cell = doc.createElement("td");
      cell.colSpan = tr.children.length;
      cell.className = "finding-cell";
      slot.appendChild(card);
      cell.appendChild(slot);
      cardRow.appendChild(cell);
      tr.parentNode.insertBefore(cardRow, tr.nextSibling);
      card.setAttribute("data-anchored", "true");
    }
  }
  doc.querySelectorAll("aside.finding[data-start-line]").forEach(relocate);

  /* ---- deep links: open the diff, scroll, flash ---- */
  function flash(el) {
    if (!el) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    setTimeout(function () { el.classList.remove("flash"); }, 2100);
  }
  function reveal(target) {
    var details = target.closest("details");
    if (details) details.open = true;
    var article = target.closest("article.file");
    if (article && target.classList.contains("finding")) {
      var articleDetails = article.querySelector("details");
      if (articleDetails) articleDetails.open = true;
    }
    target.scrollIntoView({ behavior: scrollBehavior, block: "center" });
    flash(target);
    var slot = target.parentElement;
    if (slot && slot.classList.contains("finding-slot")) {
      var lineRow = slot.closest("tr") ? slot.closest("tr").previousElementSibling : slot.previousElementSibling;
      flash(lineRow);
    }
  }
  doc.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest("a[data-finding-link], a[data-line-link]");
    if (!link) return;
    var id = (link.getAttribute("href") || "").slice(1);
    var target = id && doc.getElementById(id);
    if (!target) return;
    event.preventDefault();
    reveal(target);
    if (history.pushState) history.pushState(null, "", "#" + id);
  });
  if (location.hash.length > 1) {
    var initial = doc.getElementById(location.hash.slice(1));
    if (initial) setTimeout(function () { reveal(initial); }, 60);
  }

  /* ---- copy buttons ---- */
  var copyResetTimers = new WeakMap();
  function copyText(text, button, label) {
    if (button.disabled) return;
    clearTimeout(copyResetTimers.get(button));
    button.disabled = true;
    function finish(copied) {
      button.disabled = false;
      button.textContent = copied ? "Copied" : "Copy failed";
      copyResetTimers.set(button, setTimeout(function () { button.textContent = label; }, 1400));
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        Promise.resolve(navigator.clipboard.writeText(text)).then(function () { finish(true); }, function () { finish(false); });
      } else {
        var scratch = doc.createElement("textarea");
        scratch.value = text;
        doc.body.appendChild(scratch);
        var copied = false;
        try {
          scratch.select();
          copied = doc.execCommand("copy") === true;
        } finally {
          scratch.remove();
          button.focus();
        }
        finish(copied);
      }
    } catch (_) { finish(false); }
  }
  doc.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-copy]");
    if (!button) return;
    var pre = button.closest("pre");
    var code = pre && pre.querySelector("code");
    if (!code) return;
    copyText(code.textContent, button, "Copy");
  });

  /* ---- print: expand every diff, restore after ---- */
  var printState = null;
  window.addEventListener("beforeprint", function () {
    printState = Array.prototype.map.call(doc.querySelectorAll("article.file details"), function (d) { return d.open; });
    setAllDiffs(true);
  });
  window.addEventListener("afterprint", function () {
    if (!printState) return;
    Array.prototype.forEach.call(doc.querySelectorAll("article.file details"), function (d, i) { d.open = printState[i]; });
    printState = null;
  });

})();
`.trim();
