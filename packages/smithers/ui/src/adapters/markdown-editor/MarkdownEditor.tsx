/** @jsxImportSource react */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useInsertionEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { crepeThemeCss } from "./crepeTheme.generated";

/**
 * The shared WYSIWYG markdown editor for every Smithers UI, ported from Multi's
 * `files/MarkdownEditor.tsx`. It is a Milkdown Crepe (ProseMirror) editor: the
 * user edits rendered markdown directly, never raw source. This is the single
 * replacement for the three former ad-hoc editors (the docs-driven-development
 * textarea editor, the create-workflow `cw-editor`, and Multi's file editor).
 *
 * It is deliberately generic — props-driven with zero coupling to any app
 * store, router, or draft-reconciliation logic. Two data directions:
 *  - LOCAL edits stream out through `onChange`.
 *  - EXTERNAL updates (multiplayer, resets, programmatic seeds) apply through
 *    the imperative {@link MarkdownEditorHandle.setMarkdown}, which applies changed
 *    ProseMirror ranges and suppresses the resulting
 *    transaction echo so it never loops back out as a local edit.
 *
 * Because the Crepe editor is a heavy `@milkdown/*` dependency it lives in the
 * `adapters/` layer and is imported through the explicit
 * `@smthrs/ui/adapters/markdown-editor` subpath (never the base
 * `index` barrel). Its ProseMirror runtime needs a real layout engine, which
 * `renderToString` and headless DOMs do not have, so where layout is absent the
 * component degrades to a plain, fully controlled `<textarea>` that honours the
 * exact same `value` / `onChange` / `readOnly` / `resetKey` contract and
 * imperative handle.
 *
 * That decision is made by measuring layout ({@link supportsRichTextEditing}),
 * never by matching a user-agent string: a real browser is never downgraded
 * because its UA happens to carry a runtime token, and a test drives the choice
 * explicitly through the `fallback` prop rather than by pretending to be one.
 * A test also supplies its own {@link MarkdownEditorProps.loadEditor}, so the
 * WYSIWYG path -- listener wiring, echo suppression, readonly, teardown -- is
 * exercised without the real ProseMirror runtime.
 *
 * A real initialization failure in a real browser is reported, not swallowed:
 * the component lands in `data-mode="failed"`, renders the seeded textarea so
 * the document stays editable, and calls {@link MarkdownEditorProps.onError}
 * with a stable code and the retained cause.
 */
export type MarkdownEditorHandle = {
  /** The current serialized markdown document. */
  getMarkdown: () => string;
  /**
   * Replace the whole document from an external update. Echo-suppressed: the
   * resulting change does NOT fire `onChange`, so callers can seed multiplayer
   * or reset content without it looping back as a local edit. The rich editor
   * maps selection and undo through changed ranges and retains focus ownership.
   */
  setMarkdown: (markdown: string) => void;
  /**
   * Bring a 1-based source line into view (an outline's heading click). The
   * WYSIWYG document keeps no source lines, so the target is the nearest ATX
   * heading at or above `line`, matched by text in the rendered document; the
   * textarea fallback places the caret at the line's start and scrolls to it.
   * Returns false when nothing is mounted to scroll yet (the editor is still
   * loading) or the line is past the document's end.
   */
  scrollToLine: (line: number) => boolean;
};

/** Stable failure codes reported through {@link MarkdownEditorProps.onError}. */
export type MarkdownEditorErrorCode =
  /** The `@milkdown/*` modules could not be loaded. */
  | "editor-load-failed"
  /** The modules loaded but constructing or creating the editor threw. */
  | "editor-create-failed";

/** A reported editor failure, with the original rejection retained as `cause`. */
export type MarkdownEditorError = {
  readonly code: MarkdownEditorErrorCode;
  readonly cause: unknown;
};

/**
 * The pieces of `@milkdown/*` this adapter drives. Declared as a seam so a
 * caller (a test, a host that bundles its own build) can supply them instead of
 * the default dynamic imports.
 */
export type MarkdownEditorModule = {
  readonly Crepe: new(options: { root: HTMLElement; defaultValue: string; readOnly?: boolean }) => CrepeInstance;
  readonly replaceAll: (markdown: string) => unknown;
  /** Register the synchronous document listener before creation; no debounced snapshots. */
  readonly listenImmediately: (editor: CrepeInstance, handler: (markdown: string) => void) => void;
};

