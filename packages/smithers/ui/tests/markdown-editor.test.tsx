// The shared Milkdown Crepe markdown-editor adapter under happy-dom.
//
// Crepe is a ProseMirror editor with no layout engine under happy-dom (the
// same reason the CodeView adapter can't paint here), so the component renders
// its controlled `<textarea>` fallback in this environment. That fallback
// honours the exact value/onChange/readOnly/resetKey contract and imperative
// handle, so these tests exercise the whole public surface off the real editor.
// The DOM comes from tests/happy-dom-preload.ts (bunfig `[test] preload`).
import { afterEach, describe, expect, test } from "bun:test";
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MARKDOWN_EDITOR_STYLE_ATTR,
  MarkdownEditor,
  type MarkdownEditorHandle,
  type MarkdownEditorModule,
  MarkdownEditorStyles,
  markdownEditorCss,
} from "../src/adapters/markdown-editor";
import { themeRegistry } from "../src/styles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${MARKDOWN_EDITOR_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const r = root;
  await act(async () => r.render(element));
}

async function rerender(element: ReactElement): Promise<void> {
  const r = root;
  if (!r) throw new Error("nothing rendered yet");
  await act(async () => r.render(element));
}

function editor(): HTMLTextAreaElement {
  const el = container?.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]');
  if (!el) throw new Error("markdown editor not found");
  return el;
}

/** Type into a controlled textarea the way React expects (value tracker + event). */
async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("MarkdownEditor (fallback path)", () => {
  test("renders the initial value and round-trips through the imperative getter", async () => {
    let handle: MarkdownEditorHandle | null = null;
    await render(
      <MarkdownEditor
        ref={(h) => {
          handle = h;
        }}
        value="# Hello world"
      />,
    );
    const el = editor();
    expect(el.tagName).toBe("TEXTAREA");
    expect(el.getAttribute("data-mode")).toBe("fallback");
    expect(el.value).toBe("# Hello world");
    expect(handle).not.toBeNull();
    expect((handle as unknown as MarkdownEditorHandle).getMarkdown()).toBe("# Hello world");
  });

  test("fires onChange with the edited markdown and reflects it in getMarkdown", async () => {
    const changes: string[] = [];
    let handle: MarkdownEditorHandle | null = null;
    await render(
      <MarkdownEditor
        ref={(h) => {
          handle = h;
        }}
        value="start"
        onChange={(md) => changes.push(md)}
      />,
    );
    await type(editor(), "start and more");
    expect(changes).toEqual(["start and more"]);
    expect(editor().value).toBe("start and more");
    expect((handle as unknown as MarkdownEditorHandle).getMarkdown()).toBe("start and more");
  });

  test("readOnly disables editing on the fallback textarea", async () => {
    await render(<MarkdownEditor value="frozen" readOnly />);
    expect(editor().readOnly).toBe(true);
    await rerender(<MarkdownEditor value="frozen" />);
    expect(editor().readOnly).toBe(false);
  });

  test("resetKey re-seeds content while value alone does not", async () => {
    const changes: string[] = [];
    let handle: MarkdownEditorHandle | null = null;
    const view = (value: string, resetKey: number): ReactElement => (
      <MarkdownEditor
        ref={(h) => {
          handle = h;
        }}
        value={value}
        resetKey={resetKey}
        onChange={(md) => changes.push(md)}
      />
    );
    await render(view("alpha", 0));
    expect(editor().value).toBe("alpha");

    await type(editor(), "edited by user");
    expect(editor().value).toBe("edited by user");

    // Same resetKey, new value: the initial value must NOT clobber live edits.
    await rerender(view("beta", 0));
    expect(editor().value).toBe("edited by user");

    // New resetKey: re-seed from value, without echoing onChange.
    changes.length = 0;
    await rerender(view("gamma", 1));
    expect(editor().value).toBe("gamma");
    expect((handle as unknown as MarkdownEditorHandle).getMarkdown()).toBe("gamma");
    expect(changes).toEqual([]);
  });

  test("setMarkdown applies external content without echoing onChange", async () => {
    const changes: string[] = [];
    let handle: MarkdownEditorHandle | null = null;
    await render(
      <MarkdownEditor
        ref={(h) => {
          handle = h;
        }}
        value="one"
        onChange={(md) => changes.push(md)}
      />,
    );
    const h = handle as unknown as MarkdownEditorHandle;
    await act(async () => {
      h.setMarkdown("two");
    });
    expect(editor().value).toBe("two");
    expect(h.getMarkdown()).toBe("two");
    expect(changes).toEqual([]);

    // No-op when the content is unchanged.
    await act(async () => {
      h.setMarkdown("two");
    });
    expect(changes).toEqual([]);
  });
});

