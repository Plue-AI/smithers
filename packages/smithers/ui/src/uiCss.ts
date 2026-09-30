/**
 * The complete stylesheet for @smthrs/ui, as a plain string.
 *
 * CSS travels as a JS string (never an `import "./x.css"`) because the gateway
 * UI bundler keeps only the JS output of `Bun.build` and silently drops CSS
 * artifacts. Consumers render {@link file://./styles.tsx SmithersUiStyles} once,
 * and every component also self-injects this sheet idempotently in the browser
 * via `useInjectUiCss`, so a forgotten style tag still renders styled output.
 *
 * Rules:
 * - Every class is namespaced `sui-` so nothing can collide with the
 *   ui-styleguide page vocabulary (`.button`, `.badge`, `.card`, ...) or with
 *   consumer CSS.
 * - Every color resolves through the {@link file://./tokens.ts tokens} bridge:
 *   `var(--house-token, #lightFallback)` chains, tints only via
 *   `color-mix(in srgb, token N%, transparent)`. No raw hex outside fallback
 *   position, no `rgba(255,255,255,...)`-style theme leaks, no `:root` token
 *   emission. Enforced by tests/css-contract.test.ts.
 * - All rules are document-global (never scoped under a shell class) so Radix
 *   portal content mounted on `document.body` stays styled.
 * - Exact metrics are lifted from `workflowUiThemeCss` (32px controls, 6px
 *   control radius, 10px card radius, 22px badges, 13px body, tinted primary)
 *   so components are pixel-compatible with the legacy class vocabulary.
 * - Geometry stays on the documented scales (enforced by
 *   tests/css-contract.test.ts): font sizes from the --fs steps (plus 10px
 *   micro-labels, 16px iOS-zoom-proof composer inputs, 18px icon glyphs),
 *   radii from --r-1/--r-2/--r-bubble (plus 2px caret, 4px micro chips,
 *   999px pills), padding/gap on a 2px grid, and font weights 400/500/650
 *   with 700 reserved for KPI numerals.
 */
import { tokens as t } from "./tokens";
import { statusColors } from "./status";
import { conversationFoundationCss } from "./chat/conversationFoundationCss";
import { promptAttachmentsCss } from "./prompt/promptAttachmentsCss";
import { reasoningToolsCss } from "./agentic/reasoningToolsCss";
import { plansTasksQueuesCss } from "./agentic/plansTasksQueuesCss";
import { approvalsCss } from "./approvals/approvalsCss";
import { sourcesCitationsCss } from "./agentic/sourcesCitationsCss";
import { agentsCss } from "./agents/agentsCss";
import { artifactsCss } from "./artifacts/artifactsCss";
import { sandboxCss } from "./sandbox/sandboxCss";
import { canvasCss } from "./canvas/canvasCss";
import { calendarCss } from "./calendar/calendarCss";
import { vaultCss } from "./vault/vaultCss";

const shadowCard = t.shadow2;
const shadowOverlay = t.shadow3;
const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;
/** The one house interaction speed for background/border/color feedback. */
const interaction = "transition:background-color .12s ease, border-color .12s ease, color .12s ease;";

/** Standalone component hosts need the same global policy as the styleguide. */
export const reducedMotionCss = `@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-delay:0ms !important; animation-duration:0.001ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important; transition-delay:0ms !important; transition-duration:0.001ms !important; }
}`;

/**
 * Utilities every sheet may reference, defined exactly once: the visually
 * hidden helper and the text-shimmer keyframes. Composed first so no sheet
 * needs (or is allowed) its own copy.
 */
export const sharedCss = `
.sui-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
@keyframes sui-shimmer-sweep { from { background-position:200% 0; } to { background-position:-200% 0; } }
`;

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

// Brand text is only audited on the 10% tint (SOFT_TINT_AMOUNT); a stronger
// fill drops it below 4.5:1 in most palettes, so the default variant's hover
// and press keep the fill and show state through the border and an inset
// shadow, as the styleguide's primary button does.
export const buttonCss = `
.sui-button { min-height:${t.controlHeight}; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:0 12px; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:13px; text-decoration:none; cursor:pointer; white-space:nowrap; user-select:none; ${interaction} }
.sui-button:hover { background:${t.secondary}; }
.sui-button:active:not(:disabled) { background:color-mix(in srgb, ${t.foreground} 6%, ${t.secondary}); }
.sui-button:focus-visible { ${focusRing} }
.sui-button:disabled, .sui-button[aria-disabled='true'] { cursor:not-allowed; opacity:.45; }
.sui-button svg { flex:none; }
.sui-button-default { border-color:color-mix(in srgb, ${t.primary} 40%, transparent); background:color-mix(in srgb, ${t.primary} 10%, ${t.card}); color:${t.primary}; font-weight:650; }
.sui-button-default:hover { background:color-mix(in srgb, ${t.primary} 10%, ${t.card}); border-color:color-mix(in srgb, ${t.primary} 65%, transparent); }
.sui-button-default:active:not(:disabled) { background:color-mix(in srgb, ${t.primary} 10%, ${t.card}); border-color:color-mix(in srgb, ${t.primary} 65%, transparent); box-shadow:inset 0 1px 2px color-mix(in srgb, ${t.foreground} 20%, transparent); }
.sui-button-default:active:not(:disabled):focus-visible { box-shadow:0 0 0 3px ${t.ring}, inset 0 1px 2px color-mix(in srgb, ${t.foreground} 20%, transparent); }
.sui-button-solid { border-color:${t.primary}; background:${t.primary}; color:${t.primaryForeground}; font-weight:650; }
.sui-button-solid:hover { background:color-mix(in srgb, ${t.primary} 88%, ${t.foreground}); }
.sui-button-solid:active:not(:disabled) { background:color-mix(in srgb, ${t.primary} 80%, ${t.foreground}); }
.sui-button-secondary { border-color:transparent; background:${t.secondary}; color:${t.foreground}; }
.sui-button-secondary:hover { background:color-mix(in srgb, ${t.foreground} 6%, ${t.secondary}); }
.sui-button-secondary:active:not(:disabled) { background:color-mix(in srgb, ${t.foreground} 10%, ${t.secondary}); }
/* Intentionally empty: the base .sui-button IS the outline look; the
   variant class exists so consumers can target it. Do not clean up. */
.sui-button-outline { }
.sui-button-ghost { border-color:transparent; background:transparent; }
.sui-button-ghost:hover { background:${t.secondary}; }
.sui-button-ghost:active:not(:disabled) { background:color-mix(in srgb, ${t.foreground} 6%, ${t.secondary}); }
.sui-button-destructive { border-color:color-mix(in srgb, ${t.destructive} 38%, transparent); background:${t.card}; color:${t.destructive}; }
.sui-button-destructive:hover { background:color-mix(in srgb, ${t.destructive} 8%, ${t.card}); }
.sui-button-destructive:active:not(:disabled) { background:color-mix(in srgb, ${t.destructive} 14%, ${t.card}); }
.sui-button-link { min-height:auto; border:none; padding:0; background:transparent; color:${t.primary}; text-decoration:underline; text-underline-offset:3px; }
.sui-button-link:hover { background:transparent; text-decoration-thickness:2px; }
.sui-button-sm { min-height:26px; padding:0 8px; font-size:12px; }
.sui-button-lg { min-height:38px; padding:0 16px; }
.sui-button-icon-size { min-height:${t.controlHeight}; width:32px; padding:0; }
`;

