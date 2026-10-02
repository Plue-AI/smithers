/** The real authored walkthrough runs with storage denied, matching the
 * shared run-result iframe's opaque origin. Drive generated HTML controls,
 * rather than only asserting their markup. */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ChangedFile } from "../../src/walkthrough/changedFileSchema.ts";
import { renderWalkthroughHtml } from "../../src/walkthrough/renderWalkthroughHtml.ts";

type WalkthroughInput = Parameters<typeof renderWalkthroughHtml>[0];

const files: ChangedFile[] = [
  {
    path: "src/auth.ts",
    status: "modified",
    insertions: 2,
    deletions: 1,
    diff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 3\n+const c = 4\n",
    reviewed: true,
    excludeReason: "",
  },
  {
    path: "src/session.ts",
    status: "modified",
    insertions: 1,
    deletions: 0,
    diff: "diff --git a/src/session.ts b/src/session.ts\n--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1 +1,2 @@\n const s = 1\n+const t = 2\n",
    reviewed: true,
    excludeReason: "",
  },
];

const comments: WalkthroughInput["comments"] = [
  {
    path: "src/auth.ts",
    content: "Guard the empty token.",
    suggestionCode: "if (!token) return null",
    existingCode: "",
    startLine: 2,
    endLine: 2,
    thinking: "",
    severity: "major",
    category: "correctness",
    confidence: "confirmed",
  },
];

const story = {
  headline: "Auth hardening",
  synopsis: "Tightens the token guard.",
  chapters: [
    {
      title: "The change",
      blocks: [
        { kind: "prose", text: "We tightened the guard.", path: "", intro: "", title: "", mermaid: "" },
        { kind: "diff", text: "", path: "src/auth.ts", intro: "the guard", title: "", mermaid: "" },
        { kind: "diff", text: "", path: "src/session.ts", intro: "the session", title: "", mermaid: "" },
        { kind: "diagram", text: "", path: "", intro: "", title: "Token flow", mermaid: "graph TD;A-->B;" },
      ],
    },
  ],
};

let html: string | null = null;

/** The rendered walkthrough, built once: rendering it is the expensive part. */
async function walkthroughHtml(): Promise<string> {
  if (html === null) {
    html = await renderWalkthroughHtml({
      title: "Auth hardening",
      story,
      files,
      comments,
      repoDir: "/tmp/repo",
      mode: "workspace",
      ref: "workspace",
      generatedAt: "2026-06-10T00:00:00.000Z",
    });
  }
  return html;
}

interface Page {
  readonly window: Window;
  readonly doc: Window["document"];
  readonly clipboardWrites: Array<string>;
}

const openPages: Array<Window> = [];

/**
 * The rendered walkthrough, loaded the way the server serves it: an opaque
 * origin where `localStorage` throws, and a clipboard whose writes reject.
 *
 * `decompression` off drops `DecompressionStream` so the Mermaid loader takes
 * its documented no-runtime path instead of evaluating a 3.5MB bundle.
 */
async function hostedPage(options: { decompression?: boolean } = {}): Promise<Page> {
  const window = new Window({ url: "https://walkthroughs.example/w/abc" });
  openPages.push(window);
  const anyWindow = window as unknown as Record<string, unknown>;
  // sandbox allow-scripts ⇒ opaque origin ⇒ every storage access is a SecurityError.
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError: storage is disabled inside 'data:' URLs");
    },
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError: storage is disabled inside 'data:' URLs");
    },
  });
  if (options.decompression !== true) delete anyWindow.DecompressionStream;
  const clipboardWrites: Array<string> = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText(text: string) {
        clipboardWrites.push(text);
        return Promise.reject(new Error("NotAllowedError: clipboard write denied"));
      },
    },
  });
  window.document.write(await walkthroughHtml());
  window.document.close();
  // happy-dom parses inline scripts but never runs them, so the page's own
  // scripts are evaluated here in document order: the theme boot script, the
  // walkthrough script, then the Mermaid loader. The `text/plain` runtime
  // payload is data and is skipped, exactly as a browser skips it.
  for (const script of window.document.querySelectorAll("script")) {
    const type = script.getAttribute("type");
    if (type !== null && type !== "text/javascript") continue;
    (window as unknown as { eval: (code: string) => void }).eval(script.textContent);
  }
  await window.happyDOM.waitUntilComplete();
  return { window, doc: window.document, clipboardWrites };
}

