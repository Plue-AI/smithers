/** @jsxImportSource react */
// The code-view adapter (apps/app/docs/code-intel/PLAN.md §1): one repository
// file rendered by `@pierre/diffs` `File`, Shiki underneath, exported through
// `@smthrs/ui/adapters/code-view` and never the base barrel. Tokenizing is
// asynchronous (the grammar and the theme load on first use), so the live
// mount polls until the first coloured token exists and then reads the token
// model straight out of pierre's shadow root: per line, the inline colour and
// the text of every span. That sequence is what a viewer sees; the snapshot
// pins it per language, and the structural checks say what the snapshot means.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getSharedHighlighter } from "@pierre/diffs";
import type { WorkerResponse } from "@pierre/diffs/worker";
import { CodeFileView, currentCodeViewPool, disposeCodeViewPool, languageForFile, type CodeTokenPosition } from "../src/adapters/code-view";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { themeRegistry } from "../src/styles";
import { smithersUiCss } from "../src/uiCss";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => disposeCodeViewPool());

/*
 * One fixture per language the plan names. Each is a real, small file shape
 * (imports, a doc comment, a template literal, JSX, a nested object, a list
 * and a fence, a Rust closure) so the token sequence exercises more than a
 * keyword.
 */
const FIXTURES = {
  ts: {
    name: "src/state/seams/FilesSeam.ts",
    contents: [
      'import { REPO_FILES_PATH } from "@smthrs/rpc/LocalApp"',
      "",
      "/** The card cap (characters): a transcript card states a file, it is not an editor. */",
      "const CARD_CONTENT_CAP = 16 * 1024",
      "",
      "export const isRecord = (value: unknown): value is Record<string, unknown> =>",
      '  value !== null && typeof value === "object" && !Array.isArray(value)',
      "",
      "export const label = (repo: string, path: string): string => `${path} in ${repo}`",
      "",
    ].join("\n"),
  },
  tsx: {
    name: "src/cards/FileCards.tsx",
    contents: [
      'import { Button } from "@smthrs/ui"',
      "",
      "export const Row = ({ name, onOpen }: { readonly name: string; readonly onOpen: () => void }) => (",
      '  <Button variant="ghost" size="sm" data-flow="files.read" onClick={onOpen}>',
      "    {name}",
      "  </Button>",
      ")",
      "",
    ].join("\n"),
  },
  json: {
    name: "package.json",
    contents: [
      "{",
      '  "name": "@smthrs/ui",',
      '  "private": true,',
      '  "exports": { ".": { "import": "./src/index.ts" } },',
      '  "sideEffects": false,',
      '  "count": 3',
      "}",
      "",
    ].join("\n"),
  },
  md: {
    name: "README.md",
    contents: [
      "# Smithers",
      "",
      "Durable **agent** workflows, journaled as they happen.",
      "",
      "- one",
      "- [two](https://smithers.sh)",
      "",
      "```ts",
      "const x = 1",
      "```",
      "",
    ].join("\n"),
  },
  rs: {
    name: "crates/flows-jj/src/lib.rs",
    contents: [
      "use std::collections::HashMap;",
      "",
      "/// A change id as jj prints it.",
      "pub struct ChangeId(pub String);",
      "",
      "pub fn count(ids: &[ChangeId]) -> usize {",
      "    ids.iter().filter(|id| !id.0.is_empty()).count()",
      "}",
      "",
    ].join("\n"),
  },
} as const;

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
});

const host = (): HTMLElement => {
  const el = container?.querySelector<HTMLElement>('[data-slot="code-view"]');
  if (el == null) throw new Error("code view not mounted");
  return el;
};

const shadow = (): ShadowRoot => {
  const sr = host().querySelector("diffs-container")?.shadowRoot;
  if (sr == null) throw new Error("pierre has not attached its shadow root");
  return sr;
};

