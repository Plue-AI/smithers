/** @jsxImportSource react */
import { DEFAULT_THEME_KEY } from "@smthrs/ui-styleguide";
import { useMemo, type ReactNode } from "react";
import { processPatch, type CodeViewItem, type DiffsThemeNames, type FileDiffMetadata } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { cn } from "../cn";
import { decodeGitPath } from "../diff-paginate";
import { themeRegistry, useInjectUiCss } from "../styles";
import { useResolvedTheme } from "../internal/useResolvedTheme";
import { useResolvedPalette } from "../internal/useResolvedPalette";
import type { ResolvedPalette } from "../internal/resolvePalette";

/**
 * PierreDiffView is the high-fidelity, syntax-highlighted diff surface: it runs
 * a unified patch through `@pierre/diffs` `processPatch` and renders it with the
 * `CodeView` React widget, which tokenizes every line through Shiki. It lives in
 * the `adapters` layer because `@pierre/diffs` is a heavy widget dependency; the
 * base `@smthrs/ui` barrel never pulls it in, so consumers opt in
 * through the `@smthrs/ui/adapters/pierre-diff-view` subpath.
 *
 * The component is fully props-driven with no app coupling. Multi's original
 * carried an app `Theme` import; here an optional `mode` prop overrides the
 * active house theme and maps onto a `DiffsThemeNames` value. Layout is a
 * `layout` prop (`"split"` side-by-side vs `"inline"` unified).
 */

export type PierreDiffMode = "light" | "dark";

/** Side-by-side (`split`) vs a single unified column (`inline`). */
export type PierreDiffLayout = "split" | "inline";

/**
 * Map the theme `mode` onto the Shiki-bundled `DiffsThemeNames` value CodeView
 * expects. Replaces Multi's coupling to the app `Theme` store.
 */
export function diffsThemeForMode(mode: PierreDiffMode, palette: ResolvedPalette = DEFAULT_THEME_KEY): DiffsThemeNames {
  const syntax = themeRegistry[palette].syntax;
  return mode === "dark" ? syntax.shikiDark : syntax.shikiLight;
}

/** Map the layout prop onto CodeView's `diffStyle` option. */
export function diffStyleForLayout(layout: PierreDiffLayout): "split" | "unified" {
  return layout === "inline" ? "unified" : "split";
}

