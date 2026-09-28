/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { formatPartialJson } from "../src/agentic/formatPartialJson";
import {
  ToolCall,
  ToolCallApproval,
  ToolCallContent,
  ToolCallError,
  ToolCallHeader,
  ToolCallInput,
  ToolCallOutput,
} from "../src/agentic/ToolCall";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement) {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  await act(async () => root!.render(element));
}

describe("formatPartialJson", () => {
  test("pretty-prints complete JSON", () => {
    expect(formatPartialJson('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', complete: true });
  });

  test("returns fragments verbatim without repair", () => {
    expect(formatPartialJson('{"partial":')).toEqual({ text: '{"partial":', complete: false });
    expect(formatPartialJson("not json at all")).toEqual({ text: "not json at all", complete: false });
  });
});

describe("ToolCall compound anatomy", () => {
  test("header is a div containing a trigger button that toggles the content region", async () => {
    await render(
      <ToolCall name="search" state="output-available" durationMs={1523}>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallInput args={{ query: "status" }} />
          <ToolCallOutput result={{ hits: 2 }} />
        </ToolCallContent>
      </ToolCall>,
    );
    const rootEl = container!.querySelector('[data-slot="tool-call"]')!;
    expect(rootEl.getAttribute("data-state")).toBe("closed");
    const header = container!.querySelector('[data-slot="tool-call-header"]')!;
    // Frozen Div contract: the header is a real div, not a button in disguise.
    expect(header.tagName).toBe("DIV");
    expect(header.textContent).toContain("search");
    expect(header.textContent).toContain("Done");
    expect(header.textContent).toContain("1.5s");
    const trigger = header.querySelector<HTMLButtonElement>('[data-slot="tool-call-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="tool-call-content"]')).toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const content = container!.querySelector('[data-slot="tool-call-content"]')!;
    expect(content.getAttribute("role")).toBe("region");
    expect(content.id).toBe(trigger.getAttribute("aria-controls"));
    expect(container!.querySelector('[data-slot="tool-call-input"]')!.textContent).toContain('"query"');
    expect(container!.querySelector('[data-slot="tool-call-output"]')!.textContent).toContain('"hits"');
  });

  test("header div props compose: consumer onClick fires and disclosure still toggles", async () => {
    const clicks: string[] = [];
    await render(
      <ToolCall name="search" state="running">
        <ToolCallHeader className="custom-header" onClick={() => clicks.push("div")} />
      </ToolCall>,
    );
    const header = container!.querySelector<HTMLDivElement>('[data-slot="tool-call-header"]')!;
    expect(header.className).toContain("sui-toolcall-header");
    expect(header.className).toContain("custom-header");
    const trigger = header.querySelector<HTMLButtonElement>('[data-slot="tool-call-trigger"]')!;
    await act(async () => trigger.click());
    expect(clicks).toEqual(["div"]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  test("input and output parts render as divs honoring their Div prop contracts", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="search" state="output-available" defaultOpen>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallInput args={{ a: 1 }} data-contract="input-div" />
          <ToolCallOutput result={{ b: 2 }} data-contract="output-div" />
        </ToolCallContent>
      </ToolCall>,
    );
    expect(html).toContain('data-contract="input-div"');
    expect(html).toContain('data-contract="output-div"');
    expect(html).not.toContain("<section");
  });

  test("hides duration for non-terminal states and while absent", () => {
    const running = renderToStaticMarkup(
      <ToolCall name="search" state="running" durationMs={900}>
        <ToolCallHeader />
      </ToolCall>,
    );
    expect(running).not.toContain("900ms");
    const terminal = renderToStaticMarkup(
      <ToolCall name="search" state="output-error" durationMs={900}>
        <ToolCallHeader />
      </ToolCall>,
    );
    expect(terminal).toContain("900ms");
  });

  test("legacy mode renders durationMs in the heading when terminal", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="search" state="output-available" durationMs={250}>
        <ToolCallHeader />
        <ToolCallContent><ToolCallOutput result="ok" /></ToolCallContent>
      </ToolCall>,
    );
    expect(html).toContain("250ms");
    expect(html).toContain('data-slot="tool-call-duration"');
  });

  test("announces state label changes through one polite live region", async () => {
    await render(
      <ToolCall name="search" state="running">
        <ToolCallHeader />
      </ToolCall>,
    );
    const live = container!.querySelector('[data-slot="tool-call-live"]')!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");

    await render(
      <ToolCall name="search" state="output-available">
        <ToolCallHeader />
      </ToolCall>,
    );
    expect(live.textContent).toBe("Done");
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const html = renderToStaticMarkup(
      <ToolCall name="search" state="running">
        <ToolCallHeader />
      </ToolCall>,
    );
    expect(html).toContain("sui-toolcall");
  });
});