/* -------------------------------------------------------------------------- */
/* Badge + StatusPill                                                         */
/* -------------------------------------------------------------------------- */

export const badgeCss = `
.sui-badge { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; min-height:22px; padding:0 10px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:transparent; color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sui-badge-default { border-color:${t.primaryBorder}; background:${t.primarySoft}; color:${t.primary}; }
.sui-badge-secondary { border-color:${t.border}; background:${t.hoverSubtle}; color:${t.mutedForeground}; }
.sui-badge-outline { border-color:${t.input}; color:${t.foreground}; }
.sui-badge-success { border-color:${t.successBorder}; background:${t.successSoft}; color:${t.success}; }
.sui-badge-warning { border-color:${t.warningBorder}; background:${t.warningSoft}; color:${t.warning}; }
.sui-badge-destructive { border-color:${t.destructiveBorder}; background:${t.destructiveSoft}; color:${t.destructive}; }
.sui-badge-muted { border-color:${t.border}; background:color-mix(in srgb, ${t.mutedForeground} 12%, transparent); color:${t.mutedForeground}; }
.sui-status-dot { width:6px; height:6px; flex:none; border-radius:${t.radiusFull}; background:currentColor; }
`;

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export const cardCss = `
.sui-card { min-width:0; display:grid; align-content:start; gap:10px; padding:14px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; box-shadow:${shadowCard}; }
.sui-card[role='button'] { cursor:pointer; ${interaction} }
.sui-card[role='button']:hover { background:${t.secondary}; }
.sui-card[role='button']:focus-visible { ${focusRing} }
.sui-card-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }
.sui-card-title { min-width:0; color:${t.cardForeground}; font-size:13px; font-weight:650; }
.sui-card-description { min-width:0; color:${t.mutedForeground}; font-size:12px; line-height:1.45; }
.sui-card-action { display:flex; align-items:center; gap:8px; flex:none; }
.sui-card-content { min-width:0; display:grid; align-content:start; gap:8px; }
.sui-card-footer { min-width:0; display:flex; align-items:center; gap:8px; }
`;

/* -------------------------------------------------------------------------- */
/* Form controls: Input, Textarea, Label, Field                               */
/* -------------------------------------------------------------------------- */

export const formCss = `
.sui-input { min-width:0; min-height:${t.controlHeight}; padding:0 10px; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:13px; outline:none; }
.sui-input:focus-visible { ${focusRing} }
.sui-input::placeholder { color:${t.placeholder}; }
.sui-input:disabled { cursor:not-allowed; opacity:.45; }
.sui-textarea { min-width:0; min-height:88px; padding:10px 12px; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:13px; line-height:1.45; resize:vertical; outline:none; }
.sui-textarea:focus-visible { ${focusRing} }
.sui-textarea::placeholder { color:${t.placeholder}; }
.sui-textarea:disabled { cursor:not-allowed; opacity:.45; }
.sui-label { color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-field { min-width:0; display:grid; gap:6px; }
`;

/* -------------------------------------------------------------------------- */
/* Chat: transcript, message bubbles, and floating glass composer             */
/* -------------------------------------------------------------------------- */

export const chatCss = `
.sui-chat-transcript { flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.sui-chat-messages { display:flex; flex-direction:column; gap:18px; width:min(100%, 720px); min-height:100%; margin:0 auto; padding:36px 24px 156px; }
.sui-chat-empty { display:grid; place-items:center; flex:1; min-height:240px; color:${t.mutedForeground}; text-align:center; }
.sui-chat-message { display:grid; max-width:100%; animation:sui-chat-message-in 140ms ease-out both; }
.sui-chat-message[data-role='user'] { justify-items:end; }
.sui-chat-message[data-role='assistant'] { justify-items:start; }
.sui-chat-message[data-role='system'] { justify-items:center; }
.sui-chat-bubble { max-width:80%; padding:10px 14px; border-radius:${t.radiusBubble}; background:${t.secondary}; color:${t.secondaryForeground}; font-size:15px; line-height:1.5; white-space:normal; overflow-wrap:anywhere; }
.sui-chat-message[data-role='user'] .sui-chat-bubble { border-bottom-right-radius:${t.radiusControl}; background:${t.inverseBg}; color:${t.inverseText}; white-space:pre-wrap; }
.sui-chat-message[data-role='assistant'] .sui-chat-bubble { border-bottom-left-radius:${t.radiusControl}; }
.sui-chat-message[data-role='system'] .sui-chat-bubble { max-width:min(92%, 620px); border:1px solid ${t.border}; background:${t.glassStrong}; color:${t.mutedForeground}; font-size:13px; text-align:center; }
.sui-chat-message[data-variant='terminal'] .sui-chat-bubble { width:min(100%, 680px); max-width:96%; max-height:min(52vh, 520px); overflow:auto; border:1px solid ${t.border}; background:${t.codeBg}; color:${t.codeText}; font-family:${t.fontMono}; font-size:12px; line-height:1.5; white-space:pre; tab-size:4; }
.sui-chat-message[data-variant='terminal'] .sui-chat-bubble:focus-visible { ${focusRing} }
.sui-chat-message-label, .sui-chat-message-meta { max-width:80%; padding:0 8px; color:${t.mutedForeground}; font-size:11px; line-height:1.4; }
.sui-chat-message-label { margin-bottom:4px; font-weight:650; }
.sui-chat-message-meta { margin-top:4px; }
.sui-chat-bubble > :first-child { margin-top:0; }
.sui-chat-bubble > :last-child { margin-bottom:0; }
.sui-chat-bubble-pending { display:inline-flex; align-items:center; padding:14px; }
.sui-chat-typing { display:inline-flex; align-items:center; gap:6px; }
.sui-chat-typing span { width:7px; height:7px; border-radius:${t.radiusFull}; background:${t.placeholder}; animation:sui-chat-typing 1.3s ease-in-out infinite; }
.sui-chat-typing span:nth-child(2) { animation-delay:.2s; }
.sui-chat-typing span:nth-child(3) { animation-delay:.4s; }
.sui-chat-composer { position:relative; display:grid; gap:12px; width:min(100%, 720px); margin:0 auto; padding:16px; border:1px solid ${t.border}; border-radius:${t.radiusBubble}; background:${t.glass}; -webkit-backdrop-filter:blur(20px) saturate(180%); backdrop-filter:blur(20px) saturate(180%); box-shadow:0 1px 2px rgb(${t.shadowRgb} / 0.04), 0 16px 40px rgb(${t.shadowRgb} / 0.10); transition:border-color .15s ease, box-shadow .15s ease; }
.sui-chat-composer:focus-within { border-color:color-mix(in srgb, ${t.primary} 32%, ${t.border}); box-shadow:0 0 0 4px color-mix(in srgb, ${t.primary} 12%, transparent), 0 1px 2px rgb(${t.shadowRgb} / 0.05), 0 20px 48px rgb(${t.shadowRgb} / 0.14); }
.sui-chat-composer[data-docked='true'] { position:fixed; right:24px; bottom:max(18px, env(safe-area-inset-bottom)); left:24px; z-index:40; }
.sui-chat-composer-input { width:100%; min-width:0; min-height:28px; max-height:160px; padding:2px 4px; resize:none; overflow-y:auto; border:0; outline:0; background:transparent; color:${t.foreground}; font:inherit; font-size:16px; line-height:1.5; }
.sui-chat-composer-input::placeholder { color:${t.placeholder}; }
.sui-chat-composer-input:disabled { cursor:not-allowed; opacity:.55; }
.sui-chat-composer-toolbar { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:12px; }
.sui-chat-composer-status { min-width:0; color:${t.mutedForeground}; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-chat-composer-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex:none; }
.sui-chat-composer-send { width:34px; height:34px; min-height:34px; border-radius:${t.radius}; font-size:18px; }
.sui-chat-composer-stop { width:34px; height:34px; min-height:34px; border-radius:${t.radius}; color:${t.destructive}; font-size:12px; }
.sui-chat-composer-stop:hover { background:${t.destructiveSoft}; color:${t.destructive}; }
@keyframes sui-chat-message-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
@keyframes sui-chat-typing { 0%, 60%, 100% { opacity:.3; } 30% { opacity:1; } }
@media (max-width: 620px) { .sui-chat-messages { padding:24px 14px 146px; } .sui-chat-bubble { max-width:90%; } .sui-chat-composer[data-docked='true'] { right:12px; left:12px; bottom:max(10px, env(safe-area-inset-bottom)); } }
`;

