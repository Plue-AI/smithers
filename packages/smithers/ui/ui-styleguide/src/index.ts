/**
 * The Smithers house stylesheets: Paper tokens in light and dark modes,
 * plus the base element and component rules that consume them.
 *
 * `docs/api.md` and `docs/theming.md` in this package own the prose contract.
 *
 * @since 1.0.0-rc.0
 */
import { reducedMotionCss } from "./standaloneThemeCss.ts";
import { paletteThemeCss, type PaletteThemeCssOptions } from "./paletteThemeCss.ts";

/**
 * Paper light/dark token rules; optional palette keys are validated.
 * Combine with workflowUiPrimitiveCss for shared element and component rules.
 * @throws {RangeError} when palettes names an unregistered key.
 */
export function themeCss(options: PaletteThemeCssOptions = {}): string {
  return paletteThemeCss("'", options).join("\n");
}

/**
 * The element and component rules alone: every line `workflowUiThemeCss` adds
 * on top of `themeCss()`, in cascade order and ending with the reduced-motion
 * guard. Every declaration resolves through a token, so the block themes
 * nothing until a token sheet is composed in front of it.
 *
 * A host that pins one palette joins `themeCss({ palettes })` with this and
 * `workflowUiLayoutCss` rather than slicing the combined sheet. See
 * `docs/guides/pin-a-palette.md`.
 *
 * @since 1.0.0-rc.0
 */
