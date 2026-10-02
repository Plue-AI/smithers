/** @jsxImportSource react */
// PierreDiffView is the heavy `@pierre/diffs` adapter, exported through the
// `@smthrs/ui/adapters/pierre-diff-view` subpath (never the base
// barrel). CodeView tokenizes lines asynchronously through Shiki and lays them
// out with ResizeObserver/rAF, none of which paint deterministically under
// happy-dom, so per-line highlighting is asserted against the parsed CodeView
// model (`patchToCodeViewItems`) while the live mount proves the widget renders
// and pierre's own file header (with its per-file counts) is live in both layouts.
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  diffStyleForLayout,
  diffsThemeForMode,
  normalizeDiffPath,
  patchToCodeViewItems,
  PierreDiffView,
} from "../src/adapters/pierre-diff-view";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { smithersUiCss } from "../src/uiCss";

const PATCH = `diff --git a/greet.ts b/greet.ts
index 1111111..2222222 100644
--- a/greet.ts
+++ b/greet.ts
@@ -1,3 +1,3 @@
 const name = "world";
-const value = 1;
+const value = 2;
 export const unchanged = 0;
`;

const TWO_FILE_PATCH = `diff --git a/first.ts b/first.ts
index 1111111..2222222 100644
--- a/first.ts
+++ b/first.ts
@@ -1,1 +1,1 @@
-const first = 1;
+const first = 2;
diff --git a/second.ts b/second.ts
index 3333333..4444444 100644
--- a/second.ts
+++ b/second.ts
@@ -1,1 +1,1 @@
-const second = 1;
+const second = 2;
`;

const originalMutationObserver = globalThis.MutationObserver;

describe("theme + layout mapping", () => {
  test("mode and palette map onto registry Shiki themes", () => {
    expect(diffsThemeForMode("light")).toBe("night-owl-light");
    expect(diffsThemeForMode("dark")).toBe("night-owl");
    expect(diffsThemeForMode("dark", "paper")).toBe("night-owl");
  });

  test("layout maps onto CodeView diffStyle (split=side-by-side, inline=unified)", () => {
    expect(diffStyleForLayout("split")).toBe("split");
    expect(diffStyleForLayout("inline")).toBe("unified");
  });

  test("maps Pierre chrome and semantic diff colors onto house tokens", () => {
    const rule = smithersUiCss.match(/\.sui-pierre-diff \{[^}]+\}/)?.[0] ?? "";
    for (const token of [
      "var(--surface, #fffefa)",
      "var(--text, #211d18)",
      "var(--success, #0b5b57)",
      "var(--danger, #a4442a)",
      "var(--success-soft,",
      "var(--danger-soft,",
    ]) {
      expect(rule).toContain(token);
    }
  });

  test("normalizeDiffPath strips quotes and a/ b/ prefixes", () => {
    expect(normalizeDiffPath("a/src/x.ts")).toBe("src/x.ts");
    expect(normalizeDiffPath("b/src/x.ts")).toBe("src/x.ts");
    expect(normalizeDiffPath('"a/with space.ts"')).toBe("with space.ts");
    expect(normalizeDiffPath(undefined)).toBe("");
  });
});

describe("patchToCodeViewItems", () => {
  test("parses a patch into one diff item per file with per-line changes", () => {
    const items = patchToCodeViewItems(PATCH);
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe("greet.ts");
    expect(items[0]!.type).toBe("diff");

    // Both changed lines survive into the CodeView model that Shiki highlights
    // per line, and the hunk carries the +1/-1 line accounting.
    const item = items[0]!;
    const hunk = item.type === "diff" ? item.fileDiff.hunks[0]! : undefined;
    expect(hunk?.additionLines).toBe(1);
    expect(hunk?.deletionLines).toBe(1);
    const model = JSON.stringify(items);
    expect(model).toContain("const value = 1;");
    expect(model).toContain("const value = 2;");
  });

  test("selectedPath narrows a multi-file patch to the matching file", () => {
    expect(patchToCodeViewItems(TWO_FILE_PATCH).length).toBe(2);
    const only = patchToCodeViewItems(TWO_FILE_PATCH, "second.ts");
    expect(only.length).toBe(1);
    expect(only[0]!.id).toBe("second.ts");
  });

  test("selectedPath accepts the a/ and b/ prefixed spellings of the same file", () => {
    expect(patchToCodeViewItems(TWO_FILE_PATCH, "b/second.ts").map((item) => item.id)).toEqual(["second.ts"]);
    expect(patchToCodeViewItems(TWO_FILE_PATCH, "a/second.ts").map((item) => item.id)).toEqual(["second.ts"]);
  });

  test("an unmatched selectedPath shows nothing rather than the whole patch", () => {
    // "Only the matching file is shown" cannot mean "every file" when nothing
    // matched: a caller whose selection was renamed away, or misspelled, was
    // handed the entire multi-file patch instead of an empty state.
    expect(patchToCodeViewItems(TWO_FILE_PATCH, "missing.ts")).toEqual([]);
  });

  test("a git-quoted, octal-escaped path matches its real filename", () => {
    const patch = 'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n'
      + "--- \"a/caf\\303\\251.ts\"\n+++ \"b/caf\\303\\251.ts\"\n"
      + "@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;\n";
    expect(patchToCodeViewItems(patch, "café.ts").length).toBe(1);
  });

  test("empty, whitespace, and malformed patches degrade to no items", () => {
    expect(patchToCodeViewItems("")).toEqual([]);
    expect(patchToCodeViewItems("   \n  ")).toEqual([]);
    expect(patchToCodeViewItems("this is not a diff at all")).toEqual([]);
  });
});