export const chatScrollerCss = `
.sui-msg-scroller { position:relative; flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:column; }
.sui-msg-scroller-viewport { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
.sui-msg-scroller-viewport:focus-visible { ${focusRing} }
.sui-msg-scroller-content { min-width:0; }
.sui-msg-scroller-jump { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); z-index:5; width:32px; height:${t.controlHeight}; display:inline-flex; align-items:center; justify-content:center; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:${t.glassStrong}; color:${t.foreground}; font:inherit; cursor:pointer; box-shadow:0 1px 2px rgb(${t.shadowRgb} / 0.06), 0 8px 24px rgb(${t.shadowRgb} / 0.10); ${interaction} }
.sui-msg-scroller-jump:hover { background:${t.secondary}; }
.sui-msg-scroller-jump:focus-visible { ${focusRing} }
.sui-scroll-fade[data-fade-top='true'][data-fade-bottom='false'] { mask-image:linear-gradient(to bottom, transparent, black 32px); -webkit-mask-image:linear-gradient(to bottom, transparent, black 32px); }
.sui-scroll-fade[data-fade-top='false'][data-fade-bottom='true'] { mask-image:linear-gradient(to bottom, black calc(100% - 32px), transparent); -webkit-mask-image:linear-gradient(to bottom, black calc(100% - 32px), transparent); }
.sui-scroll-fade[data-fade-top='true'][data-fade-bottom='true'] { mask-image:linear-gradient(to bottom, transparent, black 32px, black calc(100% - 32px), transparent); -webkit-mask-image:linear-gradient(to bottom, transparent, black 32px, black calc(100% - 32px), transparent); }
.sui-bubble { max-width:80%; padding:10px 14px; border-radius:${t.radiusBubble}; font-size:15px; line-height:1.5; overflow-wrap:anywhere; }
.sui-bubble[data-align='start'] { align-self:flex-start; }
.sui-bubble[data-align='end'] { align-self:flex-end; }
.sui-bubble[data-align='center'] { align-self:center; }
.sui-bubble-user { background:${t.inverseBg}; color:${t.inverseText}; white-space:pre-wrap; }
.sui-bubble-assistant { background:${t.secondary}; color:${t.secondaryForeground}; }
.sui-bubble-system { border:1px solid ${t.border}; background:${t.glassStrong}; color:${t.mutedForeground}; font-size:13px; text-align:center; }
.sui-bubble-content > :first-child { margin-top:0; }
.sui-bubble-content > :last-child { margin-bottom:0; }
.sui-bubble[data-expanded='false'] .sui-bubble-content { max-height:var(--sui-bubble-clamp, 320px); overflow:hidden; mask-image:linear-gradient(to bottom, black calc(100% - 32px), transparent); -webkit-mask-image:linear-gradient(to bottom, black calc(100% - 32px), transparent); }
.sui-bubble-toggle { display:inline-flex; align-items:center; justify-content:center; margin:8px auto 0; padding:4px 8px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.mutedForeground}; font:inherit; font-size:11px; font-weight:650; cursor:pointer; ${interaction} }
.sui-bubble-toggle:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-bubble-toggle:focus-visible { ${focusRing} }
.sui-attachment { position:relative; display:grid; grid-template-columns:40px minmax(0, 1fr) auto; align-items:center; gap:10px; min-width:0; max-width:360px; padding:8px 10px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; }
.sui-attachment-thumb { width:40px; height:40px; display:grid; place-items:center; overflow:hidden; border-radius:${t.radiusControl}; background:${t.secondary}; color:${t.mutedForeground}; }
.sui-attachment-thumb img { width:100%; height:100%; object-fit:cover; }
.sui-attachment-ext { max-width:100%; padding:0 4px; font-family:${t.fontMono}; font-size:10px; font-weight:650; overflow:hidden; text-overflow:ellipsis; }
.sui-attachment-details { min-width:0; display:grid; gap:4px; }
.sui-attachment-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:${t.fontSizeCompact}; font-weight:650; }
.sui-attachment-meta { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${t.mutedForeground}; font-size:11px; }
.sui-attachment-progress { position:relative; width:100%; height:3px; overflow:hidden; border-radius:${t.radiusFull}; background:color-mix(in srgb, ${t.primary} 14%, transparent); }
.sui-attachment-progress-bar { display:block; height:100%; border-radius:inherit; background:${t.primary}; }
.sui-attachment-progress-indeterminate { width:40%; animation:sui-attachment-indeterminate 1.2s ease-in-out infinite; }
.sui-attachment-remove { width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:18px; cursor:pointer; ${interaction} }
.sui-attachment-remove:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-attachment-remove:focus-visible { ${focusRing} }
.sui-attachment[data-state='error'] .sui-attachment-name, .sui-attachment[data-state='error'] .sui-attachment-meta { color:${t.destructive}; }
.sui-marker { display:flex; align-items:center; gap:10px; min-width:0; color:${t.mutedForeground}; font-size:11px; }
.sui-marker-label { min-width:0; }
.sui-marker[data-variant='separator']::before, .sui-marker[data-variant='separator']::after { content:""; flex:1; height:1px; background:${t.border}; }
.sui-marker[data-variant='separator'] .sui-marker-label { flex:none; text-align:center; }
.sui-marker[data-variant='note'] { justify-content:center; }
.sui-marker[data-variant='note'] .sui-marker-label { max-width:100%; padding:4px 10px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:${t.glassStrong}; text-align:center; }
.sui-marker[data-variant='status'] { justify-content:flex-start; }
.sui-shimmer { display:inline; }
.sui-shimmer[data-active='true'] { background:linear-gradient(90deg, ${t.mutedForeground} 35%, ${t.foreground} 50%, ${t.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }
@keyframes sui-attachment-indeterminate { from { transform:translateX(-100%); } to { transform:translateX(250%); } }
`;

