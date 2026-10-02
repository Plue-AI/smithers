// <Terminal> adapter under happy-dom: real createRoot + act, the same
// convention as radix-interaction.test.tsx. The emulator mounts through a
// dynamic `import("@xterm/xterm")` inside an effect, so every assertion polls
// via waitFor until the async open + write queue has flushed.
//
// The DOM comes from tests/happy-dom-preload.ts (bunfig `[test] preload`).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { Terminal, terminalThemeFor, type TerminalError, type TerminalWriter } from "../src/adapters/terminal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STYLE_ATTR = "data-smithers-ui-terminal";
const originalMatchMedia = window.matchMedia;
const originalMutationObserver = globalThis.MutationObserver;

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
  document.querySelectorAll(`style[${STYLE_ATTR}]`).forEach((el) => el.remove());
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-palette");
  window.matchMedia = originalMatchMedia;
  globalThis.MutationObserver = originalMutationObserver;
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const r = root;
  await act(async () => r.render(element));
}

/** Poll `get()` for a truthy value, flushing React work between attempts. */
async function waitFor<T>(get: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    let value: T | null | undefined | false = null as T | null;
    await act(async () => {
      value = get();
      await Promise.resolve();
    });
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** First visible buffer row as plain text (trailing whitespace trimmed). */
function line(term: XTerminal, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true).trimEnd() ?? "";
}

describe("<Terminal> lines prop", () => {
  test("writes a fixed lines array into the emulator", async () => {
    let term: XTerminal | null = null;
    await render(<Terminal lines={["first line", "second line"]} onReady={(t) => (term = t)} />);
    const ready = await waitFor(() => term);
    await waitFor(() => line(ready, 0) === "first line");
    expect(line(ready, 0)).toBe("first line");
    expect(line(ready, 1)).toBe("second line");
  });
});

describe("<Terminal> stream seam", () => {
  test("appends incremental output pushed through the write seam", async () => {
    let term: XTerminal | null = null;
    let push: TerminalWriter | null = null;
    await render(<Terminal onReady={(t) => (term = t)} stream={(write) => void (push = write)} />);
    const ready = await waitFor(() => term);
    const writer = await waitFor(() => push);

    await act(async () => writer("streamed row\r\n"));
    await waitFor(() => line(ready, 0) === "streamed row");
    expect(line(ready, 0)).toBe("streamed row");

    // A second push appends on the next row rather than clobbering the first.
    await act(async () => writer("next row\r\n"));
    await waitFor(() => line(ready, 1) === "next row");
    expect(line(ready, 0)).toBe("streamed row");
    expect(line(ready, 1)).toBe("next row");
  });

  test("runs the stream teardown on unmount", async () => {
    let torn = false;
    let ready = false;
    await render(<Terminal onReady={() => (ready = true)} stream={() => () => void (torn = true)} />);
    // mount() subscribes right after onReady fires; wait for it before teardown.
    await waitFor(() => ready);
    const r = root!;
    await act(async () => r.unmount());
    root = undefined;
    expect(torn).toBe(true);
  });
});

