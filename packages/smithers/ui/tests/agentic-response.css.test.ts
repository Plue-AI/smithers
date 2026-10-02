import { describe, expect, test } from "bun:test";
import { reducedMotionCss, workflowUiThemeCss } from "@smthrs/ui-styleguide";
import { agenticResponseCss, smithersUiCss } from "../src/uiCss";

describe("agentic response CSS", () => {
  test("ships caret animation under the shared reduced-motion policy", () => {
    expect(agenticResponseCss).toContain("@keyframes sui-caret-blink");
    expect(agenticResponseCss).not.toContain("@media (prefers-reduced-motion: reduce)");
    expect(smithersUiCss).toContain(reducedMotionCss);
  });

  test("styles code through the house code tokens and pins wrapping anatomy", () => {
    expect(agenticResponseCss).toContain("background:var(--code-bg, #efeae0)");
    expect(agenticResponseCss).toContain("color:var(--code-text, #211d18)");
    expect(agenticResponseCss).toContain(
      ".sui-codeblock[data-wrap='true'] .sui-codeblock-body code { min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }",
    );
    expect(agenticResponseCss).not.toContain("\n[data-wrap='true'] .sui-codeblock-body code");
    expect(agenticResponseCss).toContain(".sui-codeblock-lineno");
    expect(agenticResponseCss).toContain("user-select:none");
    expect(agenticResponseCss).toContain(".sui-codeblock-action:focus-visible");
  });

  test("resolves response and code colors through the dark theme token surface", () => {
    const darkBlock = workflowUiThemeCss.match(/:root\[data-theme='dark'\] \{ ([^}]*) \}/)?.[1] ?? "";
    expect(darkBlock).toContain("--text-muted:#a8a193");
    expect(darkBlock).toContain("--code-bg:#101917");
    expect(darkBlock).toContain("--code-text:#ece7db");
    expect(agenticResponseCss).toContain("background:var(--text-muted, #665f54)");
    expect(agenticResponseCss).toContain("background:var(--code-bg, #efeae0)");
    expect(agenticResponseCss).toContain("color:var(--code-text, #211d18)");
  });
});