export const workflowUiPrimitiveCss = [
  "* { box-sizing:border-box; }",
  "body { min-width:320px; min-height:100vh; margin:0; background:var(--bg); color:var(--text); font-size:var(--fs-3); line-height:var(--lh-body); font-synthesis:none; text-rendering:optimizeLegibility; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }",
  // No `::selection` rule. The 0.x sheet washed the selection with 24% brand and
  // left the foreground inherited, which puts every one of the nine foregrounds
  // this sheet paints on an unaudited background: measured across the shipped
  // palettes, even an 8% wash misses 4.5:1 in 29 (foreground, palette, mode)
  // combinations. Pinning a foreground instead is worse, because it is a global
  // rule and a downstream sheet that overrides only the selection background
  // inherits it (`@smthrs/ui`'s markdown editor does exactly that). The user
  // agent's own selection colors are contrast-guaranteed, so the sheet leaves
  // them alone.
  "button,input,textarea,select { font:inherit; }",
  "button { color:inherit; cursor:pointer; }",
  "button:disabled { cursor:not-allowed; }",
  "pre { margin:0; max-width:100%; overflow:auto; }",
  "h1,h2,h3,p { margin:0; }",
  "h1 { color:var(--text); font-size:var(--fs-5); font-weight:650; letter-spacing:-0.01em; line-height:var(--lh-tight); }",
  "h2 { color:var(--text); font-size:var(--fs-4); font-weight:650; letter-spacing:-0.005em; line-height:var(--lh-tight); }",
  "h3 { color:var(--text); font-size:var(--fs-3); font-weight:650; line-height:var(--lh-tight); }",
  "p { color:var(--muted); line-height:1.45; }",
  "code,.mono { font-family:var(--font-mono); }",
  ".muted,.meta { color:var(--muted); }",
  ".top,.topbar { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:var(--sp-4); padding:var(--sp-3) 18px; border-bottom:1px solid var(--border); background:var(--surface-glass-strong); -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%); }",
  ".title,.title-group { min-width:0; display:flex; align-items:center; gap:10px; }",
  ".toolbar,.actions { display:flex; align-items:center; justify-content:flex-end; gap:var(--sp-2); min-width:0; flex-wrap:wrap; }",
  // `.danger` is a control shape like `.primary` and `.secondary`, so it rides
  // the same base, focus, and disabled rules. It used to appear only in its own
  // tint and state rules, which left a bare `<button class="danger">` with no
  // fill, no border, no focus ring, and no disabled dimming while the identical
  // `.primary` markup had all four.
  ".button,.primary,.secondary,.danger { min-height:var(--ctl-h); display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:0 var(--sp-3); border:1px solid var(--line); border-radius:var(--r-1); background:var(--panel); color:var(--text); text-decoration:none; cursor:pointer; white-space:nowrap; box-shadow:var(--shadow-1); transition:background-color .12s ease, border-color .12s ease, color .12s ease; }",
  ".button:hover,.primary:hover,.secondary:hover { background:var(--hover); }",
  ".button:active:not(:disabled),.primary:active:not(:disabled),.secondary:active:not(:disabled) { background:color-mix(in srgb, var(--text) 6%, var(--hover)); }",
  ".button:focus-visible,.primary:focus-visible,.secondary:focus-visible,.danger:focus-visible,.icon-button:focus-visible,.tab:focus-visible,.run-row:focus-visible,.doc-link:focus-visible,.segmented:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible { outline:none; border-color:var(--ring-border); box-shadow:0 0 0 3px var(--ring); }",
  ".button:disabled,.primary:disabled,.secondary:disabled,.danger:disabled { cursor:not-allowed; opacity:.45; }",
  ".button.primary,.primary { border-color:var(--brand-border); background:var(--brand-soft); color:var(--brand); font-weight:650; }",
  // Hover and press on a tinted button move the border and the elevation, never
  // the fill: the fill already carries brand-colored 13px text at the audited
  // 10% tint, and every deeper tint drops that pair below WCAG AA in most
  // palettes. `tests/themeRegistry.test.ts` enumerates the pairs this sheet
  // paints, so a fill added here has to clear 4.5:1 to land.
  //
  // Each state still restates its own `background`. The generic `.button:hover`
  // and `.button:active` rules above match `.primary`/`.danger` too and are
  // (0,2,0)/(0,3,0), so without an explicit fill here the neutral hover and
  // active fills would win over the (0,2,0) base rule and paint brand text on
  // an unaudited neutral surface. `tests/index.test.ts` pins the resolution.
  ".button.primary:hover,.primary:hover { background:var(--brand-soft); border-color:var(--brand-border-strong); box-shadow:var(--shadow-2); }",
  ".button.primary:active:not(:disabled),.primary:active:not(:disabled) { background:var(--brand-soft); border-color:var(--brand-border-strong); box-shadow:inset 0 1px 2px rgb(var(--shadow-rgb) / 0.20); }",
  ".button.danger,.danger { border-color:var(--danger-border); color:var(--danger); }",
  ".button.danger:hover,.danger:hover { background:var(--danger-soft); }",
  ".button.danger:active:not(:disabled),.danger:active:not(:disabled) { background:var(--danger-soft); border-color:var(--danger-border-strong); box-shadow:inset 0 1px 2px rgb(var(--shadow-rgb) / 0.20); }",
  // Compose the keyboard ring with elevation so hover and press cannot erase it.
  ".button.primary:hover:focus-visible,.primary:hover:focus-visible { box-shadow:0 0 0 3px var(--ring), var(--shadow-2); }",
  ".button.primary:active:not(:disabled):focus-visible,.primary:active:not(:disabled):focus-visible,.button.danger:active:not(:disabled):focus-visible,.danger:active:not(:disabled):focus-visible { box-shadow:0 0 0 3px var(--ring), inset 0 1px 2px rgb(var(--shadow-rgb) / 0.20); }",
  ".input,.textarea,.prompt,textarea.prompt,input[type='text'],input[type='search'],input[type='number'],select { min-width:0; border:1px solid var(--line); border-radius:var(--r-1); background:var(--panel); color:var(--text); outline:none; }",
  ".input,.prompt,input[type='text'],input[type='search'],input[type='number'],select { min-height:var(--ctl-h); padding:0 10px; }",
  ".textarea,textarea.prompt,textarea.input,textarea { padding:10px var(--sp-3); min-height:88px; resize:vertical; line-height:1.45; }",
  ".input::placeholder,.textarea::placeholder,.prompt::placeholder,textarea::placeholder,input::placeholder { color:var(--text-placeholder); }",
  ".pill,.badge,.chip { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; min-height:22px; padding:0 10px; border:1px solid var(--border); border-radius:var(--r-full); color:var(--text-muted); font-family:var(--font-mono); font-size:var(--fs-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
  ".pill { border-color:var(--brand-border); background:var(--brand-soft); color:var(--brand); }",
  ".pill.muted,.badge.muted,.chip { border-color:var(--border); background:var(--surface-2); color:var(--text-muted); }",
  ".badge { font-family:inherit; font-weight:650; text-transform:uppercase; }",
  ".badge.ok,.badge.finished,.badge.success { color:var(--success); border-color:var(--success-border); background:var(--success-soft); }",
  ".badge.warn,.badge.waiting { color:var(--warning); border-color:var(--warning-border); background:var(--warning-soft); }",
  ".badge.running,.badge.run { color:var(--brand); border-color:var(--brand-border); background:var(--brand-soft); }",
  ".badge.info { color:var(--info); border-color:var(--info-border); background:var(--info-soft); }",
  ".badge.bad,.badge.failed { color:var(--danger); border-color:var(--danger-border); background:var(--danger-soft); }",
  // Neutral outcomes and not-started states are muted, matching the shared
  // status vocabulary in @smthrs/ui (a user cancel is not a
  // failure; pending/queued work has not started).
  ".badge.cancelled,.badge.canceled,.badge.skipped,.badge.pending,.badge.queued { color:var(--muted); border-color:var(--border); background:var(--surface-2); }",
  ".card,.panel,.kpi,.stat,.slot { min-width:0; border:1px solid var(--border); border-radius:var(--r-2); background:var(--surface); box-shadow:var(--shadow-2); }",
  ".card,.panel,.slot { padding:14px; }",
  ".card-head,.panel-title,.section-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".section-head,.label,.field label,.field span { color:var(--muted); font-size:var(--fs-1); font-weight:650; text-transform:uppercase; letter-spacing:.05em; }",
  ".field { min-width:0; display:grid; gap:6px; }",
  ".empty { padding:var(--sp-6); color:var(--muted); text-align:center; }",
  ".alert { border:1px solid var(--border); border-radius:var(--r-2); padding:var(--sp-3); background:var(--surface); color:var(--muted); }",
  ".alert.err,.error-text { color:var(--danger); border-color:var(--danger-border); }",
  ".run-row { border-color:var(--border); color:var(--text); transition:border-color .12s ease, background .12s ease; }",
  ".run-row:hover,.run-row.active,.run-row.is-active { background:var(--hover); }",
  ".run-row.active,.run-row.is-active { border-color:var(--brand-border); box-shadow:inset 2px 0 0 var(--brand); }",
  ".table { width:100%; border-collapse:collapse; }",
  ".table th,.table td { padding:var(--sp-2) 10px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }",
  ".table th { color:var(--muted); font-size:var(--fs-1); text-transform:uppercase; letter-spacing:.04em; font-weight:650; }",
  ".code,.source,pre.code { display:block; min-width:0; overflow:auto; white-space:pre-wrap; font-family:var(--font-mono); font-size:var(--fs-1); line-height:1.55; color:var(--code-text); background:var(--code-bg); border:1px solid var(--border); border-radius:var(--r-2); padding:10px; }",
  ".plus { color:var(--success); } .minus { color:var(--danger); }",
  ".livelog { overflow:auto; background:var(--code-bg); color:var(--code-text); border:1px solid var(--border); border-radius:var(--r-2); padding:var(--sp-2); font-family:var(--font-mono); font-size:var(--fs-1); line-height:1.55; }",
  ".livelog-line { display:flex; gap:var(--sp-2); padding:2px 0; white-space:pre-wrap; word-break:break-word; }",
  ".livelog-event { color:var(--brand); flex:none; }",
  ".livelog-node { color:var(--warning); flex:none; }",
  ".livelog-detail { color:var(--code-text); min-width:0; }",
  "* { scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--text-muted) 35%,transparent) transparent; }",
  "@media (max-width: 760px) { .top,.topbar { align-items:flex-start; flex-direction:column; padding:10px var(--sp-3); } .toolbar,.actions { width:100%; justify-content:flex-start; } .button,.primary,.secondary,.danger { min-width:0; } }",
  reducedMotionCss,
].join("\n");