describe("MarkdownEditor scrollToLine (fallback path)", () => {
  test("places the caret at the line's start, scrolls the textarea to it, and refuses a line past the end", async () => {
    let handle: MarkdownEditorHandle | null = null;
    await render(
      <MarkdownEditor
        ref={(h) => {
          handle = h;
        }}
        value={"# Plans\n\nSee the world.\n\n## Next\n\nShip."}
      />,
    );
    const textarea = container?.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]');
    if (!textarea) throw new Error("textarea not found");
    const scrolled = handle!.scrollToLine(5);
    expect(scrolled).toBe(true);
    // "# Plans\n" (8) + "\n" (1) + "See the world.\n" (15) + "\n" (1) = 25
    expect(textarea.selectionStart).toBe(25);
    expect(textarea.selectionEnd).toBe(25);
    expect(textarea.scrollTop).toBeGreaterThan(0);
    expect(document.activeElement).toBe(textarea);
    expect(handle!.scrollToLine(1)).toBe(true);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.scrollTop).toBe(0);
    expect(handle!.scrollToLine(8)).toBe(false);
    expect(handle!.scrollToLine(0)).toBe(false);
  });
});

describe("MarkdownEditor styling", () => {
  test("keeps generated Crepe fallbacks synchronized with Night Owl", () => {
    const variants = [themeRegistry["night-owl"].light, themeRegistry["night-owl"].dark];
    const mappings = {
      bg: "bg",
      text: "text",
      textMuted: "text-muted",
      textFaint: "text-faint",
      surface: "surface",
      surface2: "surface-2",
      hover: "hover",
      inverseBg: "inverse-bg",
      inverseText: "inverse-text",
      inlineCodeBg: "inline-code-bg",
      brand: "brand",
      success: "success",
      danger: "danger",
    } as const;
    for (const variant of variants) {
      for (const [field, token] of Object.entries(mappings)) {
        const value = variant[field as keyof typeof mappings];
        expect(markdownEditorCss).toContain(`var(--${token},${value})`);
      }
    }
  });

  test("ships the Crepe theme plus host chrome through markdownEditorCss", () => {
    expect(markdownEditorCss).toContain(".ProseMirror");
    expect(markdownEditorCss).toContain(".milkdown");
    expect(markdownEditorCss).toContain(".sui-markdown-editor");
    expect(markdownEditorCss).toContain("prefers-color-scheme: dark");
    expect(markdownEditorCss).toContain(":root:not([data-theme='light']) .milkdown");
    expect(markdownEditorCss).toContain(":root[data-theme='dark'] .milkdown");
    expect(markdownEditorCss).toContain("--crepe-color-primary:var(--brand,#9449bc)");
    expect(markdownEditorCss).toContain("--crepe-font-default:var(--font-sans");
    expect(markdownEditorCss).toContain("--crepe-font-code:var(--font-mono");
    expect(markdownEditorCss).toContain(".milkdown :focus-visible{outline:2px solid var(--ring-border");
    expect(markdownEditorCss).toContain("transparent))!important;outline-offset:2px}");
    expect(markdownEditorCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(markdownEditorCss).toContain("animation-duration:0.001ms!important");
    expect(markdownEditorCss).toContain("--crepe-color-outline:var(--text-faint,#909caa)");
  });

  test("ships no external resource references", () => {
    expect(markdownEditorCss).not.toContain("@font-face");
    expect(markdownEditorCss).not.toContain("url(");
  });

  test("explicit data-theme toggles the Crepe palette independently of the OS", async () => {
    await render(<MarkdownEditor value="theme probe" />);
    const milkdown = document.createElement("div");
    milkdown.className = "milkdown";
    document.body.appendChild(milkdown);

    document.documentElement.setAttribute("data-theme", "light");
    expect(getComputedStyle(milkdown).getPropertyValue("--crepe-color-background")).toContain("#FBFBFB");
    expect(getComputedStyle(milkdown).getPropertyValue("--crepe-color-primary")).toContain("#9449bc");

    document.documentElement.setAttribute("data-theme", "dark");
    // happy-dom caches computed custom properties until the node reconnects;
    // browsers invalidate this automatically when the root attribute changes.
    milkdown.remove();
    document.body.appendChild(milkdown);
    expect(getComputedStyle(milkdown).getPropertyValue("--crepe-color-background")).toContain("#011627");
    expect(getComputedStyle(milkdown).getPropertyValue("--crepe-color-primary")).toContain("#c792ea");
    milkdown.remove();
    document.documentElement.removeAttribute("data-theme");
  });

  test("MarkdownEditorStyles renders the marker style tag with the sheet", () => {
    const html = renderToStaticMarkup(<MarkdownEditorStyles />);
    expect(html).toContain("data-smithers-markdown-editor");
    expect(html).toContain(".sui-markdown-editor");
  });

  test("every editor self-injects exactly one deduped style element", async () => {
    await render(
      <div>
        <MarkdownEditor value="x" />
        <MarkdownEditor value="y" />
      </div>,
    );
    const styles = document.querySelectorAll(`style[${MARKDOWN_EDITOR_STYLE_ATTR}]`);
    expect(styles.length).toBe(1);
    expect(styles[0]?.textContent).toContain(".sui-markdown-editor");
  });

  test("server render falls back to the seeded textarea", () => {
    const html = renderToStaticMarkup(<MarkdownEditor value="server value" />);
    expect(html).toContain("server value");
    expect(html).toContain('data-mode="fallback"');
  });
});

/** A controlled lifecycle with real DOM content and retained callback probes. */
function lifecycleEditor() {
  const loading = Promise.withResolvers<MarkdownEditorModule>();
  const creating = Promise.withResolvers<void>();
  const destroying = Promise.withResolvers<void>();
  let retainedHandler: (markdown: string) => void = () => {};
  let destroyed = 0;
  let constructed = 0;
  const replaced: string[] = [];
  const module: MarkdownEditorModule = {
    Crepe: class {
      constructor(readonly options: { root: HTMLElement; defaultValue: string }) {
        constructed++;
        options.root.textContent = options.defaultValue;
      }
      editor = {
        action: (command: unknown) => {
          const markdown = String(command);
          this.options.root.textContent = markdown;
          replaced.push(markdown);
          retainedHandler(markdown);
        },
      };
      create() { return creating.promise; }
      destroy() {
        destroyed++;
        return destroying.promise.then(() => { this.options.root.textContent = ""; });
      }
      setReadonly() {}
    },
    replaceAll: (markdown) => markdown,
    listenImmediately: (_editor, handler) => { retainedHandler = handler; },
  };
  return {
    module, loading, creating, destroying, replaced,
    load: () => loading.promise,
    emitStale: (markdown: string) => retainedHandler(markdown),
    get destroyed() { return destroyed; },
    get constructed() { return constructed; },
  };
}

describe("MarkdownEditor asynchronous lifecycle", () => {
  for (const phase of ["load", "create"] as const) {
    test(`applies the latest setMarkdown during ${phase} before becoming ready`, async () => {
      const stub = lifecycleEditor();
      const ref = createRef<MarkdownEditorHandle>();
      const changes: string[] = [];
      await render(<MarkdownEditor ref={ref} value="old document" fallback={false}
        loadEditor={stub.load} onChange={(markdown) => changes.push(markdown)} />);
      if (phase === "create") {
        await act(async () => { stub.loading.resolve(stub.module); });
      }
      await act(async () => {
        ref.current!.setMarkdown("intermediate document");
        ref.current!.setMarkdown("new external document");
      });
      expect(ref.current!.scrollToLine(1)).toBe(false);
      await act(async () => {
        stub.loading.resolve(stub.module);
        stub.creating.resolve();
      });
      expect(ref.current!.getMarkdown()).toBe("new external document");
      expect(container!.querySelector('[data-testid="markdown-editor"]')!.textContent).toBe("new external document");
      expect(stub.replaced).toEqual(["new external document"]);
      expect(changes).toEqual([]);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        stub.emitStale("new external document plus local edit");
      });
      expect(changes).toEqual(["new external document plus local edit"]);
      stub.destroying.resolve();
    });
  }

  test("rejected create releases the editor once and ignores its retained callbacks", async () => {
    const stub = lifecycleEditor();
    const ref = createRef<MarkdownEditorHandle>();
    const changes: string[] = [];
    const errors: unknown[] = [];
    await render(<MarkdownEditor ref={ref} value="seed" fallback={false}
      loadEditor={stub.load} onChange={(markdown) => changes.push(markdown)}
      onError={(error) => errors.push(error)} />);
    await act(async () => { stub.loading.resolve(stub.module); });
    const cause = new Error("partial create failed");
    await act(async () => { stub.creating.reject(cause); });
    expect(editor().getAttribute("data-mode")).toBe("failed");
    await type(editor(), "fallback edit");
    await act(async () => { stub.emitStale("late stale editor update"); });
    expect(changes).toEqual(["fallback edit"]);
    expect(ref.current!.getMarkdown()).toBe("fallback edit");
    expect(editor().value).toBe("fallback edit");
    expect(stub.destroyed).toBe(1);
    expect(errors).toEqual([{ code: "editor-create-failed", cause }]);
    stub.destroying.reject(new Error("teardown failed"));
    const mounted = root!;
    root = undefined;
    await act(async () => mounted.unmount());
    expect(stub.destroyed).toBe(1);
  });

  test("reset waits for pending creation and destruction before reusing the host", async () => {
    const stub = lifecycleEditor();
    const ref = createRef<MarkdownEditorHandle>();
    const changes: string[] = [];
    const view = (resetKey: number) => <MarkdownEditor ref={ref} value={`document ${resetKey}`}
      resetKey={resetKey} fallback={false} loadEditor={stub.load}
      onChange={(markdown) => changes.push(markdown)} />;
    await render(view(0));
    await act(async () => { stub.loading.resolve(stub.module); });
    await rerender(view(1));
    expect(stub.constructed).toBe(1);
    await act(async () => { stub.emitStale("stale during reset"); });
    expect(ref.current!.getMarkdown()).toBe("document 1");
    expect(changes).toEqual([]);
    await act(async () => { stub.creating.resolve(); });
    expect(stub.destroyed).toBe(1);
    expect(stub.constructed).toBe(1);
    await act(async () => { stub.destroying.resolve(); });
    expect(stub.constructed).toBe(2);
    expect(container!.querySelector('[data-testid="markdown-editor"]')!.textContent).toBe("document 1");
    expect(ref.current!.getMarkdown()).toBe("document 1");
  });

  test("synchronous setup failure releases the constructed editor", async () => {
    const stub = lifecycleEditor();
    const cause = new Error("listener setup failed");
    const errors: unknown[] = [];
    stub.destroying.resolve();
    await render(<MarkdownEditor value="seed" fallback={false} loadEditor={stub.load}
      onError={(error) => errors.push(error)} />);
    await act(async () => { stub.loading.resolve({ ...stub.module, listenImmediately: () => { throw cause; } }); });
    expect(editor().getAttribute("data-mode")).toBe("failed");
    expect(stub.destroyed).toBe(1);
    expect(errors).toEqual([{ code: "editor-create-failed", cause }]);
  });

});
