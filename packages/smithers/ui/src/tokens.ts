/**
 * The shadcn-style semantic token bridge onto the Smithers ui-styleguide theme.
 *
 * Every value is a `var(--house-token, #lightFallback)` expression:
 *
 * - When the workflow UI style guide is present (the gateway host page inlines
 *   `workflowUiThemeCss` into every `/workflows/<key>` page, and
 *   `SmithersUiStyles withTheme` covers standalone hosts), the values resolve
 *   through the house custom properties and follow the active theme: OS
 *   `prefers-color-scheme` plus an explicit `data-theme="dark|light"` stamp on
 *   `<html>` (settable via the host page's `?theme=` query param). The
 *   `data-theme` override always wins over the media query.
 * - Without the style guide, the fallbacks reproduce the exact light values,
 *   so components render sensibly standalone with no CSS loader. The light
 *   values are the generated Paper light theme in
 *   `ui-styleguide/src/themes/paper.ts`; when that file is regenerated,
 *   the fallbacks here follow it.
 *
 * INVARIANTS (enforced by tests/css-contract.test.ts):
 *
 * - This package NEVER emits a `:root { ... }` token block. The styleguide
 *   already defines page-global `--primary`/`--accent`/`--muted` aliases with
 *   different semantics than shadcn's; redefining shadcn's canonical tokens at
 *   the root would silently recolor every legacy `.pill`/`.badge`/`.button` in
 *   the same document. The bridge lives only in these var() expressions.
 * - Never string-concatenate an alpha suffix onto a token. Use the shared
 *   semantic `*Soft`/`*Border` tokens where they apply; custom tints must use
 *   `color-mix(in srgb, ...)`, matching the house recipes byte-for-byte.
 */
