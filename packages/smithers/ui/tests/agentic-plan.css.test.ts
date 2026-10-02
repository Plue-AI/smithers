import { describe, expect, test } from "bun:test";
import { reducedMotionCss } from "@smthrs/ui-styleguide";
import { agenticPlanCss, smithersUiCss } from "../src/uiCss";

describe("agentic plan css", () => {
  test("relies on the shared screen-reader utility, defined exactly once", () => {
    expect(smithersUiCss).toContain(
      ".sui-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }",
    );
    expect(smithersUiCss.match(/\.sui-sr-only \{/g)).toHaveLength(1);
  });

  test("pins shimmer animation and delegates reduced motion to the shared policy", () => {
    // The keyframes live in sharedCss (defined once, composed first); the
    // sheet references the shared animation by name.
    expect(agenticPlanCss).toContain("animation:sui-shimmer-sweep");
    expect(agenticPlanCss).not.toContain("@keyframes");
    expect(agenticPlanCss).toContain(".sui-plan-title[data-shimmer='true']");
    expect(agenticPlanCss).not.toContain("@media (prefers-reduced-motion: reduce)");
    expect(smithersUiCss).toContain(reducedMotionCss);
  });

  test("routes plan and task dots through the shared status colors", () => {
    expect(agenticPlanCss).toContain(
      ".sui-plan-step[data-status-class='run'] .sui-plan-step-dot { background:var(--brand, #0f766e); }",
    );
    expect(agenticPlanCss).toContain(".sui-taskitem-run .sui-taskitem-dot { background:var(--brand, #0f766e); }");
    expect(agenticPlanCss).toContain(
      ".sui-taskitem-muted .sui-taskitem-dot { background:var(--text-muted, #665f54); }",
    );
    expect(agenticPlanCss).not.toContain(
      ".sui-plan-step[data-status='running'] .sui-plan-step-dot { background:var(--info",
    );
    expect(agenticPlanCss).not.toContain(".sui-taskitem-run .sui-taskitem-dot { background:var(--info");
  });
});
