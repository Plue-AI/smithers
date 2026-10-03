import { standaloneThemeCss } from "@smthrs/ui-styleguide"

/**
 * The walkthrough design system composes the standalone shared theme with
 * walkthrough-specific layout for the sticky
 * TOC / progress-bar navigation. Page code/pre rules are guarded with
 * :not(.pierre-diff *) so they never reach into embedded Pierre diffs;
 * walkthroughRestoreCss below re-asserts the page defaults Pierre's global
 * resets are known to leak onto (code/pre display, margin, padding, and the
 * universal box-sizing rule) and is emitted AFTER the Pierre styles.
 */
export const walkthroughCss = `${standaloneThemeCss()}
:root { --faint:var(--text-faint); --accent-soft:var(--brand-soft); --add:var(--success); --del:var(--danger); --sev-critical:var(--danger); --sev-major:var(--warning); --sev-minor:var(--warning); --sev-info:var(--info); --shadow-card:var(--shadow-2); --sans:var(--font-sans); --mono:var(--font-mono); --radius:12px; }
html { -webkit-text-size-adjust: 100%; }
body { font: 15px/1.65 var(--sans); }
[id] { scroll-margin-top: 56px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code:not(.pierre-diff *), pre:not(.pierre-diff *), .plain-diff { font-family: var(--mono); }
button { font-family: var(--sans); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---- shell: progress bar, sidebar TOC, content column ---- */
.progress { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 40; background: transparent; pointer-events: none; }
.progress-fill { height: 100%; width: 0; background: var(--accent); transition: width 80ms linear; }
.layout { max-width: 1200px; margin: 0 auto; padding: 28px 20px 96px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 32px; }
main { min-width: 0; max-width: 900px; margin: 0 auto; width: 100%; }
nav.toc { display: none; }
@media (min-width: 1200px) {
  .progress { display: none; }
  .layout { grid-template-columns: 236px minmax(0, 1fr); padding-top: 36px; }
  main { margin: 0; }
  nav.toc { display: block; position: sticky; top: 24px; align-self: start; max-height: calc(100vh - 48px); overflow-y: auto; font-size: var(--fs-2); padding-right: 12px; scrollbar-width: thin; }
}
nav.toc .toc-title { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin: 18px 0 6px; }
nav.toc a { display: block; color: var(--muted); padding: 3px 10px; border-left: 2px solid var(--border); border-radius: 0 6px 6px 0; line-height: 1.45; }
nav.toc a:hover { color: var(--text); text-decoration: none; background: var(--surface-2); }
nav.toc a.active { color: var(--accent); border-left-color: var(--accent); background: var(--accent-soft); }
nav.toc a.toc-file { padding-left: 22px; font-family: var(--mono); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
nav.toc .toc-count { color: var(--faint); font-family: var(--sans); }
nav.toc a.toc-file { display: flex; }
nav.toc a.toc-file .toc-dir { color: var(--faint); flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; unicode-bidi: isolate; }
nav.toc a.toc-more { color: var(--faint); font-family: var(--sans); font-style: italic; }
.mobile-toc { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-card); padding: 10px 16px; margin-bottom: 24px; }
.mobile-toc > summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--muted); user-select: none; }
.mobile-toc nav.toc { display: block; position: static; max-height: none; font-size: var(--fs-2); padding: 4px 0 8px; }
@media (min-width: 1200px) { .mobile-toc { display: none; } }

/* ---- header ---- */
header.page { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-card); padding: 26px 30px 22px; margin-bottom: 24px; }
.masthead { display: flex; align-items: flex-start; gap: 16px; }
.masthead > div { min-width: 0; flex: 1; }
header.page h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.2; font-weight: 650; letter-spacing: -0.015em; font-variant-numeric: tabular-nums; }
header.page .synopsis { margin: 0; color: var(--muted); max-width: 72ch; font-size: 15px; }
.theme-toggle { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-2); color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 5px 11px; cursor: pointer; }
.theme-toggle:hover { background: var(--surface-2); color: var(--text); }
.overview-chart { width: 100%; max-width: 560px; margin: 20px 0 4px; display: grid; gap: 9px; }
.chart-key { display: flex; align-items: center; gap: 6px; justify-content: flex-end; font-size: 11px; color: var(--muted); }
.chart-key .key-swatch { width: 8px; height: 8px; border-radius: 2px; }
.chart-key .chart-del { margin-left: 8px; }
.chart-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: baseline; }
.chart-label { font-size: 12px; font-weight: 500; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chart-files { color: var(--faint); font-weight: 400; }
.chart-count { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.chart-track { grid-column: 1 / -1; height: 7px; border-radius: 2px; background: var(--surface-3); display: flex; overflow: hidden; }
.chart-add { background: var(--add); border-radius: 2px; flex: none; }
.chart-del { background: var(--del); border-radius: 2px; flex: none; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 1.5; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 2px 11px; color: var(--muted); max-width: 100%; font-variant-numeric: tabular-nums; }
.chip strong { color: var(--text); font-weight: 600; }
.chip code { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.add strong { color: var(--add); }
.chip.del strong { color: var(--del); }
.chip .sev-count { font-weight: 600; }
.chip .sev-count.sev-critical { color: var(--sev-critical); }
.chip .sev-count.sev-major { color: var(--sev-major); }
.chip .sev-count.sev-minor { color: var(--sev-minor); }
.chip .sev-count.sev-info { color: var(--sev-info); }
.controls { margin-left: auto; display: flex; gap: 8px; }
.controls button { font-size: 12px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 4px 11px; cursor: pointer; color: var(--muted); }
.controls button:hover { background: var(--surface-2); color: var(--text); }

/* ---- shared panels / chapters ---- */
section.panel, section.chapter { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-card); padding: 22px 30px; margin-bottom: 24px; }
section.review-outcome { border-left: 4px solid var(--warning); }
section.review-outcome[data-review-status="failed"] { border-left-color: var(--danger); }
section.review-outcome[data-review-status="success"] { border-left-color: var(--success); }
section.panel h2, section.chapter > h2 { margin: 0 0 14px; font-size: 21px; font-weight: 650; letter-spacing: -0.01em; }
section.chapter > h2 .num { color: var(--faint); font-weight: 500; font-size: 13px; letter-spacing: .05em; margin-right: 10px; font-variant-numeric: tabular-nums; vertical-align: 3px; }
.anchor-link { color: var(--faint); font-weight: 400; margin-left: 8px; opacity: 0; transition: opacity 120ms; }
h2:hover .anchor-link, .file-head:hover .anchor-link, .anchor-link:focus-visible { opacity: 1; }
.count-pill { display: inline-block; font-size: 12px; font-weight: 600; color: var(--muted); background: var(--surface-3); border-radius: 999px; padding: 1px 9px; margin-left: 8px; vertical-align: 2px; }
.toc-panel ol { margin: 0; padding-left: 26px; }
.toc-panel li { margin: 5px 0; }
.toc-panel .stat { margin-left: 6px; }

/* ---- empty state ---- */
.empty-state { text-align: center; padding: 40px 20px 44px; }
.empty-state .empty-glyph { font-size: 30px; margin-bottom: 8px; }
.empty-state h2 { margin: 0 0 6px; }
.empty-state p { margin: 0 auto; color: var(--muted); max-width: 48ch; }

/* ---- findings index ---- */
.sev-group { margin: 14px 0 0; }
.sev-group h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 12px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; }
.sev-group h3 .dot { width: 8px; height: 8px; border-radius: 999px; flex: none; }
.sev-group ol { list-style: none; margin: 0; padding: 0; }
.sev-group li { margin: 0; padding: 7px 10px 7px 14px; border-left: 2px solid var(--border); }
.sev-group li + li { border-top: 1px solid var(--border); }
.sev-group.sev-critical h3 { color: var(--sev-critical); }
.sev-group.sev-critical .dot { background: var(--sev-critical); }
.sev-group.sev-major h3 { color: var(--sev-major); }
.sev-group.sev-major .dot { background: var(--sev-major); }
.sev-group.sev-minor h3 { color: var(--sev-minor); }
.sev-group.sev-minor .dot { background: var(--sev-minor); }
.sev-group.sev-info h3 { color: var(--sev-info); }
.sev-group.sev-info .dot { background: var(--sev-info); }
.sev-group.sev-critical li { border-left-color: var(--sev-critical); }
.sev-group.sev-major li { border-left-color: var(--sev-major); }
.sev-group.sev-minor li { border-left-color: var(--sev-minor); }
.sev-group.sev-info li { border-left-color: var(--sev-info); }
.finding-link code { font-size: var(--fs-2); }
.finding-link .loc { color: var(--muted); font-size: 12px; }
.finding-summary { display: block; color: var(--muted); font-size: 13.5px; margin-top: 1px; }

/* ---- prose ---- */
.prose { max-width: 74ch; font-size: 15px; }
.prose p { margin: 12px 0; }
.prose h3, .prose h4, .prose h5, .prose h6 { margin: 22px 0 8px; letter-spacing: -0.01em; }
.prose ul, .prose ol { margin: 8px 0; padding-left: 26px; }
.prose li { margin: 3px 0; }
.prose blockquote { margin: 12px 0; padding: 4px 16px; border-left: 3px solid var(--border-strong); color: var(--muted); }
.prose pre.prose-code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: var(--fs-2); line-height: 1.55; }
.prose code:not(.pierre-diff *) { display: inline; background: var(--surface-3); border-radius: 4px; padding: 1px 5px; margin: 0; font-size: .88em; overflow-wrap: break-word; }
.prose pre.prose-code code:not(.pierre-diff *) { display: inline; background: none; padding: 0; font-size: inherit; }

/* ---- diagrams ---- */
figure.diagram { margin: 20px 0; padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); text-align: center; max-height: 560px; overflow: auto; }
figure.diagram figcaption { margin-top: 10px; font-size: 13px; color: var(--muted); }
figure.diagram pre.mermaid { text-align: left; margin: 0; display: flex; justify-content: center; overflow-x: auto; font-size: var(--fs-2); }
figure.diagram .diagram-note { font-size: 13px; color: var(--muted); margin: 8px 0; }

/* ---- file cards ---- */
article.file { border: 1px solid var(--border); border-radius: 10px; margin: 20px 0; overflow: clip; background: var(--surface); }
article.file .file-head { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 9px 14px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
article.file .file-head .path { font-family: var(--mono); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; color: var(--text); }
article.file .file-head .path .rename-arrow { color: var(--faint); font-weight: 400; margin: 0 4px; }
article.file .file-head .path .old-path { color: var(--muted); font-weight: 400; text-decoration: line-through; text-decoration-color: var(--faint); }
.badge { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 1px 9px; border: 1px solid transparent; text-transform: uppercase; letter-spacing: .05em; flex: none; }
.badge.added { background: color-mix(in srgb, var(--add) 13%, transparent); color: var(--add); border-color: color-mix(in srgb, var(--add) 32%, transparent); }
.badge.deleted { background: color-mix(in srgb, var(--del) 11%, transparent); color: var(--del); border-color: color-mix(in srgb, var(--del) 32%, transparent); }
.badge.modified { background: color-mix(in srgb, var(--accent) 11%, transparent); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
.badge.renamed, .badge.binary { background: var(--surface-3); color: var(--muted); border-color: var(--border-strong); }
.badge.plain-render { background: var(--surface-3); color: var(--muted); border-color: var(--border-strong); text-transform: none; letter-spacing: 0; font-weight: 500; }
.stat { font-size: var(--fs-2); color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.stat .plus { color: var(--add); font-weight: 600; }
.stat .minus { color: var(--del); font-weight: 600; }
.not-reviewed { font-size: 11.5px; color: var(--faint); margin-left: auto; white-space: nowrap; }
article.file .intro { margin: 12px 14px; color: var(--text); font-size: 14px; max-width: 78ch; }
article.file details { border-top: 1px solid var(--border); }
article.file details summary { cursor: pointer; padding: 8px 14px; font-size: var(--fs-2); color: var(--muted); user-select: none; list-style: none; }
article.file details summary::-webkit-details-marker { display: none; }
article.file details summary::before { content: "\u25B8"; display: inline-block; margin-right: 7px; color: var(--faint); transition: transform 120ms ease; }
article.file details[open] > summary::before { transform: rotate(90deg); }
article.file details summary:hover { background: var(--surface-2); color: var(--text); }
article.file .pierre-diff pre[data-diff] { margin: 0; border-radius: 0; }
.plain-diff { overflow-x: auto; }

/* ---- finding cards ---- */
aside.finding { margin: 12px 14px; border: 1px solid var(--border); border-left: 3px solid var(--sev-minor); background: var(--surface); border-radius: 8px; padding: 10px 14px 12px; box-shadow: var(--shadow-card); font-family: var(--sans); font-size: 14px; line-height: 1.6; white-space: normal; }
aside.finding.sev-critical { border-left-color: var(--sev-critical); }
aside.finding.sev-major { border-left-color: var(--sev-major); }
aside.finding.sev-minor { border-left-color: var(--sev-minor); }
aside.finding.sev-info { border-left-color: var(--sev-info); }
.finding-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 4px; }
.sev-chip { font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; border-radius: 999px; padding: 1px 9px; }
.sev-chip.sev-critical { color: var(--sev-critical); background: color-mix(in srgb, var(--sev-critical) 12%, transparent); }
.sev-chip.sev-major { color: var(--sev-major); background: color-mix(in srgb, var(--sev-major) 12%, transparent); }
.sev-chip.sev-minor { color: var(--sev-minor); background: color-mix(in srgb, var(--sev-minor) 13%, transparent); }
.sev-chip.sev-info { color: var(--sev-info); background: color-mix(in srgb, var(--sev-info) 13%, transparent); }
.cat-chip { font-size: 11px; color: var(--muted); background: var(--surface-3); border-radius: 999px; padding: 1px 9px; }
.conf-tag { font-size: 11px; color: var(--faint); font-style: italic; }
.finding-loc { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
a.finding-loc:hover { color: var(--accent); }
aside.finding .finding-body p { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
aside.finding .code-label { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); margin-top: 10px; }
aside.finding pre { position: relative; margin: 4px 0 2px; padding: 9px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.55; }
aside.finding pre.suggested { border-color: color-mix(in srgb, var(--add) 30%, var(--border)); }
.copy-btn { position: absolute; top: 6px; right: 6px; font-size: 11px; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; cursor: pointer; opacity: 0; transition: opacity 120ms; }
aside.finding pre:hover .copy-btn, .copy-btn:focus-visible { opacity: 1; }
.copy-btn:hover { color: var(--text); background: var(--surface-2); }

/* findings relocated into the diff grid */
.finding-slot { white-space: normal; padding: 4px 10px; background: var(--surface-2); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.finding-slot aside.finding { margin: 6px 2px; max-width: 860px; }
.finding-gutter { background: var(--surface-2); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); position: relative; }
.finding-gutter::before { content: ""; position: absolute; inset: 8px auto auto 50%; transform: translateX(-50%); width: 8px; height: 8px; border-radius: 999px; background: var(--sev-minor); }
.finding-gutter.sev-critical::before { background: var(--sev-critical); }
.finding-gutter.sev-major::before { background: var(--sev-major); }
.finding-gutter.sev-info::before { background: var(--sev-info); }
td.finding-cell { padding: 0 !important; }

/* deep-link flash */
@keyframes walkthrough-flash { 0%, 60% { background-color: color-mix(in srgb, var(--accent) 16%, transparent); } 100% { background-color: transparent; } }
.flash { animation: walkthrough-flash 2s ease-out; }

/* ---- fallback (plain) diff ---- */
.diff { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 1.55; font-family: var(--mono); }
.diff td { padding: 0 8px; vertical-align: top; }
.diff td.ln { width: 1%; min-width: 40px; text-align: right; color: var(--faint); user-select: none; border-right: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.diff td.sign { width: 1%; padding: 0 2px 0 6px; text-align: center; user-select: none; color: var(--faint); }
.diff tr.add td.sign { color: var(--add); font-weight: 600; }
.diff tr.del td.sign { color: var(--del); font-weight: 600; }
.diff tr.add td:first-child { box-shadow: inset 2px 0 0 var(--add); }
.diff tr.del td:first-child { box-shadow: inset 2px 0 0 var(--del); }
.diff td.code { white-space: pre; }
.diff tr.add { background: color-mix(in srgb, var(--add) 9%, transparent); }
.diff tr.add td.ln { background: color-mix(in srgb, var(--add) 15%, transparent); }
.diff tr.del { background: color-mix(in srgb, var(--del) 8%, transparent); }
.diff tr.del td.ln { background: color-mix(in srgb, var(--del) 13%, transparent); }
.diff tr.hunk { background: var(--surface-3); color: var(--muted); }
.diff tr.hunk td.code { padding: 4px 8px; white-space: pre-wrap; }
.diff-note { color: var(--muted); font-size: 13px; padding: 10px 14px; margin: 0; font-family: var(--sans); }

@media (max-width: 720px) {
  .layout { padding: 16px 12px 72px; }
  header.page { padding: 18px 16px 16px; }
  header.page h1 { font-size: 21px; }
  section.panel, section.chapter { padding: 16px; }
  article.file .intro, aside.finding { margin-left: 10px; margin-right: 10px; }
  .controls { margin-left: 0; flex-basis: 100%; }
  .not-reviewed { margin-left: 0; flex-basis: 100%; }
}

@media print {
  html { color-scheme: light; }
  body { background: var(--surface); color: var(--text); }
  .layout { display: block; padding: 0; max-width: none; }
  main { max-width: none; }
  header.page, section.panel, section.chapter, article.file, aside.finding { box-shadow: none; border-color: var(--border-strong); break-inside: avoid-page; }
  section.chapter { break-before: page; break-inside: auto; }
  article.file { break-inside: auto; }
  article.file .file-head { position: static; }
  article.file details summary { display: none; }
  .dot, .sev-chip, .finding-gutter::before, .chart-add, .chart-del { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  a { color: inherit; }
}
`.trim()

/**
 * Emitted after the Pierre stylesheets: unlayered restores for the resets
 * Pierre is known to apply globally (`pre, code` display/margin/padding and
 * the universal box-sizing rule), so page prose and code render identically
 * whether or not a Pierre diff is on the page. This layer also overrides
 * Pierre's own `color-scheme: light dark`: otherwise it follows the OS and
 * ignores an explicit walkthrough data-theme. :where() keeps the reset
 * guard's specificity at the element level so page component rules still win.
 */
export const walkthroughRestoreCss = `
.pierre-diff { color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .pierre-diff { color-scheme: dark; } }
:root[data-theme="dark"] .pierre-diff { color-scheme: dark; }
.pierre-diff { color-scheme: inherit; }
*:not(:where(.pierre-diff, .pierre-diff *)), *:not(:where(.pierre-diff, .pierre-diff *))::before, *:not(:where(.pierre-diff, .pierre-diff *))::after { box-sizing: border-box; }
code:not(:where(.pierre-diff *)), pre:not(:where(.pierre-diff *)) { display: revert; margin: revert; padding: revert; }
code:not(:where(.pierre-diff *)) { display: inline; }
`.trim()