export const tokens = {
  /** Page background. */
  background: "var(--bg, #f7f4ee)",
  /** Default text color. */
  foreground: "var(--text, #211d18)",
  /** Card / panel / popover surface. */
  card: "var(--surface, #fffefa)",
  cardForeground: "var(--text, #211d18)",
  /** Raised surface one step below card (insets, secondary fills). */
  surface2: "var(--surface-2, #efeae0)",
  /** Overlay surface (popovers, dialogs). */
  surface3: "var(--surface-3, #fffefa)",
  /** Frosted surfaces used by the floating Multi-style chat composer. */
  glass: "var(--surface-glass, rgba(255, 254, 250, 0.72))",
  glassStrong: "var(--surface-glass-strong, rgba(255, 254, 250, 0.85))",
  popover: "var(--surface-3, #fffefa)",
  popoverForeground: "var(--text, #211d18)",
  /** Brand color. The house "primary" button is TINTED (10% brand surface + brand text), not solid. */
  primary: "var(--brand, #0f766e)",
  /** Tinted brand surface/border for soft emphasis (chips, active rows). */
  primarySoft: "var(--brand-soft, color-mix(in srgb, var(--brand, #0f766e) 10%, var(--surface, #fffefa)))",
  primarySoftStrong: "var(--brand-soft-strong, color-mix(in srgb, var(--brand, #0f766e) 16%, var(--surface, #fffefa)))",
  primaryBorder: "var(--brand-border, color-mix(in srgb, var(--brand, #0f766e) 40%, transparent))",
  /**
   * Text on solid brand fills. --inverse-text is white in light mode and near
   * black in dark mode, which tracks the brand value getting lighter in dark.
   */
  primaryForeground: "var(--inverse-text, #f7f4ee)",
  /** Subtle raised surface (hover states, secondary buttons, muted fills). */
  secondary: "var(--hover, #efeae0)",
  secondaryForeground: "var(--text, #211d18)",
  muted: "var(--hover, #efeae0)",
  mutedForeground: "var(--text-muted, #665f54)",
  /**
   * shadcn's "accent" = the hover fill. Trap: the styleguide's page-global
   * `--accent` alias is the BRAND color -- same word, different color. This
   * bridge deliberately does NOT read `--accent`.
   */
  accent: "var(--hover, #efeae0)",
  accentForeground: "var(--text, #211d18)",
  destructive: "var(--danger, #a4442a)",
  destructiveSoft: "var(--danger-soft, color-mix(in srgb, var(--danger, #a4442a) 10%, var(--surface, #fffefa)))",
  destructiveBorder: "var(--danger-border, color-mix(in srgb, var(--danger, #a4442a) 40%, transparent))",
  success: "var(--success, #0b5b57)",
  successSoft: "var(--success-soft, color-mix(in srgb, var(--success, #0b5b57) 10%, var(--surface, #fffefa)))",
  successBorder: "var(--success-border, color-mix(in srgb, var(--success, #0b5b57) 40%, transparent))",
  warning: "var(--warning, #8c5a08)",
  warningSoft: "var(--warning-soft, color-mix(in srgb, var(--warning, #8c5a08) 10%, var(--surface, #fffefa)))",
  warningBorder: "var(--warning-border, color-mix(in srgb, var(--warning, #8c5a08) 40%, transparent))",
  info: "var(--info, #3c6879)",
  infoSoft: "var(--info-soft, color-mix(in srgb, var(--info, #3c6879) 10%, var(--surface, #fffefa)))",
  infoBorder: "var(--info-border, color-mix(in srgb, var(--info, #3c6879) 40%, transparent))",
  /** Hairline borders. */
  border: "var(--border, rgba(33, 29, 24, 0.08))",
  borderStrong: "var(--border-strong, rgba(33, 29, 24, 0.14))",
  /** Form control borders (slightly stronger). */
  input: "var(--border-solid, #e4ddcf)",
  /**
   * Focus ring fill; pair with a 50% brand border-color (the house focus
   * rule). Routed through the styleguide's `--ring`/`--ring-border` custom
   * properties so a host that themes the ring re-themes these components too.
   */
  ring: "var(--ring, color-mix(in srgb, var(--brand, #0f766e) 22%, transparent))",
  ringBorder: "var(--ring-border, color-mix(in srgb, var(--brand, #0f766e) 50%, transparent))",
  /** Extra-subtle fill for chips and hover washes. */
  hoverSubtle: "var(--hover-subtle, rgba(33, 29, 24, 0.03))",
  /** Faint text (placeholders use --text-placeholder). */
  textFaint: "var(--text-faint, #6c655a)",
  placeholder: "var(--text-placeholder, #6d665b)",
  /** Inverse surface/text (tooltips, "ink" chips). */
  inverseBg: "var(--inverse-bg, #211d18)",
  inverseText: "var(--inverse-text, #f7f4ee)",
  /** Code block colors. */
  codeBg: "var(--code-bg, #efeae0)",
  codeText: "var(--code-text, #211d18)",
  /** Shadow base as space-separated RGB channels, for `rgb(${tokens.shadowRgb} / a)`. */
  shadowRgb: "var(--shadow-rgb, 33 29 24)",
  /**
   * Elevation shadows, routed through the styleguide's `--shadow-*` custom
   * properties so dark mode gets the stronger house alphas (a fixed light
   * alpha is nearly invisible on dark surfaces) and hosts can theme them.
   */
  shadow1: "var(--shadow-1, 0 1px 2px rgb(33 29 24 / 0.04), 0 1px 3px rgb(33 29 24 / 0.06))",
  shadow2: "var(--shadow-2, 0 1px 2px rgb(33 29 24 / 0.04), 0 12px 32px rgb(33 29 24 / 0.1))",
  shadow3: "var(--shadow-3, 0 4px 12px rgb(33 29 24 / 0.1), 0 16px 48px rgb(33 29 24 / 0.14))",
  /** Card corner radius. Controls use `radiusControl`; chat surfaces use `radiusBubble`. */
  radius: "var(--r-2, 10px)",
  radiusControl: "var(--r-1, 6px)",
  radiusBubble: "var(--r-bubble, 18px)",
  radiusFull: "var(--r-full, 999px)",
  /** Shared control height (buttons, inputs, selects, triggers). */
  controlHeight: "var(--ctl-h, 32px)",
  /** Compact UI copy: the documented 12px type-scale step. */
  fontSizeCompact: "var(--fs-2, 12px)",
  /**
   * Font stacks routed through the styleguide's `--font-sans`/`--font-mono`
   * so hosts can theme typography; fallbacks are the canonical house stacks
   * and must stay byte-equal to the `@smthrs/ui-styleguide` light values
   * (pinned by tests/css-contract.test.ts).
   */
  fontSans:
    "var(--font-sans, Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)",
  fontMono: "var(--font-mono, ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace)",
} as const;

export type SmithersUiTokens = typeof tokens;