/* -------------------------------------------------------------------------- */
/* Alert                                                                      */
/* -------------------------------------------------------------------------- */

export const alertCss = `
.sui-alert { min-width:0; display:grid; gap:4px; padding:12px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.mutedForeground}; font-size:13px; }
.sui-alert-title { color:${t.foreground}; font-size:13px; font-weight:650; }
.sui-alert-description { color:${t.mutedForeground}; line-height:1.45; }
.sui-alert-success { border-color:color-mix(in srgb, ${t.success} 45%, transparent); }
.sui-alert-success .sui-alert-title { color:${t.success}; }
.sui-alert-warning { border-color:color-mix(in srgb, ${t.warning} 45%, transparent); }
.sui-alert-warning .sui-alert-title { color:${t.warning}; }
.sui-alert-destructive { border-color:color-mix(in srgb, ${t.destructive} 45%, transparent); color:${t.destructive}; }
.sui-alert-destructive .sui-alert-title { color:${t.destructive}; }
.sui-alert-destructive .sui-alert-description { color:color-mix(in srgb, ${t.destructive} 80%, ${t.foreground}); }
`;

/* -------------------------------------------------------------------------- */
/* Table                                                                      */
/* -------------------------------------------------------------------------- */

export const tableCss = `
.sui-table-container { min-width:0; width:100%; overflow-x:auto; }
.sui-table { width:100%; border-collapse:collapse; font-size:13px; }
.sui-table th, .sui-table td { padding:8px 10px; border-bottom:1px solid ${t.border}; text-align:left; vertical-align:top; }
.sui-table th { position:sticky; top:0; z-index:1; background:${t.card}; color:${t.mutedForeground}; font-size:11px; text-transform:uppercase; letter-spacing:.04em; font-weight:650; }
.sui-table caption { padding:8px 10px; color:${t.mutedForeground}; font-size:11px; text-align:left; caption-side:bottom; }
.sui-table tbody tr:hover { background:${t.hoverSubtle}; }
`;

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

export const tabsCss = `
.sui-tabs { min-width:0; display:grid; align-content:start; gap:10px; }
.sui-tabs-list { display:flex; align-items:center; gap:2px; min-width:0; overflow-x:auto; border-bottom:1px solid ${t.border}; }
.sui-tabs-trigger { display:inline-flex; align-items:center; gap:6px; padding:8px 10px; border:none; border-bottom:2px solid transparent; margin-bottom:-1px; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:${t.fontSizeCompact}; font-weight:650; cursor:pointer; white-space:nowrap; ${interaction} }
.sui-tabs-trigger:hover { color:${t.foreground}; }
.sui-tabs-trigger:focus-visible { ${focusRing} border-radius:${t.radiusControl}; }
.sui-tabs-trigger[data-state='active'] { color:${t.foreground}; border-bottom-color:${t.primary}; }
.sui-tabs-trigger:disabled { cursor:not-allowed; opacity:.45; }
.sui-tab-count { font-family:${t.fontMono}; font-size:10px; color:${t.mutedForeground}; border:1px solid ${t.border}; border-radius:${t.radiusFull}; padding:0 6px; min-width:18px; text-align:center; }
.sui-tabs-trigger[data-state='active'] .sui-tab-count { color:${t.primary}; border-color:color-mix(in srgb, ${t.primary} 33%, transparent); }
.sui-tabs-content { min-width:0; }
.sui-tabs-content:focus-visible { outline:none; }
`;

/* -------------------------------------------------------------------------- */
/* Dialog                                                                     */
/* -------------------------------------------------------------------------- */

export const dialogCss = `
.sui-dialog-overlay { position:fixed; inset:0; z-index:50; background:color-mix(in srgb, rgb(${t.shadowRgb}) 45%, transparent); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); }
.sui-dialog-content { position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); z-index:50; display:grid; gap:10px; width:calc(100vw - 32px); max-width:480px; max-height:calc(100vh - 48px); overflow:auto; padding:16px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; box-shadow:${shadowOverlay}; }
.sui-dialog-header { min-width:0; display:grid; gap:4px; padding-right:28px; }
.sui-dialog-title { color:${t.cardForeground}; font-size:13px; font-weight:650; }
.sui-dialog-description { color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; line-height:1.45; }
.sui-dialog-footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
.sui-dialog-close { position:absolute; top:10px; right:10px; display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; cursor:pointer; ${interaction} }
.sui-dialog-close:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-dialog-close:focus-visible { ${focusRing} }
`;

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                    */
/* -------------------------------------------------------------------------- */

export const tooltipCss = `
.sui-tooltip-content { z-index:60; max-width:320px; padding:4px 8px; border-radius:${t.radiusControl}; background:${t.inverseBg}; color:${t.inverseText}; font-size:11px; line-height:1.4; box-shadow:${shadowCard}; }
`;

/* -------------------------------------------------------------------------- */
/* Agentic plan, task, sources, and inline citation                           */
/* -------------------------------------------------------------------------- */