async function mount(element: ReactElement): Promise<void> {
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

/*
 * Waiting for pierre is waiting for an event, never a benchmark. Tokenizing
 * is asynchronous and its cost belongs to the machine: the worker loads
 * Shiki, a grammar and a theme on first use (~14 s in this runtime, more on a
 * loaded runner) and every later file is warm. So every wait below polls for
 * the DOM fact it needs against one generous deadline and names what never
 * happened; the deadline shapes the failure message and nothing else. A poll
 * budget short enough to be a stopwatch is a machine-speed assertion in
 * disguise — the 4 s one this helper used to carry is what turned the first
 * two fixtures red on a loaded machine.
 */
const PAINT_DEADLINE_MS = 30_000;
const COLD_START_DEADLINE_MS = 150_000;

async function until(satisfied: () => boolean, what: string, deadlineMs = PAINT_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!satisfied()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${deadlineMs / 1000} s (worker pool: ${currentCodeViewPool().state})`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/** Wait until pierre has painted at least one coloured token (grammar + theme are async). */
const highlighted = (): Promise<void> =>
  until(() => shadow().querySelector("[data-line] span[style]") != null, "no token was ever coloured");

/*
 * The worker's first file pays for Shiki, the grammar and the theme once per
 * process. Paying it here keeps that cold start out of every test's budget,
 * where it read as a flake in whichever case happened to run first.
 */
beforeAll(async () => {
  const warm = document.createElement("div");
  document.body.appendChild(warm);
  const warmRoot = createRoot(warm);
  await act(async () => warmRoot.render(<CodeFileView name="src/warm-up.ts" contents={"const warm = 1\n"} mode="dark" palette="paper" />));
  await until(
    () => warm.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line] span[style]") != null,
    "the worker pool never painted a coloured token",
    COLD_START_DEADLINE_MS,
  );
  await act(async () => warmRoot.unmount());
  warm.remove();
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
}, COLD_START_DEADLINE_MS + 30_000);

/**
 * A recorder for `onTokenRest` whose wait is the callback itself: a test
 * awaits the next rest instead of sleeping past `restMs`, so nothing it
 * asserts depends on how fast this machine reaches a timer.
 */
const REST_DEADLINE_MS = 10_000;

const restRecorder = (): {
  readonly rests: ReadonlyArray<CodeTokenPosition>;
  readonly onTokenRest: (at: CodeTokenPosition) => void;
  readonly next: () => Promise<void>;
} => {
  const rests: CodeTokenPosition[] = [];
  let wake: (() => void) | null = null;
  return {
    rests,
    onTokenRest: (at: CodeTokenPosition): void => {
      rests.push(at);
      const resume = wake;
      wake = null;
      resume?.();
    },
    next: async (): Promise<void> => {
      const seen = rests.length;
      await act(async () => {
        await new Promise<void>((resolve, reject) => {
          if (rests.length > seen) {
            resolve();
            return;
          }
          const bail = setTimeout(() => {
            wake = null;
            reject(new Error(`onTokenRest never fired within ${REST_DEADLINE_MS / 1000} s`));
          }, REST_DEADLINE_MS);
          wake = () => {
            clearTimeout(bail);
            resolve();
          };
        });
      });
    },
  };
};

/** The token model a viewer sees: per line, `colour|text` for every span, plain text as `-|text`. */
function tokenModel(): ReadonlyArray<{ readonly line: number; readonly tokens: ReadonlyArray<string> }> {
  return Array.from(shadow().querySelectorAll<HTMLElement>("[data-line]")).map((row) => ({
    line: Number(row.getAttribute("data-line")),
    tokens: Array.from(row.childNodes).flatMap((node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent === "" ? [] : [`-|${node.textContent ?? ""}`];
      if (!(node instanceof HTMLElement) || node.tagName === "BR") return [];
      const colour = /color:\s*([^;]+)/.exec(node.getAttribute("style") ?? "")?.[1]?.trim() ?? "-";
      return [`${colour}|${node.textContent ?? ""}`];
    }),
  }));
}

const coloursOf = (model: ReturnType<typeof tokenModel>): ReadonlySet<string> =>
  new Set(model.flatMap((row) => row.tokens.map((token) => token.split("|")[0]!)).filter((colour) => colour !== "-"));

describe("languageForFile", () => {
  test("maps the fixture extensions onto pierre's grammar ids", () => {
    expect(languageForFile(FIXTURES.ts.name)).toBe("typescript");
    expect(languageForFile(FIXTURES.tsx.name)).toBe("tsx");
    expect(languageForFile(FIXTURES.json.name)).toBe("json");
    expect(languageForFile(FIXTURES.md.name)).toBe("markdown");
    expect(languageForFile(FIXTURES.rs.name)).toBe("rust");
    // A well-known file name without an extension is still a grammar.
    expect(languageForFile("Makefile")).toBe("makefile");
  });

  test("answers null for a file no grammar claims, so the caller keeps plain text", () => {
    expect(languageForFile("LICENSE")).toBeNull();
    expect(languageForFile("notes.zzz")).toBeNull();
    expect(languageForFile("")).toBeNull();
  });
});

describe("the syntax theme ids", () => {
  test("every palette's shikiDark and shikiLight load through the highlighter pierre uses", async () => {
    const ids = Object.values(themeRegistry).flatMap((theme) => [theme.syntax.shikiDark, theme.syntax.shikiLight]);
    expect(ids).toHaveLength(Object.keys(themeRegistry).length * 2);
    const highlighter = await getSharedHighlighter({ themes: ids, langs: ["typescript"] });
    expect(highlighter.getLoadedThemes()).toEqual(expect.arrayContaining(ids));
  }, 60_000);

  test("the frame follows the house code tokens on both axes", () => {
    const rule = smithersUiCss.match(/\.sui-code-view \{[^}]+\}/)?.[0] ?? "";
    for (const token of ["var(--code-bg,", "var(--code-text,", "--diffs-light-bg:", "--diffs-dark-bg:"]) {
      expect(rule).toContain(token);
    }
    // Plain text is a complete state: the fallback is visible until pierre has painted, then hidden.
    expect(smithersUiCss).toContain('.sui-code-view[data-state="ready"] > .sui-code-view-plain { display:none; }');
  });
});

describe("CodeFileView token model (happy-dom, main thread)", () => {
  for (const [key, fixture] of Object.entries(FIXTURES) as ReadonlyArray<[keyof typeof FIXTURES, (typeof FIXTURES)[keyof typeof FIXTURES]]>) {
    test(`${key}: every line survives tokenizing losslessly, more than one colour appears, and the sequence is pinned`, async () => {
      await mount(<CodeFileView name={fixture.name} contents={fixture.contents} mode="dark" palette="paper" />);
      await highlighted();
      const model = tokenModel();
      const sourceLines = fixture.contents.split("\n");
      // Trailing newline: pierre renders the empty last line too.
      expect(model.map((row) => row.line)).toEqual(sourceLines.map((_line, index) => index + 1));
      for (const row of model) {
        // pierre keeps a line's own newline as a text node; the source split dropped it.
        const text = row.tokens.map((token) => token.slice(token.indexOf("|") + 1)).join("").replace(/\n$/, "");
        expect(text).toBe(sourceLines[row.line - 1]);
      }
      expect(coloursOf(model).size).toBeGreaterThan(1);
      expect(host().getAttribute("data-language")).toBe(languageForFile(fixture.name));
      expect(model).toMatchSnapshot();
    }, 90_000);
  }

  test("light and dark of the same palette colour the same tokens differently", async () => {
    await mount(<CodeFileView name={FIXTURES.ts.name} contents={FIXTURES.ts.contents} mode="dark" palette="paper" />);
    await highlighted();
    const dark = coloursOf(tokenModel());
    expect(host().getAttribute("data-theme-mode")).toBe("dark");
    await rerender(<CodeFileView name={FIXTURES.ts.name} contents={FIXTURES.ts.contents} mode="light" palette="paper" />);
    /*
     * The theme change re-renders through the pool, so the wait is for the
     * repaint itself: a fixed sleep either reads the dark colours still on
     * screen or gives up before the pool has answered.
     */
    const repainted = (): boolean => {
      const now = coloursOf(tokenModel());
      return now.size > 1 && [...now].sort().join() !== [...dark].sort().join();
    };
    await until(repainted, "the light theme never recoloured a token");
    const light = coloursOf(tokenModel());
    expect(host().getAttribute("data-theme-mode")).toBe("light");
    expect(light.size).toBeGreaterThan(1);
    expect([...light].sort()).not.toEqual([...dark].sort());
  }, 90_000);

  test("plain text is a complete state: the fallback carries the file, and the sheet hides it only once pierre has lines", async () => {
    /*
     * A grammar no other fixture uses. With the shared highlighter warm and
     * the grammar not, pierre paints uncoloured lines at once and colours
     * them when the grammar lands; with nothing loaded it paints nothing
     * until both land. Either way the state follows the lines: the fallback
     * is the visible text exactly while pierre has none. (The process-cold
     * sequence cannot be forced inside one shared bun process, so the
     * invariant is asserted rather than one fixed order.)
     */
    const contents = "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n";
    await mount(<CodeFileView name="cmd/main.go" contents={contents} mode="dark" palette="paper" />);
    expect(host().querySelector(".sui-code-view-plain")?.textContent).toBe(contents);
    const painted = shadow().querySelector("[data-line]") != null;
    expect(host().getAttribute("data-state")).toBe(painted ? "ready" : null);
    await highlighted();
    expect(host().getAttribute("data-state")).toBe("ready");
    // The fallback stays in the DOM (the sheet hides it); the tokens are the visible state.
    expect(host().querySelector(".sui-code-view-plain")).not.toBeNull();
  }, 90_000);

  test("the anchored line is marked, and the mark follows the prop", async () => {
    await mount(<CodeFileView name={FIXTURES.ts.name} contents={FIXTURES.ts.contents} line={4} mode="dark" palette="paper" />);
    await highlighted();
    expect(shadow().querySelector('[data-line="4"]')?.hasAttribute("data-selected-line")).toBe(true);
    expect(shadow().querySelectorAll("[data-line][data-selected-line]")).toHaveLength(1);
    await rerender(<CodeFileView name={FIXTURES.ts.name} contents={FIXTURES.ts.contents} line={6} mode="dark" palette="paper" />);
    expect(shadow().querySelector('[data-line="6"]')?.hasAttribute("data-selected-line")).toBe(true);
    expect(shadow().querySelector('[data-line="4"]')?.hasAttribute("data-selected-line")).toBe(false);
    await rerender(<CodeFileView name={FIXTURES.ts.name} contents={FIXTURES.ts.contents} mode="dark" palette="paper" />);
    expect(shadow().querySelectorAll("[data-line][data-selected-line]")).toHaveLength(0);
  }, 90_000);

  test("the anchored line is scrolled to the middle of the nearest scroller, on mount and again when the anchor moves", async () => {
    const contents = Array.from({ length: 60 }, (_line, index) => `const v${index} = ${index}`).join("\n") + "\n";
    /*
     * happy-dom lays nothing out, so the geometry is stubbed: the scroller
     * shows 200px, every line is 20px tall, and a line's position follows
     * the scroller's current scrollTop the way a real layout would.
     */
    const original = Element.prototype.getBoundingClientRect;
    const rect = (top: number, height: number): DOMRect =>
      ({ top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains("proto-scroller")) return rect(0, 200);
      const line = this.getAttribute("data-line");
      if (line !== null) return rect((Number(line) - 1) * 20 - (document.querySelector(".proto-scroller")?.scrollTop ?? 0), 20);
      return rect(0, 0);
    };
    try {
      await mount(
        <div className="proto-scroller" style={{ overflowY: "auto" }}>
          <CodeFileView name="src/long.ts" contents={contents} line={40} mode="dark" palette="paper" />
        </div>,
      );
      await highlighted();
      const scroller = document.querySelector<HTMLElement>(".proto-scroller")!;
      // Line 40 sits at 780px; centred in a 200px viewport of 20px lines: 780 - (200 - 20) / 2.
      expect(scroller.scrollTop).toBe(690);
      expect(shadow().querySelector('[data-line="40"]')?.hasAttribute("data-selected-line")).toBe(true);
      const instance = host().querySelector("diffs-container");
      await rerender(
        <div className="proto-scroller" style={{ overflowY: "auto" }}>
          <CodeFileView name="src/long.ts" contents={contents} line={10} mode="dark" palette="paper" />
        </div>,
      );
      /*
       * The anchor moved without remounting pierre: the same element, its
       * tokens still coloured on the very next frame (a remount paid the
       * whole tokenize again and showed plain text until it landed), and the
       * scroll landed anyway.
       */
      expect(host().querySelector("diffs-container")).toBe(instance);
      expect(shadow().querySelector("[data-line] span[style]")).not.toBeNull();
      expect(host().getAttribute("data-state")).toBe("ready");
      expect(scroller.scrollTop).toBe(90);
      expect(shadow().querySelector('[data-line="10"]')?.hasAttribute("data-selected-line")).toBe(true);
      // A line already in view leaves the scroller where it is.
      await rerender(
        <div className="proto-scroller" style={{ overflowY: "auto" }}>
          <CodeFileView name="src/long.ts" contents={contents} line={12} mode="dark" palette="paper" />
        </div>,
      );
      await highlighted();
      expect(scroller.scrollTop).toBe(90);
      // The document itself is never the scroller a card reaches for.
      expect(document.documentElement.scrollTop).toBe(0);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  }, 90_000);

  /*
   * Hold delivery of real worker results so a fast worker cannot race the
   * pending-work assertions. A scheduled main-thread callback must run while
   * delivery is held; releasing the gate must paint the actual token output.
   * Repeat with a second file to cover the warm pool without timing bounds.
   */
  test("a 16 KiB TypeScript file is tokenized in the pool's worker while this thread services a callback", async () => {
    const line = (index: number): string => `export const value${index} = (input: Readonly<Record<string, number>>): number => Object.values(input).reduce((sum, n) => sum + n, ${index})`;
    let contents = "";
    for (let index = 0; contents.length < 16 * 1024; index += 1) contents += `${line(index)}\n`;
    expect(contents.length).toBeGreaterThanOrEqual(16 * 1024);
    const manager = currentCodeViewPool().manager;
    if (manager === undefined) throw new Error(`the code view has no worker pool (state ${currentCodeViewPool().state})`);
    // Pierre's message listener calls this private method dynamically. Gate
    // only file results; initialization, theme changes and errors still flow.
    const boundary = manager as unknown as {
      handleWorkerMessage: (worker: unknown, response: WorkerResponse) => void;
    };
    const deliver = boundary.handleWorkerMessage.bind(manager);
    const held: Array<() => void> = [];
    const gate = spyOn(boundary, "handleWorkerMessage").mockImplementation((worker, response) => {
      if (response.type === "success" && response.requestType === "file") {
        held.push(() => deliver(worker, response));
      } else {
        deliver(worker, response);
      }
    });
    const release = (): void => {
      for (const deliverResponse of held.splice(0)) deliverResponse();
    };
    try {
      for (const [name, fileContents] of [["src/big.ts", contents], ["src/big2.ts", contents.slice(200)]] as const) {
        await mount(<CodeFileView name={name} contents={fileContents} mode="dark" palette="paper" />);
        await until(() => held.length > 0, `${name}: the worker never returned a file result`);
        let callbackServiced = false;
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(() => {
            callbackServiced = true;
            resolve();
          }, 0));
        });
        expect(callbackServiced).toBe(true);
        expect(held).toHaveLength(1);
        expect(shadow().querySelector("[data-line] span[style]")).toBeNull();
        const stats = manager.getStats();
        expect(stats.busyWorkers).toBeGreaterThanOrEqual(1);
        expect(stats.activeTasks + stats.queuedTasks).toBeGreaterThanOrEqual(1);

        await act(async () => release());
        await highlighted();
        expect(host().getAttribute("data-highlighter")).toBe("worker");
        expect(currentCodeViewPool().state).toBe("ready");
        const model = tokenModel();
        expect(model.length).toBeGreaterThan(100);
        expect(coloursOf(model).size).toBeGreaterThan(1);
        expect(model.map((row) => row.tokens.map((token) => token.slice(token.indexOf("|") + 1)).join("").replace(/\n$/, "")))
          .toEqual(fileContents.split("\n"));
        expect(held).toHaveLength(0);
        await act(async () => root!.unmount());
        root = undefined;
        container?.remove();
        container = undefined;
      }
    } finally {
      gate.mockRestore();
      await act(async () => release());
    }
  }, 120_000);

  test("with no explicit mode or palette the view follows the document root", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("data-palette", "catppuccin");
    await mount(<CodeFileView name={FIXTURES.json.name} contents={FIXTURES.json.contents} />);
    expect(host().getAttribute("data-theme-mode")).toBe("light");
    expect(host().getAttribute("data-palette")).toBe("paper");
  });
});

/*
 * Code intelligence L4 (apps/app/docs/code-intel/PLAN.md §5): the view's
 * interaction contract. Annotations render under their line as light-DOM
 * children pierre slots into the shadow root (a diagnostic, a hover box);
 * a pointer at rest on a token for `restMs` is one `onTokenRest` with the
 * 1-based line and column; ⌘/Ctrl-click on a token is one `onTokenActivate`.
 * The timer lives in the view, never in a consumer's effect.
 */
describe("CodeFileView annotations and token gestures", () => {
  const CONTENTS = "const a = 1\nconst b = a + 1\nexport { b }\n";

  const token = (line: number, text: string): HTMLElement => {
    const span = Array.from(shadow().querySelectorAll<HTMLElement>(`[data-line="${line}"] [data-char]`)).find(
      (candidate) => candidate.textContent === text,
    );
    if (span == null) throw new Error(`no token "${text}" on line ${line}`);
    return span;
  };

  const settle = (ms: number): Promise<void> =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  test("an annotation renders under its line, slotted by line number, and follows the prop", async () => {
    await mount(
      <CodeFileView
        name="src/a.ts"
        contents={CONTENTS}
        mode="dark"
        palette="paper"
        annotations={[{ key: "d1", line: 2, node: <p data-slot="probe-annotation">Property 'x' does not exist</p> }]}
      />,
    );
    await highlighted();
    const slotted = host().querySelector<HTMLElement>('[data-slot="probe-annotation"]');
    expect(slotted?.textContent).toBe("Property 'x' does not exist");
    expect(slotted?.closest("[slot]")?.getAttribute("slot")).toBe("annotation-2");
    // pierre placed a slot for it in the shadow root, after line 2.
    expect(shadow().querySelector('slot[name="annotation-2"]')).not.toBeNull();
    await rerender(<CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" annotations={[]} />);
    expect(host().querySelector('[data-slot="probe-annotation"]')).toBeNull();
  }, 90_000);

  const REST_MS = 40;
  const enter = (): PointerEvent => new PointerEvent("pointermove", { bubbles: true, composed: true, pointerType: "mouse" });
  const leave = (): PointerEvent => new PointerEvent("pointerleave", { bubbles: true, composed: true, pointerType: "mouse" });

  test("a pointer at rest on a token for restMs is one onTokenRest with the 1-based line and column; leaving first cancels it", async () => {
    const rest = restRecorder();
    await mount(
      <CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" restMs={REST_MS} onTokenRest={rest.onTokenRest} />,
    );
    await highlighted();
    // `a` on line 2 is the 11th character (0-based 10): `const b = a + 1`.
    const a = token(2, "a");
    /*
     * Enter, leave and enter again in one synchronous slice: this thread's
     * loop never turns between them, so the first timer cannot have fired on
     * its own and what the sequence proves is the disarm. A rest that
     * survived the leave was armed first and so lands first — it shows up as
     * an extra entry below rather than in a sleep long enough to catch it.
     */
    a.dispatchEvent(enter());
    a.dispatchEvent(leave());
    /*
     * A sentinel armed with half of restMs in the same slice. Timers fire in
     * expiry order on any machine, so a rest that arrives after it waited on
     * the view's own restMs timer instead of firing on enter.
     */
    let earlier = false;
    const sentinel = setTimeout(() => {
      earlier = true;
    }, REST_MS / 2);
    a.dispatchEvent(enter());
    expect(rest.rests).toEqual([]);
    await rest.next();
    clearTimeout(sentinel);
    expect(earlier).toBe(true);
    expect(rest.rests).toEqual([{ line: 2, column: 11, text: "a" }]);
    /*
     * Resting on the same token does not fire again, and the cancelled timer
     * never lands: either would be an extra entry ahead of the next token's
     * rest, which is the only thing waited on here.
     */
    token(1, "const").dispatchEvent(enter());
    await rest.next();
    expect(rest.rests).toEqual([
      { line: 2, column: 11, text: "a" },
      { line: 1, column: 1, text: "const" },
    ]);
  }, 90_000);

  test("⌘-click or Ctrl-click on a token is one onTokenActivate; a plain click is nothing", async () => {
    const activations: Array<{ line: number; column: number; text: string }> = [];
    await mount(
      <CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" onTokenActivate={(at) => activations.push(at)} />,
    );
    await highlighted();
    // Shiki tokenizes `{ b }` on line 3 as one span; `a` on line 2 is its own token.
    const a = token(2, "a");
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(activations).toEqual([]);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true }));
    expect(activations).toEqual([{ line: 2, column: 11, text: "a" }]);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, ctrlKey: true }));
    expect(activations).toHaveLength(2);
  }, 90_000);

  /*
   * The worker pool renders every file with one set of options, so pierre's
   * column marks (`data-char`) are on every pooled token whether or not a
   * gesture is bound; what a view without handlers must not do is present
   * itself as interactive (the cursor rule keys on `data-interactive`) or
   * fire a gesture. With handlers, the marks are what the gestures read.
   */
  test("without gesture handlers the view is not interactive and no gesture fires; with them it is, and the column marks are there to read", async () => {
    await mount(<CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" />);
    await highlighted();
    expect(host().hasAttribute("data-interactive")).toBe(false);
    const span = shadow().querySelector<HTMLElement>("[data-line] span[style]");
    span?.dispatchEvent(enter());
    await settle(60);
    span?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true }));
    const rest = restRecorder();
    await rerender(<CodeFileView name="src/a.ts" contents={CONTENTS} mode="dark" palette="paper" restMs={REST_MS} onTokenRest={rest.onTokenRest} />);
    await highlighted();
    expect(host().hasAttribute("data-interactive")).toBe(true);
    await until(() => shadow().querySelector("[data-line] [data-char]") != null, "pierre never marked a token's column");
    token(2, "a").dispatchEvent(enter());
    await rest.next();
    // The gestures dispatched before the handlers existed fired nothing.
    expect(rest.rests).toEqual([{ line: 2, column: 11, text: "a" }]);
  }, 90_000);
});

test("full-contrast opt-in keeps file text and can return to syntax colours", async () => {
  await mount(<CodeFileView name="contrast.ts" contents="const answer = 42" mode="light" monochrome />);
  await highlighted();
  expect(shadow().textContent).toContain("const answer = 42");
  expect(shadow().querySelector("style[data-unsafe-css]")?.textContent ?? shadow().textContent).toContain("color: var(--code-text, currentColor) !important");
  await rerender(<CodeFileView name="contrast.ts" contents="const answer = 42" mode="light" />);
  await highlighted();
  expect(shadow().textContent).toContain("const answer = 42");
  expect(shadow().textContent).not.toContain("color: var(--code-text, currentColor) !important");
});