export type MarkdownEditorProps = {
  /**
   * The INITIAL markdown document. After mount, live edits flow through
   * `onChange` (and reseed via `resetKey`/`setMarkdown`), NOT by re-seeding on
   * every `value` change — that would yank the caret mid-typing.
   */
  value: string;
  /** Source line revealed once after each document reset. */
  initialLine?: number;
  /** Fires with the serialized markdown on every local edit. */
  onChange?: (markdown: string) => void;
  /** When true the document is not editable. */
  readOnly?: boolean;
  /**
   * Change this to force the editor to re-seed from `value` and re-initialize
   * (the generic analogue of Multi's per-document `docPath` remount key).
   */
  resetKey?: string | number;
  /** Extra class names on the editor host / fallback textarea. */
  className?: string;
  /** Accessible label, forwarded to the host and fallback textarea. */
  "aria-label"?: string;
  /**
   * Whether Tab and Shift+Tab move focus out of the editor rather than
   * inserting indentation. Defaults to true.
   *
   * ProseMirror binds Tab to "insert indentation", which makes the editor a
   * focus trap: a keyboard user who reaches it can never leave, which fails
   * the accessibility bar. Indentation stays available on the
   * editor's own list and block commands, which is what every editor that
   * ships inside a form does. Set this to false to restore ProseMirror's
   * binding for a surface where the editor is the whole page.
   */
  escapeTabOrder?: boolean;
  /**
   * Force the controlled `<textarea>` (true) or the WYSIWYG editor (false).
   * Defaults to the layout probe in {@link supportsRichTextEditing}.
   */
  fallback?: boolean;
  /**
   * Loads the editor modules. Defaults to the `@milkdown/crepe` and
   * `@milkdown/kit/utils` dynamic imports; supply it to drive the WYSIWYG path
   * from a test or from a host that bundles its own build.
   */
  loadEditor?: () => Promise<MarkdownEditorModule>;
  /**
   * Called when the WYSIWYG editor cannot start. The component has already
   * fallen back to the seeded textarea by the time this fires; the callback is
   * for reporting, not for recovery.
   */
  onError?: (error: MarkdownEditorError) => void;
  /**
   * Called with a rendered link's source `href` (as written in the markdown,
   * not resolved against the page) when it is clicked. Return true when the
   * host handled it: the browser then never follows it. A document's relative
   * links name its own files, which only the host can open; followed by the
   * browser they resolve against the app's URL instead.
   */
  onLinkClick?: (href: string) => boolean;
};

/** Marker attribute on the injected Crepe theme `<style>` (deduped on it). */
export const MARKDOWN_EDITOR_STYLE_ATTR = "data-smithers-markdown-editor";

/** Host chrome for the Crepe editor plus the fallback textarea, namespaced. */
const hostCss = `
.sui-markdown-editor { min-width:0; min-height:0; height:100%; overflow:auto; }
.sui-markdown-editor .milkdown { height:100%; }
.sui-markdown-editor .milkdown .ProseMirror { padding:16px 20px; }
.sui-markdown-editor-fallback { display:block; box-sizing:border-box; width:100%; min-height:180px; height:100%; padding:16px 20px; border:0; outline:none; resize:none; background:transparent; color:inherit; font:inherit; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:13px; line-height:1.6; tab-size:2; }
.sui-markdown-editor-fallback:read-only { cursor:default; }
.sui-markdown-editor[data-readonly] .cm-editor, .sui-markdown-editor[data-readonly] .cm-gutters, .sui-markdown-editor[data-readonly] .cm-activeLine { background:transparent; color:inherit; }
.sui-markdown-editor[data-readonly] .cm-gutter, .sui-markdown-editor[data-readonly] .cm-gutterElement { background:transparent; color:var(--text-muted, inherit); }
.sui-markdown-editor[data-readonly] .milkdown-code-block .tools { display:none; }
.sui-markdown-editor[data-readonly] .cm-content, .sui-markdown-editor[data-readonly] .cm-content * { color:inherit; }
`.trim();

