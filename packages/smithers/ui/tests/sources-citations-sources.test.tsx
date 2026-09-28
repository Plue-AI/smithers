/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { Source, Sources, SourcesContent, SourcesTrigger } from "../src/agentic/Sources";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("Sources compound anatomy", () => {
  test("trigger/content disclose with aria wiring and default count label", async () => {
    await render(
      <Sources>
        <SourcesTrigger count={2} />
        <SourcesContent>
          <Source title="Alpha" />
          <Source title="Beta" />
        </SourcesContent>
      </Sources>,
    );

    const trigger = container!.querySelector('[data-slot="sources-trigger"]') as HTMLButtonElement;
    expect(trigger.textContent).toBe("Used 2 sources");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="sources-content"]')).toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const content = container!.querySelector('[data-slot="sources-content"]') as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.tagName).toBe("UL");
    expect(content.getAttribute("role")).toBe("region");
    expect(content.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(trigger.getAttribute("aria-controls")).toBe(content.id);
    expect(content.querySelectorAll('[data-slot="source"]')).toHaveLength(2);
  });

  test("honors controlled open and reports every toggle via onOpenChange", async () => {
    const changes: boolean[] = [];
    await render(
      <Sources open={false} onOpenChange={(open) => changes.push(open)}>
        <SourcesTrigger count={1} />
        <SourcesContent>
          <Source title="Alpha" />
        </SourcesContent>
      </Sources>,
    );
    const trigger = container!.querySelector('[data-slot="sources-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(container!.querySelector('[data-slot="sources-content"]')).toBeNull();
  });

  test("Source renders favicon, title, domain, excerpt and a sanitized link", async () => {
    await render(
      <Sources defaultOpen>
        <SourcesTrigger />
        <SourcesContent>
          <Source
            title="Docs"
            href=" https://smithers.sh/docs "
            domain="smithers.sh"
            excerpt="How sources work"
            faviconUrl="/favicons/smithers.sh.ico"
          />
        </SourcesContent>
      </Sources>,
    );

    const link = container!.querySelector(".sui-sources-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://smithers.sh/docs");
    const favicon = container!.querySelector(".sui-sources-favicon") as HTMLImageElement;
    expect(favicon.getAttribute("alt")).toBe("");
    expect(container!.querySelector(".sui-sources-title")?.textContent).toBe("Docs");
    expect(container!.querySelector(".sui-sources-domain")?.textContent).toBe("smithers.sh");
    expect(container!.querySelector(".sui-sources-excerpt")?.textContent).toBe("How sources work");
  });

  test("Source never loads a third-party favicon; it falls back to the initial tile", async () => {
    await render(
      <Sources defaultOpen>
        <SourcesTrigger />
        <SourcesContent>
          <Source title="A" domain="attacker.test" faviconUrl="https://attacker.test/pixel.png?run=secret" />
          <Source title="B" domain="bttacker.test" faviconUrl="//attacker.test/pixel.png" />
          <Source title="C" domain="cttacker.test" faviconUrl={"/\t/attacker.test/pixel.png"} />
          <Source title="D" domain="dttacker.test" faviconUrl="data:image/png;base64,iVBORw0KGgo=" />
        </SourcesContent>
      </Sources>,
    );
    expect(container!.innerHTML).not.toContain("attacker.test/pixel");
    expect([...container!.querySelectorAll(".sui-sources-favicon-fallback")].map((node) => node.textContent)).toEqual(["A", "B", "C"]);
    expect(container!.querySelector(".sui-sources-favicon")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("Source falls back to a domain-initial tile without a faviconUrl", async () => {
    await render(
      <Sources defaultOpen>
        <SourcesTrigger />
        <SourcesContent>
          <Source title="Example" domain="example.com" />
        </SourcesContent>
      </Sources>,
    );
    expect(container!.querySelector(".sui-sources-favicon")).toBeNull();
    const fallback = container!.querySelector(".sui-sources-favicon-fallback");
    expect(fallback?.textContent).toBe("E");
    expect(fallback?.getAttribute("aria-hidden")).toBe("true");
  });

  test("Source renders unsafe or absent hrefs as non-navigating spans", async () => {
    const navigated: string[] = [];
    await render(
      <Sources defaultOpen>
        <SourcesTrigger />
        <SourcesContent>
          <Source title="Unsafe" href="javascript:alert(1)" onNavigate={(href) => navigated.push(href)} />
          <Source title="Plain" />
        </SourcesContent>
      </Sources>,
    );
    expect(container!.querySelectorAll("a")).toHaveLength(0);
    const labels = container!.querySelectorAll(".sui-sources-label");
    expect(labels).toHaveLength(2);
    expect(navigated).toEqual([]);
  });

  test("Source onNavigate receives the sanitized href with the default prevented", async () => {
    const navigated: Array<{ href: string; prevented: boolean }> = [];
    await render(
      <Sources defaultOpen>
        <SourcesTrigger />
        <SourcesContent>
          <Source
            title="Docs"
            href="/docs/sources"
            onNavigate={(href, event) => navigated.push({ href, prevented: event.defaultPrevented })}
          />
        </SourcesContent>
      </Sources>,
    );
    const link = container!.querySelector(".sui-sources-link") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));
    expect(navigated).toEqual([{ href: "/docs/sources", prevented: true }]);
  });

  test("renders the compound anatomy under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(
      <Sources defaultOpen>
        <SourcesTrigger count={1} />
        <SourcesContent>
          <Source title="Dark" domain="dark.example" />
        </SourcesContent>
      </Sources>,
    );
    expect(container!.querySelector('[data-slot="sources"]')?.getAttribute("data-state")).toBe("open");
    expect(container!.querySelector('[data-slot="source"]')).not.toBeNull();
  });
});

describe("SourcesContent host props", () => {
  test("hands its ref the rendered list element", async () => {
    const ref = createRef<HTMLUListElement>();
    await render(
      <SourcesContent ref={ref}>
        <Source title="Alpha" />
      </SourcesContent>,
    );
    expect(ref.current).toBeInstanceOf(HTMLUListElement);
  });
});