export const agenticPlanCss = `
.sui-plan { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-plan-header { min-width:0; display:flex; align-items:center; gap:10px; padding:8px 10px; }
.sui-plan-trigger { min-width:0; min-height:28px; flex:1 1 auto; display:flex; align-items:center; gap:8px; margin:-4px; padding:4px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.foreground}; font:inherit; text-align:left; cursor:pointer; ${interaction} }
.sui-plan-trigger:hover { background:${t.secondary}; }
.sui-plan-trigger:focus-visible { ${focusRing} }
.sui-plan-chevron { display:inline-flex; align-items:center; justify-content:center; width:12px; flex:none; color:${t.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-plan-trigger[aria-expanded='true'] .sui-plan-chevron { transform:rotate(90deg); }
.sui-plan-title { min-width:0; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-plan-title[data-shimmer='true'] { background:linear-gradient(90deg, ${t.mutedForeground} 35%, ${t.foreground} 50%, ${t.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }
.sui-plan-summary { flex:none; color:${t.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-plan-steps { display:grid; gap:0; margin:0; padding:0 10px 10px; list-style:none; }
.sui-plan-step { position:relative; min-width:0; border-top:1px solid ${t.border}; }
.sui-plan-step-row { min-width:0; display:grid; grid-template-columns:10px minmax(0, 1fr) auto; align-items:center; gap:8px; min-height:36px; }
.sui-plan-step-dot, .sui-taskitem-dot { width:7px; height:7px; flex:none; border-radius:${t.radiusFull}; background:color-mix(in srgb, ${t.mutedForeground} 40%, transparent); }
.sui-plan-step[data-status-class='run'] .sui-plan-step-dot { background:${statusColors.run}; }
.sui-plan-step[data-status-class='ok'] .sui-plan-step-dot { background:${statusColors.ok}; }
.sui-plan-step[data-status-class='warn'] .sui-plan-step-dot { background:${statusColors.warn}; }
.sui-plan-step[data-status-class='bad'] .sui-plan-step-dot { background:${statusColors.bad}; }
.sui-plan-step[data-status-class='muted'] .sui-plan-step-dot { background:${statusColors.muted}; }
.sui-plan-step-label { min-width:0; color:${t.foreground}; font-size:13px; line-height:1.4; overflow-wrap:anywhere; }
.sui-plan-step[data-status='skipped'] .sui-plan-step-label { color:${t.mutedForeground}; text-decoration:line-through; }
.sui-plan-step-toggle { min-height:24px; padding:2px 6px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:11px; cursor:pointer; ${interaction} }
.sui-plan-step-toggle:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-plan-step-toggle:focus-visible { ${focusRing} }
.sui-plan-step-detail { min-width:0; margin:0 0 8px 18px; padding:8px 10px; border-radius:${t.radiusControl}; background:${t.surface2}; color:${t.mutedForeground}; font-size:12px; line-height:1.45; }
.sui-taskitem { min-width:0; display:flex; align-items:center; gap:8px; padding:8px 10px; color:${t.foreground}; font-size:${t.fontSizeCompact}; }
.sui-taskitem-run .sui-taskitem-dot { background:${statusColors.run}; }
.sui-taskitem-ok .sui-taskitem-dot { background:${statusColors.ok}; }
.sui-taskitem-warn .sui-taskitem-dot { background:${statusColors.warn}; }
.sui-taskitem-bad .sui-taskitem-dot { background:${statusColors.bad}; }
.sui-taskitem-muted .sui-taskitem-dot { background:${statusColors.muted}; }
.sui-taskitem-label { min-width:0; flex:1 1 auto; overflow-wrap:anywhere; }
.sui-taskitem-files { min-width:0; display:flex; align-items:center; justify-content:flex-end; gap:4px; flex-wrap:wrap; }
.sui-taskitem-file { max-width:180px; padding:2px 6px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:${t.hoverSubtle}; color:${t.mutedForeground}; font-family:${t.fontMono}; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-taskitem-elapsed { flex:none; color:${t.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-sources { min-width:0; color:${t.mutedForeground}; font-size:12px; }
.sui-sources-trigger { min-height:28px; display:inline-flex; align-items:center; gap:6px; padding:4px 6px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; ${interaction} }
.sui-sources-trigger:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-sources-trigger:focus-visible { ${focusRing} }
.sui-sources-list { display:grid; gap:6px; margin:4px 0 0; padding:8px 8px 8px 28px; border-left:1px solid ${t.border}; list-style:decimal; }
.sui-sources-item { min-width:0; padding-left:2px; }
.sui-sources-link { color:${t.primary}; text-decoration:underline; text-underline-offset:2px; overflow-wrap:anywhere; }
.sui-sources-link:hover { text-decoration-thickness:2px; }
.sui-sources-link:focus-visible { ${focusRing} }
.sui-sources-label { color:${t.mutedForeground}; overflow-wrap:anywhere; }
.sui-citation { line-height:0; }
.sui-citation > a, .sui-citation > button { display:inline-flex; align-items:center; justify-content:center; margin:0 1px; padding:2px 4px; border:1px solid color-mix(in srgb, ${t.primary} 33%, transparent); border-radius:${t.radiusFull}; background:color-mix(in srgb, ${t.primary} 10%, transparent); color:${t.primary}; font:inherit; font-size:10px; font-weight:650; line-height:1.2; text-decoration:none; vertical-align:super; cursor:pointer; }
.sui-citation > a:hover, .sui-citation > button:hover { background:color-mix(in srgb, ${t.primary} 16%, transparent); }
.sui-citation > a:focus-visible, .sui-citation > button:focus-visible { ${focusRing} }
`;

/* -------------------------------------------------------------------------- */
/* Select                                                                     */
/* -------------------------------------------------------------------------- */

export const selectCss = `
.sui-select-trigger { min-width:0; min-height:${t.controlHeight}; display:inline-flex; align-items:center; justify-content:space-between; gap:8px; padding:0 10px; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; ${interaction} }
.sui-select-trigger:hover { background:${t.secondary}; }
.sui-select-trigger:focus-visible { ${focusRing} }
.sui-select-trigger:disabled { cursor:not-allowed; opacity:.45; }
.sui-select-trigger[data-placeholder] { color:${t.placeholder}; }
.sui-select-icon { color:${t.mutedForeground}; flex:none; }
.sui-select-content { z-index:60; min-width:var(--radix-select-trigger-width, 8rem); max-height:var(--radix-select-content-available-height, 320px); overflow:hidden; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.popover}; color:${t.popoverForeground}; box-shadow:${shadowOverlay}; }
.sui-select-viewport { padding:4px; }
.sui-select-item { position:relative; display:flex; align-items:center; gap:6px; padding:6px 8px 6px 26px; border-radius:${t.radiusControl}; color:${t.foreground}; font-size:13px; cursor:pointer; user-select:none; outline:none; ${interaction} }
.sui-select-item[data-highlighted] { background:${t.secondary}; }
.sui-select-item[data-disabled] { opacity:.45; cursor:not-allowed; }
.sui-select-item-indicator { position:absolute; left:7px; display:inline-flex; align-items:center; color:${t.primary}; }
.sui-select-label { padding:6px 8px; color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-select-separator { height:1px; margin:4px 0; background:${t.border}; }
.sui-select-scroll-button { display:flex; align-items:center; justify-content:center; height:20px; color:${t.mutedForeground}; cursor:default; }
`;

/* -------------------------------------------------------------------------- */
/* Progress, Skeleton, Spinner, Separator                                     */
/* -------------------------------------------------------------------------- */

export const progressCss = `
.sui-progress { position:relative; width:100%; height:6px; overflow:hidden; border-radius:${t.radiusFull}; background:${t.secondary}; }
.sui-progress-indicator { width:100%; height:100%; border-radius:${t.radiusFull}; background:${t.primary}; transition:transform .3s ease; }
`;

export const skeletonCss = `
.sui-skeleton { display:block; min-height:14px; border-radius:${t.radiusControl}; background:color-mix(in srgb, ${t.mutedForeground} 14%, transparent); animation:sui-skeleton-pulse 1.6s ease-in-out infinite; }
@keyframes sui-skeleton-pulse { 0%, 100% { opacity:1; } 50% { opacity:.45; } }
`;