describe("ToolCallInput", () => {
  test("partial input streams argsText verbatim in a data-partial pre", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="write" state="input-streaming" defaultOpen>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallInput args={{ ignored: true }} argsText={'{"partial":'} partial />
        </ToolCallContent>
      </ToolCall>,
    );
    expect(html).toContain('data-partial="true"');
    expect(html).toContain("{&quot;partial&quot;:");
    expect(html).not.toContain("ignored");
  });

  test("complete argsText pretty-prints when parseable", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="write" state="input-available" defaultOpen>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallInput argsText='{"a":1}' />
        </ToolCallContent>
      </ToolCall>,
    );
    expect(html).toContain('data-partial="false"');
    expect(html).toContain("&quot;a&quot;: 1");
  });
});

describe("ToolCallOutput parts", () => {
  test("renders text, json, image, code, and error parts", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="inspect" state="output-available" defaultOpen>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallOutput
            parts={[
              { kind: "text", text: "Found it" },
              { kind: "json", value: { hits: 2 } },
              { kind: "image", src: "/artifacts/a.png", alt: "chart of hits" },
              { kind: "code", code: "return 1;", language: "ts" },
              { kind: "error", message: "partial failure" },
            ]}
          />
        </ToolCallContent>
      </ToolCall>,
    );
    expect(html).toContain("Found it");
    expect(html).toContain("&quot;hits&quot;");
    expect(html).toContain("<img");
    expect(html).toContain('alt="chart of hits"');
    expect(html).toContain('data-slot="code-block"');
    expect(html).toContain("return 1;");
    expect(html).toContain("partial failure");
    expect(html).toContain('role="alert"');
  });

  test("an image part on another origin renders its alt text, never a fetch", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="inspect" state="output-available" defaultOpen>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallOutput
            parts={[
              { kind: "image", src: "https://attacker.test/p.png?leak=1", alt: "remote" },
              { kind: "image", src: "javascript:alert(1)", alt: "script" },
              { kind: "image", src: "blob:https://app.test/5c1d", alt: "local blob" },
            ]}
          />
        </ToolCallContent>
      </ToolCall>,
    );
    expect(html).not.toContain("attacker.test");
    expect(html).not.toContain("javascript:");
    expect(html.match(/<img/g) ?? []).toHaveLength(1);
    expect(html).toContain('src="blob:https://app.test/5c1d"');
    expect(html).toContain(">remote</span>");
  });

  test("partial parts mark data-partial and suppress copy affordances", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="inspect" state="running" defaultOpen>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallOutput parts={[{ kind: "code", code: "return 1", partial: true }]} />
        </ToolCallContent>
      </ToolCall>,
    );
    expect(html).toContain('data-partial="true"');
    expect(html).not.toContain('data-slot="code-block-copy"');
  });

  test("legacy result rendering still works through ToolCallOutput", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="inspect" state="output-available" defaultOpen>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallOutput result={{ ok: true }} />
        </ToolCallContent>
      </ToolCall>,
    );
    expect(html).toContain("&quot;ok&quot;");
    expect(html).toContain('aria-label="Tool output: inspect"');
  });
});

describe("ToolCallError and ToolCallApproval", () => {
  test("ToolCallError renders a destructive alert with the message", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="deploy" state="output-error" defaultOpen>
        <ToolCallHeader />
        <ToolCallContent>
          <ToolCallError message="Permission denied" />
        </ToolCallContent>
      </ToolCall>,
    );
    expect(html).toContain('data-slot="tool-call-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Permission denied");
  });

  test("ToolCallApproval renders approval-request presentation children", () => {
    const html = renderToStaticMarkup(
      <ToolCall name="deploy" state="approval-requested">
        <ToolCallHeader />
        <ToolCallApproval>
          <button>Approve deploy</button>
        </ToolCallApproval>
      </ToolCall>,
    );
    expect(html).toContain('data-slot="tool-call-approval"');
    expect(html).toContain("Approve deploy");
  });
});
