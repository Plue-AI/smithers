/** @jsxImportSource react */
/**
 * Pins marker semantics and the shimmer's theme token palette.
 *
 * @since 0.1.0
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Marker, Shimmer } from "../src/index";
import { chatScrollerCss } from "../src/uiCss";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  removeDarkThemeStyles();
});

describe("Marker", () => {
  test("keeps separator text accessible without role=separator", () => {
    const html = renderToStaticMarkup(<Marker>Earlier</Marker>);
    expect(html).toContain("Earlier");
    expect(html).not.toContain('role="separator"');
    expect(html).toContain('data-variant="separator"');
  });

  test("rejects a native separator role override", () => {
    const html = renderToStaticMarkup(<Marker role="separator">Earlier</Marker>);
    expect(html).not.toContain('role="separator"');
  });

  test("adds polite live semantics only when requested", () => {
    expect(renderToStaticMarkup(<Marker live>Working</Marker>)).toContain('aria-live="polite"');
    expect(renderToStaticMarkup(<Marker>Static</Marker>)).not.toContain("aria-live");
    expect(renderToStaticMarkup(<Marker aria-live="assertive">Static</Marker>)).not.toContain("aria-live");
  });

  test("wraps shimmering status labels", () => {
    const html = renderToStaticMarkup(
      <Marker variant="status" shimmer>
        Streaming
      </Marker>,
    );
    expect(html).toContain('data-slot="shimmer"');
    expect(html).toContain('data-active="true"');
  });

  test("renders under the dark theme", () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Marker variant="note">Dark note</Marker>);
    document.body.appendChild(host);
    const marker = host.querySelector<HTMLElement>('[data-slot="marker"]')!;
    expect(getComputedStyle(marker).color).toBe("#a8a193");
    host.remove();
  });
});

describe("Shimmer and scroll fade CSS", () => {
  test("always carries the root class while active controls styling", () => {
    const active = renderToStaticMarkup(<Shimmer>Live</Shimmer>);
    const inactive = renderToStaticMarkup(<Shimmer active={false}>Idle</Shimmer>);
    expect(active).toContain('class="sui-shimmer"');
    expect(inactive).toContain('class="sui-shimmer"');
    expect(inactive).toContain('data-active="false"');
    expect(chatScrollerCss).toContain(".sui-shimmer { display:inline; }");
    expect(chatScrollerCss).toContain(".sui-shimmer[data-active='true']");
    expect(chatScrollerCss).not.toContain(".sui-shimmer { background:");
  });

  test("ships shimmer, attachment, and edge-fade recipes without a local motion policy", () => {
    expect(chatScrollerCss).not.toContain("@media (prefers-reduced-motion: reduce)");
    // The shimmer keyframes are owned by sharedCss (defined exactly once);
    // this sheet references the animation by name.
    expect(chatScrollerCss).toContain("animation:sui-shimmer-sweep");
    expect(chatScrollerCss).not.toContain("@keyframes sui-shimmer-sweep");
    expect(chatScrollerCss).toContain("@keyframes sui-attachment-indeterminate");
    expect(chatScrollerCss).toContain(".sui-scroll-fade[data-fade-top='true'][data-fade-bottom='true']");
    expect(chatScrollerCss).toContain("transparent, black 32px, black calc(100% - 32px), transparent");
  });

  test("renders under the dark theme", () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Shimmer>Dark live text</Shimmer>);
    document.body.appendChild(host);
    const shimmer = host.querySelector<HTMLElement>('[data-slot="shimmer"]')!;
    const theme = getComputedStyle(document.documentElement);
    expect(theme.getPropertyValue("--text").trim()).toBe("#ece7db");
    expect(theme.getPropertyValue("--text-muted").trim()).toBe("#a8a193");
    expect(chatScrollerCss).toContain(
      "linear-gradient(90deg, var(--text-muted, #665f54) 35%, var(--text, #211d18) 50%, var(--text-muted, #665f54) 65%)",
    );
    // Happy DOM only resolves the first custom property in a gradient. Resolve
    // its remaining references against the actual theme, keeping the applied
    // recipe and every color stop under assertion.
    const gradient = getComputedStyle(shimmer).backgroundImage.replace(
      /var\((--[\w-]+),\s*([^)]+)\)/g,
      (_reference, name: string, fallback: string) => theme.getPropertyValue(name).trim() || fallback,
    );
    expect(gradient).toBe(
      "linear-gradient(90deg, #a8a193 35%, #ece7db 50%, #a8a193 65%)",
    );
    host.remove();
  });
});
