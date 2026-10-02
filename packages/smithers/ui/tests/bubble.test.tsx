/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Bubble, bubbleVariants, SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mountedRoot = root;
    await act(async () => mountedRoot.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.documentElement.removeAttribute("data-theme");
  removeDarkThemeStyles();
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  const resizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mountedRoot = root;
  try {
    await act(async () => mountedRoot.render(element));
  } finally {
    globalThis.ResizeObserver = resizeObserver;
  }
}

describe("Bubble", () => {
  test("renders role variants and derives their alignment", () => {
    const user = renderToStaticMarkup(<Bubble variant="user">hello</Bubble>);
    expect(user).toContain("sui-bubble-user");
    expect(user).toContain('data-align="end"');
    expect(bubbleVariants({ variant: "system" })).toContain("sui-bubble-system");
  });

  test("clamp keeps content mounted and toggles data-expanded with visible labels", async () => {
    await render(<Bubble collapsible>long content</Bubble>);
    const bubble = container!.querySelector<HTMLElement>('[data-slot="bubble"]')!;
    const content = container!.querySelector('[data-slot="bubble-content"]');
    const button = container!.querySelector<HTMLButtonElement>('[data-slot="bubble-toggle"]')!;
    expect(content).not.toBeNull();
    expect(bubble.getAttribute("data-expanded")).toBe("false");
    expect(button.textContent).toBe("Show more");
    await act(async () => button.click());
    expect(content).not.toBeNull();
    expect(bubble.getAttribute("data-expanded")).toBe("true");
    expect(button.textContent).toBe("Show less");
  });

  test("controlled expansion requests a round-trip without self-managing", async () => {
    const requests: boolean[] = [];
    const view = (expanded: boolean) => (
      <Bubble collapsible expanded={expanded} onExpandedChange={(next) => requests.push(next)}>
        content
      </Bubble>
    );
    await render(view(false));
    const button = container!.querySelector<HTMLButtonElement>('[data-slot="bubble-toggle"]')!;
    await act(async () => button.click());
    expect(requests).toEqual([true]);
    expect(container!.querySelector('[data-slot="bubble"]')?.getAttribute("data-expanded")).toBe("false");
    await act(async () => root!.render(view(true)));
    expect(container!.querySelector('[data-slot="bubble"]')?.getAttribute("data-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="bubble-toggle"]')?.textContent).toBe("Show less");
  });

  test("toggle is a native button with clamp accessibility wiring", () => {
    const html = renderToStaticMarkup(<Bubble collapsible>content</Bubble>);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
    expect(html).toContain("Show more");
  });

  test("renders under the dark theme", async () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    await render(<Bubble variant="assistant">dark</Bubble>);
    const bubble = container!.querySelector<HTMLElement>('[data-slot="bubble"]')!;
    expect(getComputedStyle(bubble).backgroundColor).toBe("#1a2422");
  });
});