export const spinnerCss = `
.sui-spinner { display:inline-block; width:14px; height:14px; flex:none; border:2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color:currentColor; border-radius:${t.radiusFull}; animation:sui-spin .7s linear infinite; }
.sui-spinner-sm { width:11px; height:11px; border-width:1.5px; }
.sui-spinner-lg { width:20px; height:20px; }
@keyframes sui-spin { to { transform:rotate(360deg); } }
`;

export const separatorCss = `
.sui-separator { flex:none; background:${t.border}; }
.sui-separator[data-orientation='horizontal'] { height:1px; width:100%; }
.sui-separator[data-orientation='vertical'] { width:1px; align-self:stretch; }
`;

/* -------------------------------------------------------------------------- */
/* RelativeTime                                                               */
/* -------------------------------------------------------------------------- */

export const timeCss = `
.sui-relative-time { font-variant-numeric:tabular-nums; }
`;

/* -------------------------------------------------------------------------- */
/* House compositions: EmptyState, SectionHeader, Eyebrow, RowButton, KpiStat */
/* -------------------------------------------------------------------------- */

export const emptyStateCss = `
.sui-empty { min-width:0; display:grid; justify-items:center; gap:6px; padding:24px; color:${t.mutedForeground}; text-align:center; }
.sui-empty-icon { color:${t.textFaint}; }
.sui-empty-title { color:${t.foreground}; font-size:13px; font-weight:650; }
.sui-empty-description { color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; line-height:1.45; max-width:420px; }
.sui-empty-action { margin-top:6px; }
`;

export const sectionHeaderCss = `
.sui-section-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }
.sui-section-header-main { min-width:0; display:grid; gap:2px; }
.sui-section-header-title { min-width:0; color:${t.foreground}; font-size:13px; font-weight:650; }
.sui-section-header-actions { display:flex; align-items:center; gap:8px; flex:none; }
.sui-eyebrow { color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
`;

export const rowButtonCss = `
.sui-row-button { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; padding:10px 12px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:13px; text-align:left; cursor:pointer; box-shadow:${t.shadow1}; ${interaction} }
.sui-row-button:hover { background:${t.secondary}; }
.sui-row-button:active:not(:disabled) { background:color-mix(in srgb, ${t.foreground} 6%, ${t.secondary}); }
.sui-row-button:focus-visible { ${focusRing} }
.sui-row-button[data-active='true'] { background:${t.secondary}; border-color:color-mix(in srgb, ${t.primary} 40%, transparent); box-shadow:inset 2px 0 0 ${t.primary}, ${t.shadow1}; }
.sui-row-button:disabled { cursor:not-allowed; opacity:.45; }
`;

export const kpiStatCss = `
.sui-kpi { min-width:0; display:grid; gap:4px; padding:14px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; box-shadow:${shadowCard}; }
/* The KPI numeral is the one sanctioned 700 weight in the system. */
.sui-kpi-value { color:${t.foreground}; font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }
.sui-kpi-label { color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-kpi-hint { color:${t.textFaint}; font-size:11px; }
`;

export const collapsiblePanelCss = `
.sui-collapsible { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; box-shadow:${shadowCard}; overflow:hidden; }
.sui-collapsible-header { min-width:0; display:flex; align-items:center; gap:10px; padding:12px 14px; cursor:pointer; user-select:none; ${interaction} }
.sui-collapsible-header:hover { background:${t.secondary}; }
.sui-collapsible-header:focus-visible { outline:none; box-shadow:inset 0 0 0 2px ${t.ringBorder}; }
.sui-collapsible-heading { min-width:0; flex:1; display:flex; align-items:center; gap:8px; }
.sui-collapsible-title { min-width:0; color:${t.cardForeground}; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-collapsible-meta { flex:none; color:${t.mutedForeground}; font-size:11px; }
.sui-collapsible-toggle { flex:none; color:${t.mutedForeground}; font-size:11px; }
.sui-collapsible-body { min-width:0; display:grid; align-content:start; gap:8px; padding:0 14px 14px; }
.sui-collapsible-empty { color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; line-height:1.45; padding:0 14px 14px; }
`;

/* -------------------------------------------------------------------------- */
/* Diff hunks                                                                 */
/* -------------------------------------------------------------------------- */

export const diffCss = `
.sui-diff { border:1px solid ${t.border}; border-radius:${t.radius}; overflow:hidden; font:500 12px/1.7 ${t.fontMono}; }
.sui-diff-line { display:flex; padding:0 10px; }
.sui-diff-line.sui-diff-add { background:color-mix(in srgb, ${t.success} 10%, ${t.card}); color:color-mix(in srgb, ${t.success} 80%, ${t.foreground}); }
.sui-diff-line.sui-diff-del { background:color-mix(in srgb, ${t.destructive} 9%, ${t.card}); color:color-mix(in srgb, ${t.destructive} 80%, ${t.foreground}); }
.sui-diff-ln { flex:none; width:34px; padding-right:12px; text-align:right; color:${t.placeholder}; user-select:none; }
.sui-diff-ln-old, .sui-diff-ln-new { width:30px; }
.sui-diff-sign { flex:none; width:14px; }
.sui-diff-text { white-space:pre; overflow-x:auto; }
.sui-diff-hunk-head { display:flex; align-items:center; gap:8px; padding:2px 10px; background:color-mix(in srgb, ${t.primary} 7%, ${t.card}); color:color-mix(in srgb, ${t.primary} 80%, ${t.mutedForeground}); border-top:1px solid ${t.border}; }
.sui-diff-hunk-gutter { flex:none; width:60px; text-align:center; color:${t.placeholder}; user-select:none; }
.sui-diff-hunk-header { white-space:pre; overflow-x:auto; }
.sui-diff-binary { padding:12px; color:${t.mutedForeground}; font-style:italic; }
.sui-diff-partial { padding:6px 10px; background:${t.warningSoft}; color:${t.warning}; border-bottom:1px solid ${t.warningBorder}; font:650 12px/1.6 ${t.fontSans}; }
.sui-diff-paginate { display:grid; place-items:center; padding:8px; border-top:1px solid ${t.border}; }
.sui-diff-paginate-btn { padding:6px 12px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.primary}; font:650 12px/1 ${t.fontSans}; cursor:pointer; ${interaction} }
.sui-diff-paginate-btn:hover { background:${t.secondary}; }
`;