/**
 * KaTeX's bundled font declarations point at files this source-shipping
 * package does not include. Strip those declarations from the emitted sheet
 * so math uses the existing fallback stack without making network requests.
 */
const selfContainedCrepeThemeCss = crepeThemeCss.replace(/@font-face\s*\{[^}]*\}/g, "");

/** The complete self-contained stylesheet the adapter injects: Crepe theme + host chrome. */
export const markdownEditorCss = `${selfContainedCrepeThemeCss}\n${hostCss}`;

/**
 * Browser fallback injector (mirrors `useInjectUiCss` in the base package):
 * idempotently appends the Crepe theme + host chrome to `<head>` so a consumer
 * who never renders {@link MarkdownEditorStyles} still gets a styled editor.
 * No-ops during server rendering.
 */
export function useInjectMarkdownEditorCss(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[${MARKDOWN_EDITOR_STYLE_ATTR}]`)) return;
    const el = document.createElement("style");
    el.setAttribute(MARKDOWN_EDITOR_STYLE_ATTR, "");
    el.textContent = markdownEditorCss;
    document.head.appendChild(el);
  }, []);
}

/** Render the Crepe theme sheet in a `<style>` tag (SSR-safe escape hatch). */
export function MarkdownEditorStyles() {
  // Literal attribute name (JSX cannot use the MARKDOWN_EDITOR_STYLE_ATTR
  // constant here); keep the two in sync — useInjectMarkdownEditorCss dedupes
  // on the same attribute.
  return <style data-smithers-markdown-editor="">{markdownEditorCss}</style>;
}

/** Cached probe result: a document either lays out or it does not. */
let richTextSupport: boolean | undefined;

/**
 * Whether this document has a layout engine, which is what ProseMirror needs to
 * place a caret, measure a selection, and paint a decoration.
 *
 * The probe measures a 20x20 offscreen element: a real browser reports its
 * size, a headless DOM (happy-dom, jsdom) reports zero because it computes no
 * layout, and a server render has no `document` at all. This replaces the
 * user-agent match this module used to carry, which downgraded any real browser
 * whose UA happened to include a runtime token and made the WYSIWYG path
 * unreachable from the package's own suite.
 *
 * The result is cached: it answers a property of the environment, not of a
 * component, and it never changes within one document.
 */
export function supportsRichTextEditing(): boolean {
  if (richTextSupport !== undefined) return richTextSupport;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
  try {
    const probe = document.createElement("div");
    probe.setAttribute(
      "style",
      "position:absolute;top:-9999px;left:-9999px;width:20px;height:20px;visibility:hidden;",
    );
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    richTextSupport = rect.width > 0 && rect.height > 0;
  } catch {
    richTextSupport = false;
  }
  return richTextSupport;
}

/** Layout support never changes within a document, so there is nothing to subscribe to. */
const subscribeToNothing = (): (() => void) => () => {};
/** A server render has no layout engine. */
const noRichTextOnServer = (): boolean => false;

/** The editor state machine: loading the modules, running, or fallen back. */
type EditorState = "loading" | "ready" | "failed";

type CrepeInstance = {
  editor: { action: (command: unknown) => unknown; use?: (plugin: unknown) => unknown };
  getMarkdown?: () => string;
  create: () => Promise<unknown>;
  destroy: () => Promise<unknown>;
  setReadonly: (readOnly: boolean) => unknown;
};

/**
 * Hands Tab back to the browser.
 *
 * The handler runs in the capture phase, above ProseMirror's own keymap, so
 * the editor never sees the key and the document's focus order is the one the
 * page declares. `Escape`-style chords and every other key are untouched.
 *
 * @param event the keyboard event
 */
const releaseTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
};

/** The ATX heading on one source line, or undefined. */
const headingOf = (source: string): { readonly depth: number; readonly text: string } | undefined => {
  const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(source);
  return match ? { depth: match[1]!.length, text: match[2]!.trim() } : undefined;
};

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The rendered heading a 1-based source line lands on: the nearest heading at
 * or above the line, found in the WYSIWYG host by its text (the nth among
 * equal texts, so repeated headings resolve to the right one), falling back to
 * the heading's ordinal when the rendered text differs (inline marks).
 */
const renderedHeadingFor = (host: HTMLElement, markdown: string, line: number): HTMLElement | null | undefined => {
  const lines = markdown.split("\n");
  if (line > lines.length) return undefined;
  let inFence = false;
  const headings: Array<{ text: string; line: number }> = [];
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const source = lines[i]!;
    if (/^\s*(```|~~~)/.test(source)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = headingOf(source);
    if (heading) headings.push({ text: collapse(heading.text), line: i + 1 });
  }
  const target = headings[headings.length - 1];
  if (target === undefined) return null;
  const rendered = [...host.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")];
  const sameText = headings.filter((heading) => heading.text === target.text).length - 1;
  const byText = rendered.filter((element) => collapse(element.textContent ?? "") === target.text)[sameText];
  return byText ?? rendered[headings.length - 1] ?? null;
};

