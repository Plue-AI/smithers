import { describe, expect, test } from "bun:test";
import { reducedMotionCss } from "@smthrs/ui-styleguide";
import { agenticReasoningCss, sharedCss, smithersUiCss } from "../src/uiCss";

describe("agentic reasoning CSS", () => {
  test("pins shimmer motion under the shared reduced-motion policy", () => {
    // The keyframes are owned by sharedCss (defined once, composed first);
    // this sheet only references the animation by name.
    expect(agenticReasoningCss).toContain("animation:sui-shimmer-sweep");
    expect(agenticReasoningCss).not.toContain("@keyframes");
    expect(sharedCss).toContain("@keyframes sui-shimmer-sweep");
    expect(agenticReasoningCss).not.toContain("@media (prefers-reduced-motion: reduce)");
    expect(smithersUiCss).toContain(reducedMotionCss);
  });

  test("relies on the shared screen-reader utility, defined exactly once", () => {
    expect(sharedCss).toContain(
      ".sui-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }",
    );
    expect(smithersUiCss.match(/\.sui-sr-only \{/g)).toHaveLength(1);
  });

  test("routes active chain steps through the shared running color", () => {
    expect(agenticReasoningCss).toContain(
      ".sui-cot-step[data-status-class='run'] .sui-cot-step-dot { background:var(--brand, #0f766e); }",
    );
    expect(agenticReasoningCss).not.toContain(
      ".sui-cot-step[data-status='running'] .sui-cot-step-dot { background:var(--info",
    );
  });
});