export const fileTreeCss = `
.sui-file-tree { min-width:0; display:flex; flex-direction:column; gap:1px; font-size:13px; color:${t.foreground}; }
.sui-file-tree-children { display:flex; flex-direction:column; gap:1px; margin-left:10px; padding-left:8px; border-left:1px solid ${t.border}; }
.sui-file-tree-dir { min-width:0; display:flex; flex-direction:column; gap:1px; }
.sui-file-tree-dir-toggle { min-width:0; display:flex; align-items:center; gap:6px; width:100%; padding:4px 6px; border:none; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:${t.fontSizeCompact}; font-weight:650; text-align:left; cursor:pointer; ${interaction} }
.sui-file-tree-dir-toggle:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-file-tree-dir-toggle:focus-visible { ${focusRing} }
.sui-file-tree-caret { flex:none; width:0; height:0; border-top:4px solid transparent; border-bottom:4px solid transparent; border-left:5px solid currentColor; transform:rotate(90deg); transition:transform .12s ease; }
.sui-file-tree-dir-toggle[aria-expanded='false'] .sui-file-tree-caret { transform:rotate(0deg); }
.sui-file-tree-dir-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-file-tree-row { min-width:0; display:flex; align-items:center; gap:4px; }
.sui-file-tree-file { min-width:0; flex:1 1 auto; display:flex; align-items:center; gap:6px; padding:4px 6px; border:none; border-radius:${t.radiusControl}; background:transparent; color:${t.foreground}; font:inherit; font-size:13px; text-align:left; cursor:pointer; ${interaction} }
.sui-file-tree-file:hover { background:${t.secondary}; }
.sui-file-tree-file:focus-visible { ${focusRing} }
.sui-file-tree-file[data-active='true'] { background:color-mix(in srgb, ${t.primary} 12%, transparent); color:${t.primary}; font-weight:650; }
.sui-file-tree-file-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-file-tree-affordance { flex:none; display:inline-flex; align-items:center; }
.sui-file-tree-note { padding:4px 6px; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
`;

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

export const markdownCss = `
.sui-md { min-width:0; color:${t.foreground}; font-size:13px; line-height:1.55; overflow-wrap:anywhere; }
.sui-md > :first-child { margin-top:0; }
.sui-md > :last-child { margin-bottom:0; }
.sui-md-p { margin:6px 0; }
.sui-md-heading { margin:14px 0 6px; color:${t.foreground}; font-weight:650; line-height:1.3; }
.sui-md-h1 { font-size:1.5em; }
.sui-md-h2 { font-size:1.3em; }
.sui-md-h3 { font-size:1.15em; }
.sui-md-h4 { font-size:1em; }
.sui-md-h5 { font-size:.9em; }
.sui-md-h6 { font-size:.85em; color:${t.mutedForeground}; }
.sui-md-list { margin:6px 0; padding-left:22px; }
.sui-md-list li { margin:2px 0; }
.sui-md-inline-code { padding:2px 6px; border-radius:${t.radiusControl}; background:color-mix(in srgb, ${t.foreground} 7%, transparent); font-family:${t.fontMono}; font-size:.9em; }
.sui-md-link { color:${t.primary}; text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.sui-md-link:hover { text-decoration-thickness:2px; }
`;

export const agenticResponseCss = `
.sui-response { min-width:0; }
.sui-response-caret { display:inline-block; width:7px; height:14px; margin-left:2px; vertical-align:text-bottom; border-radius:2px; background:${t.mutedForeground}; animation:sui-caret-blink 1s steps(2, jump-none) infinite; }
@keyframes sui-caret-blink { 50% { opacity:0; } }
.sui-codeblock { margin:8px 0; border-radius:${t.radius}; background:${t.codeBg}; color:${t.codeText}; overflow:hidden; }
.sui-codeblock-header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; border-bottom:1px solid color-mix(in srgb, ${t.codeText} 12%, transparent); }
.sui-codeblock-lang { font-family:${t.fontMono}; font-size:11px; color:color-mix(in srgb, ${t.codeText} 70%, transparent); text-transform:lowercase; }
.sui-codeblock-actions { display:inline-flex; align-items:center; gap:6px; margin-left:auto; }
.sui-codeblock-action { min-height:24px; padding:0 8px; border:1px solid color-mix(in srgb, ${t.codeText} 16%, transparent); border-radius:${t.radiusControl}; background:transparent; color:color-mix(in srgb, ${t.codeText} 76%, transparent); font:inherit; font-size:11px; cursor:pointer; ${interaction} }
.sui-codeblock-action:hover { background:color-mix(in srgb, ${t.codeText} 9%, transparent); color:${t.codeText}; }
.sui-codeblock-action:focus-visible { ${focusRing} }
.sui-codeblock-body { margin:0; padding:12px 14px; font-family:${t.fontMono}; font-size:12px; line-height:1.5; overflow:auto; tab-size:4; }
.sui-codeblock-body:focus-visible { ${focusRing} }
.sui-codeblock-body code { display:block; min-width:max-content; white-space:pre; font:inherit; color:inherit; }
.sui-codeblock[data-wrap='true'] .sui-codeblock-body code { min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.sui-codeblock-lineno { display:inline-block; min-width:2.5em; padding-right:12px; text-align:right; color:color-mix(in srgb, ${t.codeText} 40%, transparent); user-select:none; }
`;

export const agentOutputCss = `
.sui-agent-output { min-width:0; display:grid; align-content:start; gap:10px; }
.sui-agent-output-tools { min-width:0; display:grid; align-content:start; gap:8px; }
`;

/* -------------------------------------------------------------------------- */
/* PierreDiffView adapter (thin frame; CodeView owns the highlighted body)     */
/* -------------------------------------------------------------------------- */

export const pierreDiffCss = `
.sui-pierre-diff-frame { min-width:0; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; }
.sui-pierre-diff { --diffs-font-family:${t.fontMono}; --diffs-header-font-family:${t.fontSans}; --diffs-light-bg:${t.card}; --diffs-dark-bg:${t.card}; --diffs-light:${t.foreground}; --diffs-dark:${t.foreground}; --diffs-addition-color:${t.success}; --diffs-deletion-color:${t.destructive}; --diffs-bg-addition-override:${t.successSoft}; --diffs-bg-deletion-override:${t.destructiveSoft}; --diffs-bg-context-override:${t.surface2}; --diffs-bg-separator-override:${t.surface2}; --diffs-fg-number-override:${t.mutedForeground}; display:block; min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; overflow:hidden; }
.sui-pierre-diff-empty { padding:24px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; text-align:center; color:${t.mutedForeground}; font-size:13px; }
`;

/*
 * The code-view adapter (`adapters/code-view`): one file on the same pierre
 * engine. The frame follows the house CODE tokens on both theme axes so a
 * file card reads like the app's other code, and pierre's own background
 * variables point at the same token. The plain `<pre>` is the complete state
 * until pierre has painted; the adapter flips `data-state` and the sheet
 * hides the fallback.
 */
export const codeViewCss = `
.sui-code-view { --diffs-font-family:${t.fontMono}; --diffs-light-bg:${t.codeBg}; --diffs-dark-bg:${t.codeBg}; --diffs-light:${t.codeText}; --diffs-dark:${t.codeText}; --diffs-fg-number-override:${t.mutedForeground}; display:block; min-width:0; border-radius:${t.radius}; background:${t.codeBg}; color:${t.codeText}; overflow:hidden; }
.sui-code-view > diffs-container { display:block; min-width:0; }
.sui-code-view-plain { margin:0; padding:12px 14px; font-family:${t.fontMono}; font-size:12px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4; }
.sui-code-view[data-state="ready"] > .sui-code-view-plain { display:none; }
`;

