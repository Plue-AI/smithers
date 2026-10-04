/** @jsxImportSource react */
import { useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { getFiletypeFromFileName, type FileOptions, type LineAnnotation } from "@pierre/diffs";
import { File, WorkerPoolContext, useStableCallback } from "@pierre/diffs/react";
import { cn } from "../../cn";
import { useInjectUiCss } from "../../styles";
import { useResolvedTheme } from "../../internal/useResolvedTheme";
import { useResolvedPalette } from "../../internal/useResolvedPalette";
import type { ResolvedPalette } from "../../internal/resolvePalette";
import { diffsThemeForMode, type PierreDiffMode } from "../pierre-diff-view";
import { codeViewWorkerPool, currentCodeViewPool, subscribeCodeViewPool } from "./workerPool";

/**
 * CodeFileView renders ONE repository file, syntax highlighted, through
 * `@pierre/diffs` `File` (Shiki underneath). It is the read-only file surface
 * the diff view already runs on, so files and diffs share one engine, one
 * theme mapping (`diffsThemeForMode`, fourteen Shiki ids for the nine
 * palettes) and one grammar registry. It lives in the `adapters` layer
 * because `@pierre/diffs` is heavy; consumers opt in through
 * `@smthrs/ui/adapters/code-view`, and the base barrel never reaches it.
 *
 * Plain text is a complete state. pierre paints nothing until the grammar and
 * the theme have loaded, so the view carries the file as a plain `<pre>` and
 * hides it (`data-state="ready"`) on the first render that has lines. The
 * flip and the scroll to the anchored line are DOM work inside pierre's own
 * `onPostRender` callback and a keyed sentinel's ref callback: no effect, no
 * component state.
 *
 * Highlighting runs in pierre's worker pool (workerPool.ts) wherever a
 * Worker exists. It is not cheap on the main thread: Shiki's JavaScript
 * regex engine compiles the grammar inside the first synchronous tokenize,
 * measured at 2.6 s for a 16 KiB TypeScript file under JavaScriptCore (the
 * native shell) and ~300 ms once warm, 436 ms / ~70 ms in Chromium. Off the
 * pool — no Worker, or a pool that failed its probe — the view still renders
 * on the main thread, plain text first.
 *
 * One pierre instance per view for its life: the anchor is pierre's
 * controlled `selectedLines`, and the scroll to a new anchor runs from the
 * sentinel's ref callback, so moving the anchor never remounts pierre and
 * never tokenizes the file again (a remount paid the whole tokenize and
 * flashed the plain text in between).
 *
 * Code intelligence (apps/app/docs/code-intel/PLAN.md §5) enters through three
 * props and no state: `annotations` render under their lines as light-DOM
 * children pierre slots into the shadow root; a pointer at rest on a token
 * for `restMs` is one `onTokenRest`; ⌘/Ctrl-click on a token is one
 * `onTokenActivate`. Positions are 1-based, the LSP wire's convention. The
 * rest timer is pierre's own token enter/leave pair plus a timeout held in a
 * ref, cleared on leave and on unmount through the frame's ref callback.
 */

/** The theme axis the view follows, the same two values the diff view takes. */
export type CodeViewMode = PierreDiffMode;

/**
 * The grammar id pierre infers from a file name, or null when it would fall
 * back to plain text. A caller that would rather keep its own `<pre>` for an
 * unknown language asks this before mounting the view.
 */
export function languageForFile(name: string): string | null {
  if (name === "") return null;
  const language = getFiletypeFromFileName(name);
  return language === "text" ? null : language;
}

/** A token the pointer named: its 1-based line and column (the token's first character) and its text. */
export interface CodeTokenPosition {
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/** Content rendered under a line (1-based); `key` keeps React and pierre from redrawing an unchanged one. */
export interface CodeLineAnnotation {
  readonly key: string;
  readonly line: number;
  readonly node: ReactNode;
}

type AnnotationMeta = { readonly key: string; readonly node: ReactNode };

/** The default pointer rest before a token counts as hovered. */
export const CODE_VIEW_REST_MS = 300;

export type CodeFileViewProps = {
  /** The file's name or repository path: the grammar comes from its extension. */
  name: string;
  /** The file's text. */
  contents: string;
  /**
   * A 1-based line to anchor: it is marked as the selected line and scrolled
   * to the middle of the nearest scrolling ancestor once it exists. Changing
   * it moves the mark and scrolls again; omitting it clears the mark.
   */
  line?: number | undefined;
  /** Theme mode. Defaults to the active house theme (`data-theme` on the root). */
  mode?: CodeViewMode | undefined;
  /** Palette override. Defaults to the active `data-palette` value. */
  palette?: ResolvedPalette | undefined;
  /** Use full-contrast inherited text when syntax colours cannot meet the host contrast requirement. */
  monochrome?: boolean | undefined;
  /** Extra class on the frame. */
  className?: string | undefined;
  /** Rendered under their lines; the consumer memoizes the array, a new one redraws pierre's rows. */
  annotations?: ReadonlyArray<CodeLineAnnotation> | undefined;
  /** The pointer rested on a token for `restMs`; fires once per token entered. */
  onTokenRest?: ((token: CodeTokenPosition) => void) | undefined;
  /** How long the pointer rests before `onTokenRest`; defaults to CODE_VIEW_REST_MS. */
  restMs?: number | undefined;
  /** ⌘-click (macOS) or Ctrl-click on a token. */
  onTokenActivate?: ((token: CodeTokenPosition) => void) | undefined;
};

/**
 * The nearest ancestor that owns a scrollbar. The walk takes the first
 * `overflow-y: auto | scroll` element whether or not it overflows right now:
 * that element is the designated scroller, and going past it to the page
 * would scroll a whole transcript to show one line.
 */
const nearestScroller = (from: HTMLElement): HTMLElement | null => {
  for (let element = from.parentElement; element != null; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll") return element;
  }
  return null;
};

/** Scroll `line` to the middle of the nearest scroller. Answers false while pierre has not rendered the line yet. */
const revealLine = (host: HTMLElement, line: number): boolean => {
  const target = host.shadowRoot?.querySelector<HTMLElement>(`[data-line="${line}"]`);
  if (target == null) return false;
  const scroller = nearestScroller(host);
  if (scroller == null) return true;
  const row = target.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (row.height === 0 && box.height === 0) return true;
  const visible = row.top >= box.top && row.bottom <= box.bottom;
  if (!visible) scroller.scrollTop += row.top - box.top - (box.height - row.height) / 2;
  return true;
};

export function CodeFileView({
  monochrome = false,
  name,
  contents,
  line,
  mode,
  palette,
  className,
  annotations,
  onTokenRest,
  restMs = CODE_VIEW_REST_MS,
  onTokenActivate,
}: CodeFileViewProps) {
  useInjectUiCss();
  const houseTheme = useResolvedTheme();
  const housePalette = useResolvedPalette();
  const resolvedMode = mode ?? houseTheme;
  const resolvedPalette = palette ?? housePalette;
  const language = languageForFile(name);
  const file = useMemo(() => ({ name, contents }), [name, contents]);
  const selectedLines = useMemo(() => (line === undefined ? null : { start: line, end: line }), [line]);
  const theme = diffsThemeForMode(resolvedMode, resolvedPalette);

  /*
   * The worker pool, started on the first view and told this view's theme
   * (pierre renders every pooled file with the pool's theme). The live state
   * is an external store: a pool that fails its probe flips `manager` to
   * undefined, and the `key` below remounts pierre on the main thread.
   */
  codeViewWorkerPool(theme);
  const pool = useSyncExternalStore(subscribeCodeViewPool, currentCodeViewPool, currentCodeViewPool);
  const manager = pool.state === "starting" || pool.state === "ready" ? pool.manager : undefined;

  /*
   * The anchor last scrolled to. pierre calls onPostRender on the passes
   * that touch the DOM (mount, the highlight landing, a theme change) and
   * not on a selection-only update, so the first reveal rides onPostRender
   * (the pass where the line first exists) and every later anchor rides the
   * sentinel below, whose ref callback runs on each anchor change after
   * pierre's layout effect has applied the new selection.
   */
  const revealed = useRef<number | null>(null);

  const onPostRender = useStableCallback((node: HTMLElement) => {
    if (node.shadowRoot?.querySelector("[data-line]") == null) return;
    node.parentElement?.setAttribute("data-state", "ready");
    if (line === undefined) {
      revealed.current = null;
      return;
    }
    if (revealed.current !== line && revealLine(node, line)) revealed.current = line;
  });

  const revealFromSentinel = (sentinel: HTMLElement | null): void => {
    if (sentinel === null) return;
    if (line === undefined) {
      revealed.current = null;
      return;
    }
    const container = sentinel.parentElement?.querySelector<HTMLElement>("diffs-container");
    if (container != null && revealed.current !== line && revealLine(container, line)) revealed.current = line;
  };

  /*
   * The pointer-rest timer. pierre reports token enter and leave from its own
   * pointer listeners inside the shadow root; the view arms one timeout on
   * enter and disarms it on leave, so a pointer crossing tokens fires for
   * the token it stops on and no other. The ref outlives renders; the frame's
   * ref callback disarms it on unmount.
   */
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = (): void => {
    if (rest.current !== null) clearTimeout(rest.current);
    rest.current = null;
  };
  const onTokenEnter = useStableCallback((token: { lineNumber: number; lineCharStart: number; tokenText: string }) => {
    disarm();
    if (onTokenRest === undefined) return;
    rest.current = setTimeout(() => {
      rest.current = null;
      onTokenRest({ line: token.lineNumber, column: token.lineCharStart + 1, text: token.tokenText });
    }, restMs);
  });
  const onTokenLeave = useStableCallback(() => disarm());
  const onTokenClick = useStableCallback(
    (token: { lineNumber: number; lineCharStart: number; tokenText: string }, event: MouseEvent) => {
      if (onTokenActivate === undefined || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      onTokenActivate({ line: token.lineNumber, column: token.lineCharStart + 1, text: token.tokenText });
    },
  );
  const interactive = onTokenRest !== undefined || onTokenActivate !== undefined;

  /*
   * Stable across renders: pierre compares options by key identity and a new
   * object per render would force a full re-render of the code on every
   * React pass. Only the theme axis and the gesture handlers' presence
   * rebuild it. `useTokenTransformer` is what makes pierre mark every token
   * with its column (`data-char`) and keep whitespace out of tokens, which
   * the token events need; it is on only when a gesture is bound.
   */
  const options = useMemo<FileOptions<AnnotationMeta>>(
    () => ({
      theme,
      themeType: resolvedMode,
      disableFileHeader: true,
      // Paper ink keeps Night Owl Light tokens above AA contrast; monochrome replaces syntax colour entirely.
      unsafeCSS: monochrome ? "[data-line] span { color: var(--code-text, currentColor) !important; }" : resolvedMode === "light" ? 'span[style*="color:#4876D6"] { color: var(--lane-1, var(--diffs-light)) !important; } span[style*="color:#C96765"] { color: var(--danger, var(--diffs-light)) !important; }' : undefined,
      overflow: "wrap",
      enableLineSelection: false,
      onPostRender,
      ...(interactive ? { useTokenTransformer: true, onTokenEnter, onTokenLeave, onTokenClick } : {}),
    }),
    [theme, resolvedMode, monochrome, onPostRender, interactive, onTokenEnter, onTokenLeave, onTokenClick],
  );

  const lineAnnotations = useMemo<LineAnnotation<AnnotationMeta>[] | undefined>(
    () =>
      annotations === undefined || annotations.length === 0
        ? undefined
        : annotations.map((annotation) => ({ lineNumber: annotation.line, metadata: { key: annotation.key, node: annotation.node } })),
    [annotations],
  );

  return (
    <div
      ref={(node) => {
        if (node === null) disarm();
      }}
      className={cn("sui-code-view", className)}
      data-slot="code-view"
      data-theme-mode={resolvedMode}
      data-palette={resolvedPalette}
      data-language={language ?? "text"}
      data-interactive={interactive ? "" : undefined}
      data-highlighter={manager === undefined ? "main-thread" : "worker"}
    >
      <pre className="sui-code-view-plain">{contents}</pre>
      <WorkerPoolContext.Provider value={manager}>
        <File<AnnotationMeta>
          key={manager === undefined ? "main-thread" : "worker"}
          file={file}
          selectedLines={selectedLines}
          options={options}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          disableWorkerPool={manager === undefined}
        />
      </WorkerPoolContext.Provider>
      <span key={line ?? "unanchored"} hidden ref={revealFromSentinel} data-slot="code-view-anchor" />
    </div>
  );
}

/** The annotation's own node; pierre wraps it in the slotted `<div>` the shadow row shows. */
const renderAnnotation = (annotation: LineAnnotation<AnnotationMeta>): ReactNode => (
  <div key={annotation.metadata.key} className="sui-code-view-annotation" data-slot="code-view-annotation">
    {annotation.metadata.node}
  </div>
);