export const workflowUiThemeCss = [themeCss(), workflowUiPrimitiveCss].join("\n");

export const workflowUiLayoutCss = [
  ".workflow-shell { height:100vh; width:100%; max-width:100vw; overflow:hidden; display:grid; grid-template-rows:auto 1fr; background:var(--bg); color:var(--text); }",
  ".workflow-content { min-width:0; min-height:0; overflow:auto; padding:var(--sp-4) 18px; display:grid; align-content:start; gap:14px; }",
  ".workflow-launch { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--sp-2); align-items:start; }",
  ".workflow-dashboard { min-width:0; min-height:0; display:grid; grid-template-columns:minmax(240px,320px) minmax(0,1fr); gap:14px; align-items:start; }",
  ".workflow-runs { display:grid; align-content:start; gap:var(--sp-2); }",
  ".workflow-run-row { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:var(--sp-3); width:100%; padding:10px var(--sp-3); border:1px solid var(--border); border-radius:var(--r-2); background:var(--surface); color:var(--text); text-align:left; cursor:pointer; box-shadow:var(--shadow-1); }",
  ".workflow-run-row:hover,.workflow-run-row.active { background:var(--hover); border-color:var(--brand-border); }",
  ".workflow-run-row.active { box-shadow:inset 2px 0 0 var(--brand), var(--shadow-1); }",
  ".workflow-run-main { min-width:0; display:grid; gap:var(--sp-1); }",
  ".workflow-run-id { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono); font-size:var(--fs-2); }",
  ".workflow-run-meta { color:var(--muted); font-size:var(--fs-1); }",
  ".workflow-detail { min-width:0; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }",
  ".workflow-detail .panel { display:grid; gap:10px; }",
  ".workflow-tree,.workflow-events { min-height:220px; max-height:52vh; }",
  "@media (max-width: 980px) { .workflow-dashboard,.workflow-detail { grid-template-columns:1fr; } .workflow-tree,.workflow-events { max-height:360px; } }",
  "@media (max-width: 620px) { .workflow-content { padding:var(--sp-3); } .workflow-launch { grid-template-columns:1fr; } .workflow-launch .button { width:100%; } }",
].join("\n");

export const workflowUiStyles = [workflowUiThemeCss, workflowUiLayoutCss].join("\n");
export { reducedMotionCss, standaloneThemeCss } from "./standaloneThemeCss.ts";
export { DEFAULT_THEME_KEY, findTheme, themeRegistry } from "./themeRegistry.ts";
export type { ThemeKey } from "./themeRegistry.ts";
export { serializeThemeVariant } from "./serializeThemeVariant.ts";
export type { SerializeThemeVariantOptions } from "./serializeThemeVariant.ts";
export { contrastRatio, contrastRatioOf, type Rgb } from "./contrastRatio.ts";
export { mixChannels, mixColors } from "./mixColors.ts";
export { SOFT_TINT_AMOUNT, STRONG_TINT_AMOUNT } from "./themeTokens.ts";
export type { PaletteThemeCssOptions } from "./paletteThemeCss.ts";
export type { DeepReadonly } from "./themeRegistry.ts";
export type { SmithersTheme } from "./SmithersTheme.ts";
export type { TerminalPalette } from "./TerminalPalette.ts";
export type { ThemeSyntaxId } from "./ThemeSyntaxId.ts";
export type { ThemeVariantTokens } from "./ThemeVariantTokens.ts";