describe("<Terminal> headless rendering", () => {
  test("renders the themed surface without throwing", async () => {
    await render(<Terminal lines={["ok"]} data-testid="term" theme="light" />);
    const surface = container?.querySelector('[data-slot="terminal"]');
    expect(surface).toBeTruthy();
    expect(surface?.getAttribute("data-testid")).toBe("term");
    expect(container?.querySelector('[data-slot="terminal-screen"]')).toBeTruthy();
  });

  test("ships the xterm stylesheet through the ui style seam, not a bare css import", async () => {
    await render(<Terminal lines={["x"]} />);
    const style = document.querySelector(`style[${STYLE_ATTR}]`);
    expect(style?.textContent).toContain(".xterm");
    expect(style?.textContent).toContain(".sui-terminal");
  });

  test("the default palette follows root data-theme toggles", async () => {
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
    let term: XTerminal | null = null;
    await render(<Terminal lines={["theme"]} onReady={(next) => (term = next)} />);
    const ready = await waitFor(() => term);
    await waitFor(() => notifyThemeChanges.length > 0);
    expect(container?.querySelector('[data-slot="terminal"]')?.getAttribute("data-theme-mode")).toBe("light");
    expect(ready.options.theme?.background).toBe("#f7f4ee");

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      for (const notify of notifyThemeChanges) notify();
      await Promise.resolve();
    });
    await waitFor(() => ready.options.theme?.background === "#0d1514");
    expect(container?.querySelector('[data-slot="terminal"]')?.getAttribute("data-theme-mode")).toBe("dark");
    expect(ready.options.theme?.background).toBe("#0d1514");
  });

  test("uses registry terminal palettes", () => {
    for (const mode of ["light", "dark"] as const) {
      const palette = terminalThemeFor("paper", mode);
      expect(palette.background).toBe(mode === "light" ? "#f7f4ee" : "#0d1514");
      expect(palette.foreground).toBe(mode === "light" ? "#211d18" : "#ece7db");
      expect(palette.red).toBeTruthy();
      expect(palette.brightRed).toBeTruthy();
    }
  });

  test("disables xterm cursor blinking when reduced motion is preferred", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    })) as typeof window.matchMedia;
    let term: XTerminal | null = null;
    await render(<Terminal cursorBlink onReady={(next) => (term = next)} />);
    const ready = await waitFor(() => term);
    expect(ready.options.cursorBlink).toBe(false);
  });

  test("follows reduced-motion preference changes while mounted", async () => {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
        listeners.delete(listener);
      },
      dispatchEvent() {
        return true;
      },
    })) as typeof window.matchMedia;
    let term: XTerminal | null = null;
    await render(<Terminal cursorBlink onReady={(next) => (term = next)} />);
    const ready = await waitFor(() => term);
    expect(ready.options.cursorBlink).toBe(true);
    expect(listeners.size).toBeGreaterThan(0);

    await act(async () => {
      for (const listener of listeners) listener({ matches: true });
      await Promise.resolve();
    });
    expect(ready.options.cursorBlink).toBe(false);

    await act(async () => {
      for (const listener of listeners) listener({ matches: false });
      await Promise.resolve();
    });
    expect(ready.options.cursorBlink).toBe(true);

    const mounted = root!;
    await act(async () => mounted.unmount());
    root = undefined;
    expect(listeners.size).toBe(0);
  });
});

describe("<Terminal> startup failure", () => {
  test("a module load failure reports terminal-start-failed and renders a visible alert", async () => {
    const cause = new Error("chunk load failed");
    const errors: TerminalError[] = [];
    await render(<Terminal loadModules={() => Promise.reject(cause)} onError={(error) => errors.push(error)} />);
    const alert = await waitFor(() => container!.querySelector<HTMLElement>('[data-slot="terminal-error"]'));
    expect(alert.getAttribute("role")).toBe("alert");
    expect(container!.querySelector('[data-slot="terminal"]')!.getAttribute("data-state")).toBe("failed");
    expect(errors).toEqual([{ code: "terminal-start-failed", cause }]);
  });

  test("a failure after the emulator opens still reports through onError", async () => {
    const cause = new Error("stream refused");
    const errors: TerminalError[] = [];
    await render(
      <Terminal
        stream={() => {
          throw cause;
        }}
        onError={(error) => errors.push(error)}
      />,
    );
    await waitFor(() => errors.length > 0);
    expect(errors).toEqual([{ code: "terminal-start-failed", cause }]);
    expect(container!.querySelector('[data-slot="terminal-error"]')).toBeNull();
  });
});

describe("<Terminal> store independence", () => {
  test("the component source imports no Multi app store", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/adapters/terminal.tsx"), "utf8");
    for (const banned of [
      "preferencesStore",
      "sandboxStore",
      "vcsStore",
      "terminalClient",
      "smithersCloud",
      "zustand",
    ]) {
      expect(source).not.toContain(banned);
    }
    // Positive sanity: it really is the xterm port wired to the ui tokens.
    expect(source).toContain('from "../tokens"');
    expect(source).toContain('import("@xterm/xterm")');
  });
});