describe("PierreDiffView markup", () => {
  test("empty patch renders the honest empty-state, not a broken CodeView", () => {
    const html = renderToStaticMarkup(<PierreDiffView patch="" />);
    expect(html).toContain("sui-pierre-diff-empty");
    expect(html).toContain("No diff is available for this change.");
  });

  test("empty-state honors a custom label and passthrough className", () => {
    const html = renderToStaticMarkup(<PierreDiffView patch="" className="my-frame" emptyLabel="Nothing changed" />);
    expect(html).toContain("Nothing changed");
    expect(html).toContain("my-frame");
  });

  test("a non-empty patch mounts the CodeView frame in both layouts", () => {
    for (const layout of ["split", "inline"] as const) {
      const html = renderToStaticMarkup(<PierreDiffView patch={PATCH} layout={layout} mode="dark" />);
      expect(html).toContain("sui-pierre-diff");
    }
  });
});

describe("PierreDiffView live render (happy-dom)", () => {
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
    document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-palette");
    globalThis.MutationObserver = originalMutationObserver;
  });

  /*
   * pierre's first render in a process loads Shiki, its grammars and its web
   * components: seconds here, more on a loaded runner. So the wait for its
   * header is the event, against one generous deadline that only shapes the
   * failure message. A 500 ms poll budget inside bun's default 5 s case
   * timeout was a stopwatch on the machine, and it read red on a busy one.
   */
  const HEADER_DEADLINE_MS = 30_000;

  async function mount(element: ReactElement): Promise<HTMLElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const r = root;
    await act(async () => r.render(element));
    // Let CodeView's mount effect render the file header into its shadow root.
    const deadline = Date.now() + HEADER_DEADLINE_MS;
    while (!header(container)) {
      if (Date.now() > deadline) throw new Error(`pierre never rendered its file header within ${HEADER_DEADLINE_MS / 1000} s`);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    return container;
  }

  /** pierre's own file header, inside the `diffs-container` shadow root. */
  const header = (el: HTMLElement): Element | null =>
    el.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-diffs-header]") ?? null;

  for (const layout of ["split", "inline"] as const) {
    test(`renders the CodeView frame and pierre's per-file counts exactly once in ${layout} layout`, async () => {
      const el = await mount(<PierreDiffView patch={PATCH} layout={layout} mode="light" />);
      expect(el.querySelector(".sui-pierre-diff")).not.toBeNull();
      const head = header(el);
      expect(head).not.toBeNull();
      expect(head!.querySelector("[data-additions-count]")?.textContent).toBe("+1");
      expect(head!.querySelector("[data-deletions-count]")?.textContent).toBe("-1");
      // pierre prints the counts itself; the adapter no longer adds a second stat through the metadata slot.
      expect(el.querySelector('[slot="header-metadata"]')?.textContent ?? "").toBe("");
    }, 90_000);
  }

  test("the default Pierre mode follows root data-theme toggles", async () => {
    const notifyThemeChanges: (() => void)[] = [];
    globalThis.MutationObserver = class {
      constructor(callback: MutationCallback) {
        notifyThemeChanges.push(() => callback([], this as unknown as MutationObserver));
      }
      disconnect() {}
      observe() {}
      takeRecords(): MutationRecord[] {
        return [];
      }
    } as unknown as typeof MutationObserver;

    document.documentElement.setAttribute("data-theme", "light");
    const el = await mount(<PierreDiffView patch={PATCH} />);
    const adapter = () => el.querySelector('[data-slot="pierre-diff-view"]');
    expect(adapter()?.getAttribute("data-theme-mode")).toBe("light");
    expect(notifyThemeChanges.length).toBeGreaterThan(0);

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      for (const notify of notifyThemeChanges) notify();
      await Promise.resolve();
    });
    expect(adapter()?.getAttribute("data-theme-mode")).toBe("dark");
  }, 90_000);
});