/** Lets the page's promise callbacks run without advancing its timers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** A trusted click, the way a reviewer produces one. */
function click(page: Page, element: unknown): void {
  (element as { dispatchEvent: (event: unknown) => void }).dispatchEvent(
    new page.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

function query(page: Page, selector: string): { textContent: string; getAttribute: (name: string) => string | null } {
  const found = page.doc.querySelector(selector);
  if (found === null) throw new Error(`missing element: ${selector}`);
  return found as never;
}

afterEach(async () => {
  while (openPages.length > 0) await openPages.pop()?.happyDOM.close();
});

describe("the hosted walkthrough page, with storage denied", () => {
  test("the theme toggle still cycles auto -> light -> dark -> auto", async () => {
    const page = await hostedPage();
    const toggle = query(page, "#theme-toggle");
    const root = page.doc.documentElement;

    // Storage is unreadable, so the page opens on auto with no forced theme.
    expect(root.getAttribute("data-theme")).toBe(null);

    const cycle: Array<string> = [];
    for (let i = 0; i < 4; i += 1) {
      click(page, toggle);
      cycle.push(root.getAttribute("data-theme") ?? "auto");
    }
    // Dark is reachable: the next theme comes from what is applied, not from
    // storage (which answers "auto" forever on an opaque origin).
    expect(cycle).toEqual(["light", "dark", "auto", "light"]);
    expect(toggle.getAttribute("aria-label")).toBe("Theme: light (click to change)");
    expect(toggle.textContent).toContain("Light");
  });

  test("a rejected clipboard write reports failure and leaves the page usable", async () => {
    const page = await hostedPage();
    const copyButton = query(page, "pre.suggested [data-copy]");
    expect(copyButton.textContent).toBe("Copy");

    click(page, copyButton);
    await flushMicrotasks();

    expect(page.clipboardWrites).toEqual(["if (!token) return null"]);
    // A denied write must never claim the clipboard changed.
    expect(copyButton.textContent).toBe("Copy failed");
    // ... and the label restores itself once the timer runs.
    await page.window.happyDOM.waitUntilComplete();
    expect(copyButton.textContent).toBe("Copy");


  });

  for (const outcome of ["success", "reject", "throw", "fallback-success", "fallback-false", "fallback-throw"] as const) {
    test(`suggestion copy reflects ${outcome}`, async () => {
      const page = await hostedPage();
      const fallback = outcome.startsWith("fallback");
      Object.defineProperty(page.window.navigator, "clipboard", {
        configurable: true,
        value: fallback ? undefined : {
          writeText() {
            if (outcome === "throw") throw new Error("clipboard unavailable");
            return outcome === "reject" ? Promise.reject(new Error("denied")) : Promise.resolve();
          },
        },
      });
      Object.defineProperty(page.doc, "execCommand", {
        configurable: true,
        value() {
          if (outcome === "fallback-throw") throw new Error("copy unavailable");
          return outcome === "fallback-success";
        },
      });
      for (const selector of ["pre.suggested [data-copy]"]) {
        const button = query(page, selector);
        click(page, button);
        await flushMicrotasks();
        const succeeds = outcome === "success" || outcome === "fallback-success";
        expect(button.textContent).toBe(succeeds ? "Copied" : "Copy failed");
        expect(page.doc.querySelectorAll("textarea").length).toBe(0);
      }
    });
  }

  test("expand all / collapse all drive every diff at once", async () => {
    const page = await hostedPage();
    const details = [...page.doc.querySelectorAll("article.file details")] as unknown as Array<{ open: boolean }>;
    expect(details.length).toBe(2);

    click(page, page.doc.querySelector("#collapse-all"));
    expect(details.every((d) => d.open === false)).toBe(true);

    click(page, page.doc.querySelector("#expand-all"));
    expect(details.every((d) => d.open === true)).toBe(true);
  });

  test("a findings-index deep link opens the collapsed diff and records the hash", async () => {
    const page = await hostedPage();
    click(page, page.doc.querySelector("#collapse-all"));
    const link = page.doc.querySelector("a[data-finding-link]");
    const targetId = link?.getAttribute("href")?.slice(1) ?? "";
    expect(targetId).not.toBe("");

    click(page, link);

    const card = page.doc.getElementById(targetId);
    expect(card).not.toBe(null);
    const details = card?.closest("article.file")?.querySelector("details") as unknown as { open: boolean } | null;
    // The card lives inside the diff it annotates, so the deep link must reopen it.
    expect(details?.open).toBe(true);
    expect(page.window.location.hash).toBe(`#${targetId}`);
  });

  test("a browser without DecompressionStream gets a note in every diagram, not a broken page", async () => {
    const page = await hostedPage();
    const note = query(page, "figure.diagram .diagram-note");
    expect(note.textContent).toContain("DecompressionStream unavailable");
    // The runtime payload is still inert data, never an executed script.
    expect(query(page, "#mermaid-runtime-gz").getAttribute("type")).toBe("text/plain");
  });
});