/** A backslash sequence only git's path quoting produces. */
const GIT_ESCAPE_RE = /\\(?:[0-7]{3}|[abtnvfr"\\])/;

/**
 * Normalize a diff path for comparison: decode git's quoted form, then strip a
 * leading `a/` or `b/`.
 *
 * Git quotes a path with a special or non-ASCII byte and octal-escapes those
 * bytes, so `café name.ts` ships as `"a/caf\303\251 name.ts"`. Stripping the
 * quotes without decoding left the escapes in the string, and a caller that
 * selected the real filename never matched. `@pierre/diffs` strips the quotes
 * itself but keeps the escapes, so the decode is driven off the escape grammar
 * rather than off the quotes. A literal backslash in a filename is left alone,
 * because git escapes that as `\\` and the decode maps it back.
 */
export function normalizeDiffPath(path: string | undefined): string {
  const raw = path ?? "";
  const quoted = /^"(.*)"$/.exec(raw);
  const inner = quoted ? quoted[1]! : raw;
  const decoded = quoted || GIT_ESCAPE_RE.test(inner) ? decodeGitPath(inner) : inner;
  return decoded.replace(/^[ab]\//, "");
}

/**
 * Parse a unified patch into the `CodeViewItem[]` CodeView renders, optionally
 * narrowed to a single file by its (normalized) path. `processPatch` runs in
 * throw-on-error mode so a malformed or partially synthesized patch would
 * otherwise throw straight out of render; with no error boundary in the consumer
 * tree that would blank the whole surface, so we degrade honestly to `[]` ("no
 * diff available") instead.
 */
export function patchToCodeViewItems(patch: string, selectedPath?: string | null): CodeViewItem[] {
  if (!patch.trim()) return [];
  let files: FileDiffMetadata[];
  try {
    files = processPatch(patch, "pierre-diff", true).files;
  } catch {
    return [];
  }

  let shown = files;
  if (selectedPath) {
    // `selectedPath` goes through the same normalization as the parsed names,
    // so a caller may pass `a/x.ts`, `b/x.ts`, a bare path, or git's quoted
    // form and still match.
    const wanted = normalizeDiffPath(selectedPath);
    // No fallback: a selection that matches nothing renders the empty state.
    // Falling back to every file, which is what this used to do, answered
    // "show me only this file" with the entire patch.
    shown = files.filter((file) => {
      const path = normalizeDiffPath(file.name);
      const previous = normalizeDiffPath(file.prevName);
      return path === wanted || previous === wanted;
    });
  }

  return shown.map((file) => ({
    id: normalizeDiffPath(file.name) || file.name,
    type: "diff",
    fileDiff: file,
  }));
}

export type PierreDiffViewProps = {
  /** Trusted, static host CSS for the shadow surface; never supplied repository content. */
  unsafeCSS?: string;
  /** A unified diff (git-style) patch string. */
  patch: string;
  /** Side-by-side (`split`, default) or unified (`inline`) rendering. */
  layout?: PierreDiffLayout;
  /** Theme mode mapped onto a `DiffsThemeNames` value. Defaults to the active house theme. */
  mode?: PierreDiffMode;
  /** Palette override. Defaults to the active `data-palette` value. */
  palette?: ResolvedPalette;
  /**
   * When set, only the matching file in a multi-file patch is shown. A
   * selection that matches nothing shows the empty state, never the whole
   * patch. `a/`, `b/`, quoted, and bare spellings all compare equal.
   */
  selectedPath?: string | null;
  /** Extra class on the CodeView (and the empty-state fallback). */
  className?: string;
  /** Message shown when the patch is empty or unparseable. */
  emptyLabel?: ReactNode;
};

export function PierreDiffView({
  patch,
  unsafeCSS,
  layout = "split",
  mode,
  palette,
  selectedPath = null,
  className,
  emptyLabel,
}: PierreDiffViewProps) {
  useInjectUiCss();
  const houseTheme = useResolvedTheme();
  const housePalette = useResolvedPalette();
  const resolvedMode = mode ?? houseTheme;
  const resolvedPalette = palette ?? housePalette;
  const items = useMemo(() => patchToCodeViewItems(patch, selectedPath), [patch, selectedPath]);

  if (items.length === 0) {
    return (
      <div
        className={cn("sui-pierre-diff-empty", className)}
        data-slot="pierre-diff-view"
        data-theme-mode={resolvedMode}
        data-palette={resolvedPalette}
      >
        {emptyLabel ?? "No diff is available for this change."}
      </div>
    );
  }

  /*
   * No `renderHeaderMetadata`: pierre's own file header already prints the
   * per-file `-N +N` counts (`createFileHeaderElement`), so a second stat in
   * the metadata slot showed every count twice.
   */
  return (
    <div
      className="sui-pierre-diff-frame"
      data-slot="pierre-diff-view"
      data-theme-mode={resolvedMode}
      data-palette={resolvedPalette}
    >
      <CodeView
        className={cn("sui-pierre-diff", className)}
        disableWorkerPool
        items={items}
        options={{
          unsafeCSS,
          collapsedContextThreshold: 12,
          diffIndicators: "bars",
          diffStyle: diffStyleForLayout(layout),
          hunkSeparators: "metadata",
          overflow: "wrap",
          stickyHeaders: true,
          theme: diffsThemeForMode(resolvedMode, resolvedPalette),
          themeType: resolvedMode,
        }}
      />
    </div>
  );
}