/* -------------------------------------------------------------------------- */
/* StageStrip: horizontal pipeline-stage chips                                */
/* -------------------------------------------------------------------------- */

export const stageStripCss = `
.sui-stage-strip { min-width:0; display:grid; gap:8px; }
.sui-stage-strip-summary { display:flex; align-items:baseline; gap:6px; min-width:0; }
.sui-stage-strip-summary-label { color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-stage-strip-summary-count { color:${t.foreground}; font-size:12px; font-variant-numeric:tabular-nums; }
.sui-stage-strip-chips { display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-width:0; }
.sui-stage-chip { flex:0 0 auto; text-transform:none; letter-spacing:0; }
`;

export const agenticReasoningCss = `
.sui-reasoning { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-reasoning-trigger { width:100%; min-width:0; display:flex; align-items:center; gap:8px; padding:10px 14px; border:0; background:transparent; color:${t.foreground}; font:inherit; text-align:left; cursor:pointer; ${interaction} }
.sui-reasoning-trigger:hover { background:${t.secondary}; }
.sui-reasoning-trigger:focus-visible { ${focusRing} }
.sui-reasoning-chevron { flex:none; display:inline-block; color:${t.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-reasoning-trigger[aria-expanded='true'] .sui-reasoning-chevron { transform:rotate(90deg); }
.sui-reasoning-title { min-width:0; flex:1; font-size:13px; font-weight:650; }
.sui-reasoning-duration { flex:none; color:${t.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-reasoning-body { min-width:0; padding:0 14px 12px; color:${t.mutedForeground}; font-size:13px; line-height:1.5; }
.sui-reasoning-title[data-shimmer='true'], .sui-cot-title[data-shimmer='true'] { background:linear-gradient(90deg, ${t.mutedForeground} 35%, ${t.foreground} 50%, ${t.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }

.sui-cot { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-cot-trigger { width:100%; min-width:0; display:flex; align-items:center; gap:8px; padding:10px 14px; border:0; background:transparent; color:${t.foreground}; font:inherit; text-align:left; cursor:pointer; ${interaction} }
.sui-cot-trigger:hover { background:${t.secondary}; }
.sui-cot-trigger:focus-visible { ${focusRing} }
.sui-cot-chevron { flex:none; display:inline-block; color:${t.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-cot-trigger[aria-expanded='true'] .sui-cot-chevron { transform:rotate(90deg); }
.sui-cot-title { min-width:0; flex:1; font-size:13px; font-weight:650; }
.sui-cot-body { min-width:0; padding:0 14px 12px; }
.sui-cot-steps { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
.sui-cot-step { position:relative; min-width:0; display:grid; grid-template-columns:12px minmax(0, 1fr); column-gap:8px; align-items:start; color:${t.foreground}; font-size:13px; line-height:1.45; }
.sui-cot-step::before { content:""; position:absolute; left:5px; top:13px; bottom:-9px; border-left:1px solid ${t.border}; }
.sui-cot-step:last-child::before { display:none; }
.sui-cot-step-dot { position:relative; z-index:1; width:10px; height:10px; margin-top:4px; border:2px solid ${t.card}; border-radius:${t.radiusFull}; background:color-mix(in srgb, ${t.mutedForeground} 40%, transparent); }
.sui-cot-step[data-status-class='run'] .sui-cot-step-dot { background:${statusColors.run}; }
.sui-cot-step[data-status-class='ok'] .sui-cot-step-dot { background:${statusColors.ok}; }
.sui-cot-step[data-status-class='warn'] .sui-cot-step-dot { background:${statusColors.warn}; }
.sui-cot-step[data-status-class='bad'] .sui-cot-step-dot { background:${statusColors.bad}; }
.sui-cot-step[data-status-class='muted'] .sui-cot-step-dot { background:${statusColors.muted}; }
.sui-cot-step-label { min-width:0; overflow-wrap:anywhere; }
.sui-cot-step-detail { grid-column:2; min-width:0; margin-top:2px; color:${t.mutedForeground}; font-size:12px; overflow-wrap:anywhere; }

.sui-toolcall { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-toolcall-trigger, .sui-toolcall-header { width:100%; min-width:0; display:flex; align-items:center; gap:8px; padding:8px 12px; }
.sui-toolcall-trigger { border:0; background:transparent; color:${t.foreground}; font:inherit; text-align:left; cursor:pointer; ${interaction} }
.sui-toolcall-trigger:hover { background:${t.secondary}; }
.sui-toolcall-trigger:focus-visible { ${focusRing} }
.sui-toolcall-header { background:${t.secondary}; }
.sui-toolcall-chevron { flex:none; display:inline-block; color:${t.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-toolcall-trigger[aria-expanded='true'] .sui-toolcall-chevron { transform:rotate(90deg); }
.sui-toolcall-name { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; }
.sui-toolcall-approval { min-width:0; padding:10px 12px; border-top:1px solid ${t.border}; }
.sui-toolcall-body { min-width:0; display:grid; gap:10px; padding:10px 12px 12px; border-top:1px solid ${t.border}; }
.sui-toolcall-section { min-width:0; display:grid; gap:6px; }
.sui-toolcall-section-title { color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-toolcall-pre { margin:0; padding:10px 12px; border-radius:${t.radiusControl}; background:${t.codeBg}; color:${t.codeText}; font-family:${t.fontMono}; font-size:12px; line-height:1.5; white-space:pre-wrap; overflow:auto; max-height:320px; }
.sui-toolcall-pre:focus-visible { ${focusRing} }
.sui-toolcall-error { color:${t.destructive}; }
.sui-toolcall[data-layout='expanded'] .sui-toolcall-body { border-top:0; }
`;

/** All component sheets, composed in a stable order. */
export const smithersUiCss = [
  sharedCss,
  buttonCss,
  badgeCss,
  cardCss,
  formCss,
  chatCss,
  chatScrollerCss,
  alertCss,
  tableCss,
  tabsCss,
  dialogCss,
  tooltipCss,
  agenticPlanCss,
  selectCss,
  progressCss,
  skeletonCss,
  spinnerCss,
  separatorCss,
  timeCss,
  emptyStateCss,
  sectionHeaderCss,
  rowButtonCss,
  kpiStatCss,
  collapsiblePanelCss,
  diffCss,
  fileTreeCss,
  markdownCss,
  agenticResponseCss,
  agentOutputCss,
  pierreDiffCss,
  codeViewCss,
  stageStripCss,
  agenticReasoningCss,
  conversationFoundationCss,
  promptAttachmentsCss,
  reasoningToolsCss,
  plansTasksQueuesCss,
  approvalsCss,
  sourcesCitationsCss,
  agentsCss,
  artifactsCss,
  sandboxCss,
  canvasCss,
  calendarCss,
  vaultCss,
  reducedMotionCss,
]
  .map((block) => block.trim())
  .join("\n");
