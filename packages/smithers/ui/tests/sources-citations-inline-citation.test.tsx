/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  CitationCard,
  CitationCarousel,
  CitationQuote,
  InlineCitation,
  type CitationSource,
} from "../src/agentic/InlineCitation";

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

const alpha: CitationSource = {
  id: "a",
  title: "Alpha report",
  url: "https://alpha.example/report",
  domain: "alpha.example",
  excerpt: "Alpha says so.",
};
const beta: CitationSource = {
  id: "b",
  title: "Beta brief",
  url: "https://beta.example/brief",
  domain: "beta.example",
  quote: "Beta, verbatim.",
};

function trigger(): HTMLButtonElement {
  return container!.querySelector('[data-slot="inline-citation-trigger"]') as HTMLButtonElement;
}

function content(): HTMLElement | null {
  return container!.querySelector('[data-slot="inline-citation-content"]');
}

describe("InlineCitation with sources", () => {
  test("one source toggles an inline region containing a CitationCard", async () => {
    await render(<InlineCitation index={2} label="Alpha" sources={[alpha]} />);
    const button = trigger();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(content()).toBeNull();

    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const region = content()!;
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Sources for citation 2");
    expect(button.getAttribute("aria-controls")).toBe(region.id);

    const link = region.querySelector(".sui-citation-card-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://alpha.example/report");
    expect(link.textContent).toBe("Alpha report");
    expect(region.querySelector(".sui-citation-card-domain")?.textContent).toBe("alpha.example");
    expect(region.querySelector(".sui-citation-card-excerpt")?.textContent).toBe("Alpha says so.");
  });

  test("multiple sources render a keyboard-accessible carousel", async () => {
    await render(<InlineCitation index={1} label="Two sources" sources={[alpha, beta]} defaultOpen />);
    const carousel = container!.querySelector('[data-slot="citation-carousel"]') as HTMLElement;
    expect(carousel).not.toBeNull();
    expect(carousel.querySelector(".sui-citation-card-title")?.textContent).toContain("Alpha report");

    const index = carousel.querySelector('[data-slot="citation-carousel-index"]')!;
    expect(index.textContent).toBe("1 of 2");
    expect(index.getAttribute("aria-live")).toBe("polite");

    const prev = carousel.querySelector('[data-slot="citation-carousel-previous"]') as HTMLButtonElement;
    const next = carousel.querySelector('[data-slot="citation-carousel-next"]') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);

    await act(async () => next.click());
    expect(index.textContent).toBe("2 of 2");
    expect(carousel.querySelector(".sui-citation-card-title")?.textContent).toContain("Beta brief");
    expect(next.disabled).toBe(true);

    await act(async () => {
      prev.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(index.textContent).toBe("1 of 2");
  });

  test("Escape closes the preview and returns focus to the trigger", async () => {
    await render(<InlineCitation index={4} label="Alpha" sources={[alpha]} defaultOpen />);
    const button = trigger();
    const link = content()!.querySelector(".sui-citation-card-link") as HTMLAnchorElement;
    await act(async () => link.focus());
    expect(document.activeElement).toBe(link);

    await act(async () => {
      content()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(content()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  test("focus opens the preview after 300ms when uncontrolled and openOnHover", async () => {
    await render(<InlineCitation index={1} label="Alpha" sources={[alpha]} />);
    const button = trigger();
    await act(async () => {
      button.focus();
      await new Promise((resolve) => setTimeout(resolve, 380));
    });
    expect(content()).not.toBeNull();
  });

  test("honors controlled open and still calls onOpenChange on toggle", async () => {
    const changes: boolean[] = [];
    await render(
      <InlineCitation
        index={1}
        label="Alpha"
        sources={[alpha]}
        open={false}
        onOpenChange={(open) => changes.push(open)}
      />,
    );
    const button = trigger();
    await act(async () => button.click());
    expect(changes).toEqual([true]);
    expect(content()).toBeNull();
  });

  test("renders the sources preview under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<InlineCitation index={1} label="Alpha" sources={[alpha]} defaultOpen />);
    expect(container!.querySelector('[data-slot="inline-citation"]')).not.toBeNull();
    expect(content()).not.toBeNull();
  });
});

describe("CitationCard", () => {
  test("sanitizes the source url and renders the quote through CitationQuote", async () => {
    await render(
      <CitationCard
        source={{ id: "x", title: "Unsafe", url: "javascript:alert(1)", quote: "quoted words", domain: "x.example" }}
      />,
    );
    expect(container!.querySelector("a")).toBeNull();
    expect(container!.querySelector(".sui-citation-card-title")?.textContent).toBe("Unsafe");
    const quote = container!.querySelector('[data-slot="citation-quote"]');
    expect(quote?.tagName).toBe("BLOCKQUOTE");
    expect(quote?.textContent).toContain("quoted words");
  });

  test("never loads a third-party favicon; same-origin favicons still render", async () => {
    await render(
      <>
        <CitationCard source={{ id: "r", title: "Remote", domain: "attacker.test", faviconUrl: "https://attacker.test/p.png?run=1" }} />
        <CitationCard source={{ id: "l", title: "Local", domain: "smithers.sh", faviconUrl: "/favicons/smithers.sh.ico" }} />
      </>,
    );
    expect(container!.innerHTML).not.toContain("attacker.test/p.png");
    expect(container!.querySelector(".sui-citation-favicon-fallback")?.textContent).toBe("A");
    expect([...container!.querySelectorAll(".sui-citation-favicon")].map((node) => node.getAttribute("src"))).toEqual(["/favicons/smithers.sh.ico"]);
  });
});

describe("CitationCarousel", () => {
  test("controlled index drives the visible card", async () => {
    await render(<CitationCarousel sources={[alpha, beta]} index={1} />);
    expect(container!.querySelector('[data-slot="citation-carousel-index"]')?.textContent).toBe("2 of 2");
    expect(container!.querySelector(".sui-citation-card-title")?.textContent).toContain("Beta brief");
  });

  test("reports every navigation via onIndexChange", async () => {
    const changes: number[] = [];
    await render(<CitationCarousel sources={[alpha, beta]} onIndexChange={(index) => changes.push(index)} />);
    const next = container!.querySelector('[data-slot="citation-carousel-next"]') as HTMLButtonElement;
    await act(async () => next.click());
    expect(changes).toEqual([1]);
    await act(async () => {
      next.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(changes).toEqual([1, 0]);
  });
});

describe("CitationQuote", () => {
  test("renders the quote with an optional cite slot", async () => {
    await render(
      <CitationQuote quote="Exact words">
        <cite>alpha.example</cite>
      </CitationQuote>,
    );
    const quote = container!.querySelector('[data-slot="citation-quote"]')!;
    expect(quote.querySelector("p")?.textContent).toBe("Exact words");
    expect(quote.querySelector("cite")?.textContent).toBe("alpha.example");
  });
});
