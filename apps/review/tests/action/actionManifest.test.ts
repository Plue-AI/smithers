import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type ActionStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

function readSteps(): ActionStep[] {
  const manifest = parse(readFileSync(new URL("../../action/action.yml", import.meta.url), "utf8")) as {
    runs?: { steps?: ActionStep[] };
  };
  return manifest.runs?.steps ?? [];
}

describe("review action manifest", () => {
  test("pins every external action to an immutable commit", () => {
    for (const step of readSteps().filter((step) => step.uses)) {
      expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
  });

  test("installs only review and its dependency closure", () => {
    const install = readSteps().find((step) => step.name === "Install smithers dependencies");
    expect(install?.run).toContain('--filter @smthrs/review...');
    expect(install?.run).toContain('--frozen-lockfile');
  });

  test("pins pnpm to the workspace's own version", () => {
    const setup = readSteps().find((step) => step.uses?.startsWith("pnpm/action-setup"));
    // The action installs this repository's workspace with --frozen-lockfile.
    // A pnpm whose lockfile format differs from the committed one fails that
    // install, so the pin has to track the root package manager.
    expect(setup?.with?.version).toBe("11.25.0");
  });

  test("pins bun and node to the runtimes the workspace gates run on", () => {
    // The action installs this repository's workspace and then runs its
    // TypeScript sources directly, so its interpreters are the workspace's own
    // (Node 26.4.0, Bun 1.4.1). A looser or older pin runs the
    // review on a runtime no gate in this repository ever exercised — the Node
    // resolution contract in tests/nodeRuntimeResolution.test.ts is exactly the
    // kind of thing that differs between them.
    const steps = readSteps();
    const bun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun"));
    expect(bun?.with?.["bun-version"]).toBe("1.4.1");
    const node = steps.find((step) => step.uses?.startsWith("actions/setup-node"));
    expect(node?.with?.["node-version"]).toBe("26.4.0");
  });

  test("installs no agent CLI: rc.0 seats are provider routes, not subprocesses", () => {
    const runs = readSteps().map((step) => step.run ?? "").join("\n");
    expect(runs).not.toContain("@openai/codex");
    expect(runs).not.toContain("@anthropic-ai/claude-code");
  });

  test("forwards no provider key and no raw subscription secret", () => {
    const review = readSteps().find((step) => step.name === "Authenticate and review");
    const env = (review as { env?: Record<string, string> }).env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_AUTH_JSON).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // #1546: Bun reads bunfig.toml from its cwd. A `bun` step started inside the
  // caller's checkout evaluates that repo's `preload`, and because the action
  // never installs the caller's checkout, Bun auto-installs the preload's
  // imports out of `~/.bun/install/cache` — the intermittent
  // `unist-util-visit-parents/do-not-use-color` failure. Every bun step must
  // therefore stay inside the action's own installed tree.
  test("runs every bun step inside the action's tree, never the caller's checkout", () => {
    const bunSteps = readSteps().filter((step) => /(^|\s)bun\s/.test(step.run ?? ""));

    expect(bunSteps.length).toBeGreaterThan(0);
    for (const step of bunSteps) {
      expect(step["working-directory"]).toStartWith("${{ github.action_path }}");
    }
  });

  test("checks the caller's repository out after the gate and before the review", () => {
    const steps = readSteps();
    const gate = steps.findIndex((step) => step.name === "Gate the event");
    const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout"));
    const review = steps.findIndex((step) => step.name === "Authenticate and review");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeGreaterThan(gate);
    expect(review).toBeGreaterThan(checkout);
  });

  // pr-review.yml runs this action from the checkout it reviews, so the
  // install lands inside the caller's workspace. actions/checkout cleans an
  // existing checkout with `git clean -ffdx`, which deletes ignored files, so a
  // checkout after the install would leave the review with no node_modules.
  test("checks the caller's repository out before installing the action's dependencies", () => {
    const steps = readSteps();
    const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout"));
    const install = steps.findIndex((step) => step.name === "Install smithers dependencies");
    expect(install).toBeGreaterThan(checkout);
    expect(checkout).toBeGreaterThanOrEqual(0);
  });
});


test("the manual setup example pins actions and installs the review closure", () => {
  const guide = readFileSync(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8");
  const yaml = [...guide.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((match) => parse(match[1]!));
  const steps = yaml.flatMap((document) => document.jobs?.review?.steps ?? []) as ActionStep[];
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps.filter((step) => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  expect(steps.find((step) => step.uses?.startsWith("actions/setup-node"))?.with?.["node-version"])
    .toBe(readSteps().find((step) => step.uses?.startsWith("actions/setup-node"))?.with?.["node-version"]);
  expect(steps.find((step) => step.run?.includes("install"))?.run).toContain("--filter @smthrs/review...");
});