/** Load the rich editor and its transaction adapter only when needed. */
const loadMilkdown = async (): Promise<MarkdownEditorModule> => {
  const [{ Crepe }, { $prose }, { serializerCtx }, { Plugin }, { replaceMarkdown }, { htmlSchema }] = await Promise.all([
    import("@milkdown/crepe"),
    import("@milkdown/kit/utils"),
    import("@milkdown/kit/core"),
    import("@milkdown/kit/prose/state"),
    import("./replaceMarkdown"),
    import("@milkdown/kit/preset/commonmark"),
  ]);
  return {
    Crepe: class extends Crepe {
      constructor({ readOnly, ...options }: { root: HTMLElement; defaultValue: string; readOnly?: boolean }) {
        super(options);
        if (readOnly) this.editor.config(ctx => {
          ctx.update(htmlSchema.key, previous => context => {
            const schema = previous(context);
            return { ...schema, parseMarkdown: { ...schema.parseMarkdown,
              runner: (state, node) => { state.addText(String(node.value ?? "")); } } };
          });
        });
      }
    } as unknown as MarkdownEditorModule["Crepe"],
    replaceAll: replaceMarkdown,
    listenImmediately: (editor, handler) => {
      editor.editor.use?.($prose((ctx) => new Plugin({
        view: () => ({
          update: (view, previous) => {
            if (!previous.doc.eq(view.state.doc)) handler(ctx.get(serializerCtx)(view.state.doc));
          },
        }),
      })));
    },
  };
};

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  {
    value,
    initialLine,
    onChange,
    readOnly = false,
    resetKey,
    className,
    "aria-label": ariaLabel,
    escapeTabOrder = true,
    fallback,
    loadEditor,
    onError,
    onLinkClick,
  },
  ref,
) {
  useInjectMarkdownEditorCss();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const crepeRef = useRef<CrepeInstance | null>(null);
  const readyRef = useRef(false);
  const destructionRef = useRef<Promise<unknown>>(Promise.resolve());
  const replaceAllRef = useRef<MarkdownEditorModule["replaceAll"] | null>(null);
  const suppressEchoRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const loadEditorRef = useRef(loadEditor);
  loadEditorRef.current = loadEditor;
  // The single source of truth for `getMarkdown`; seeded from `value` and
  // updated by every local edit, external `setMarkdown`, and reseed.
  const lastMarkdownRef = useRef(value);

  // Server render and hydration both read the no-layout answer, so the first
  // client tree matches the server's textarea; React then re-renders with the
  // measured answer. A fresh client mount reads the measurement directly.
  const richText = useSyncExternalStore(subscribeToNothing, supportsRichTextEditing, noRichTextOnServer);
  const useFallback = fallback ?? !richText;
  const [fallbackValue, setFallbackValue] = useState(value);
  /**
   * The editor's own lifecycle, reset during render whenever the document or
   * its editability changes. Resetting here rather than in an effect puts the
   * host div back in the tree BEFORE the init effect runs, so a retry after a
   * failure has somewhere to mount.
   */
  const [attempt, setAttempt] = useState<{ key: unknown; readOnly: boolean; state: EditorState }>(() => ({
    key: resetKey,
    readOnly,
    state: "loading",
  }));
  if (!Object.is(attempt.key, resetKey) || attempt.readOnly !== readOnly) {
    setAttempt({ key: resetKey, readOnly, state: "loading" });
  }
  const editorState = attempt.state;

  const currentMarkdown = (): string => {
    const crepe = crepeRef.current;
    if (!crepe || !readyRef.current || crepe.getMarkdown === undefined) return lastMarkdownRef.current;
    try {
      return crepe.getMarkdown();
    } catch {
      // A teardown racing pagehide still has the last emitted Markdown.
      return lastMarkdownRef.current;
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: currentMarkdown,
      setMarkdown: (markdown: string) => {
        if (markdown === lastMarkdownRef.current) return;
        lastMarkdownRef.current = markdown;
        setFallbackValue(markdown);
        const crepe = crepeRef.current;
        const replaceAll = replaceAllRef.current;
        if (!crepe || !readyRef.current || !replaceAll) return;
        suppressEchoRef.current += 1;
        try {
          crepe.editor.action(replaceAll(markdown));
        } finally {
          // The document listener runs within dispatch. End suppression before
          // the next human transaction, even in the same event-loop turn.
          suppressEchoRef.current -= 1;
        }
      },
      scrollToLine: (line: number) => {
        const markdown = lastMarkdownRef.current;
        const textarea = fallbackRef.current;
        if (textarea) {
          const lines = markdown.split("\n");
          if (line < 1 || line > lines.length) return false;
          const offset = lines.slice(0, line - 1).reduce((total, row) => total + row.length + 1, 0);
          textarea.focus();
          textarea.setSelectionRange(offset, offset);
          const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight);
          const rowHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 21;
          textarea.scrollTop = Math.max(0, (line - 1) * rowHeight);
          return true;
        }
        const host = hostRef.current;
        if (!host || !readyRef.current) return false;
        const heading = renderedHeadingFor(host, markdown, line);
        if (heading === undefined) return false;
        host.querySelector<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
        if (heading === null) {
          host.scrollTop = 0;
          return true;
        }
        if (typeof heading.scrollIntoView === "function") heading.scrollIntoView({ block: "start" });
        return true;
      },
    }),
    [],
  );

  // Reseed the document whenever `resetKey` changes (declared BEFORE the
  // editor effect so the fresh markdown is visible when Crepe re-initializes).
  useEffect(() => {
    lastMarkdownRef.current = value;
    setFallbackValue(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (useFallback) return;
    const host = hostRef.current;
    if (!host) return;
    readyRef.current = false;
    const seed = lastMarkdownRef.current;
    let cancelled = false;
    let released = false;
    let crepe: CrepeInstance | null = null;
    let creating: Promise<unknown> | undefined;
    let accessibleContent: MutationObserver | undefined;

    /** Stop callbacks immediately, then destroy once creation has settled. */
    const release = (): void => {
      if (released) return;
      released = true;
      accessibleContent?.disconnect();
      readyRef.current = false;
      crepeRef.current = null;
      replaceAllRef.current = null;
      const editor = crepe;
      crepe = null;
      if (editor) {
        destructionRef.current = Promise.resolve(creating)
          .catch(() => undefined)
          .then(() => editor.destroy())
          .catch(() => undefined); // A failed teardown must not crash recovery or unmount.
      }
    };

    /** Report and degrade: the textarea takes over with the current markdown. */
    const fail = (code: MarkdownEditorErrorCode, cause: unknown): void => {
      if (cancelled || released) return;
      release();
      setFallbackValue(lastMarkdownRef.current);
      setAttempt((previous) =>
        Object.is(previous.key, resetKey) && previous.readOnly === readOnly && previous.state !== "failed"
          ? { ...previous, state: "failed" }
          : previous
      );
      onErrorRef.current?.({ code, cause });
    };

    const initialize = async (): Promise<void> => {
      // A prior editor may still be creating or asynchronously removing its DOM.
      await destructionRef.current;
      if (cancelled) return;
      host.innerHTML = "";
      let modules: MarkdownEditorModule;
      try {
        modules = await (loadEditorRef.current ?? loadMilkdown)();
      } catch (cause) {
        fail("editor-load-failed", cause);
        return;
      }
      if (cancelled) return;
      try {
        const { Crepe, replaceAll, listenImmediately } = modules;
        replaceAllRef.current = replaceAll;
        const editor = new Crepe({ root: host, defaultValue: seed, readOnly });
        crepe = editor;
        crepeRef.current = editor;
        // Milkdown's debounced listener can retain a pre-peer transaction:
        // addToHistory=false replacements do not update its pending snapshot.
        // Publish solely from the current ProseMirror document during dispatch.
        listenImmediately(editor, (markdown) => {
          if (released || !readyRef.current || suppressEchoRef.current > 0 || markdown === lastMarkdownRef.current) return;
          lastMarkdownRef.current = markdown;
          onChangeRef.current?.(markdown);
        });
        creating = Promise.resolve(editor.create());
        await creating;
        if (cancelled) return;
        editor.setReadonly(readOnly);
        if (lastMarkdownRef.current !== seed) {
          suppressEchoRef.current += 1;
          try {
            editor.editor.action(replaceAll(lastMarkdownRef.current));
          } finally {
            suppressEchoRef.current -= 1;
          }
        }
        readyRef.current = true;
        const labelContent = () => {
          for (const content of host.querySelectorAll<HTMLElement>('.ProseMirror,[role="textbox"]')) {
            const label = content.classList.contains("ProseMirror") ? ariaLabel : "Code";
            if (label && content.getAttribute("aria-label") !== label) content.setAttribute("aria-label", label);
            if (content.getAttribute("aria-readonly") !== String(readOnly)) content.setAttribute("aria-readonly", String(readOnly));
          }
        };
        labelContent();
        accessibleContent = new MutationObserver(labelContent);
        accessibleContent.observe(host, { childList: true, subtree: true });
        if (initialLine !== undefined) {
          const heading = renderedHeadingFor(host, lastMarkdownRef.current, initialLine);
          heading?.scrollIntoView?.({ block: "start" });
        }
        setAttempt((previous) =>
          Object.is(previous.key, resetKey) && previous.readOnly === readOnly && previous.state === "loading"
            ? { ...previous, state: "ready" }
            : previous
        );
      } catch (cause) {
        fail("editor-create-failed", cause);
      }
    };
    void initialize();

    return () => {
      cancelled = true;
      release();
    };
    // Re-init only when the doc reseeds or editability changes; content
    // updates flow through the listener + setMarkdown, never by recreating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, readOnly, useFallback]);

  const followLink = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!onLinkClick || !(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (anchor === null || !event.currentTarget.contains(anchor)) return;
    if (onLinkClick(anchor.getAttribute("href") ?? "")) event.preventDefault();
  };

  const onFallbackInput = (next: string) => {
    if (next === lastMarkdownRef.current) return;
    lastMarkdownRef.current = next;
    setFallbackValue(next);
    onChangeRef.current?.(next);
  };

  if (useFallback || editorState === "failed") {
    return (
      <textarea
        ref={fallbackRef}
        className={className ? `sui-markdown-editor-fallback ${className}` : "sui-markdown-editor-fallback"}
        data-slot="markdown-editor"
        data-testid="markdown-editor"
        // `fallback` is the deliberate degradation (no layout engine, or the
        // caller asked for it); `failed` is the editor that tried and could
        // not start. A host that only wants to know "is this the real editor"
        // still reads `data-mode !== "wysiwyg"`.
        data-mode={useFallback ? "fallback" : "failed"}
        // A textarea never bound Tab, so the fallback already has the
        // document's focus order; the attribute reports the same setting
        // either way so a host can assert one thing.
        data-escape-tab-order={escapeTabOrder ? "true" : "false"}
        aria-label={ariaLabel}
        readOnly={readOnly}
        value={fallbackValue}
        onChange={(event) => onFallbackInput(event.currentTarget.value)}
      />
    );
  }

  return (
    <div
      className={className ? `sui-markdown-editor ${className}` : "sui-markdown-editor"}
      data-slot="markdown-editor"
      data-testid="markdown-editor"
      data-mode="wysiwyg"
      data-readonly={readOnly || undefined}
      data-escape-tab-order={escapeTabOrder ? "true" : "false"}
      aria-label={ariaLabel}
      ref={hostRef}
      onKeyDownCapture={escapeTabOrder ? releaseTab : undefined}
      onClick={followLink}
      onAuxClick={followLink}
    />
  );
});
