import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * The two deployment workflows this lane owns, and the rulings that hold them.
 *
 * They live in this suite because `.github/workflows/{apps-deploy,canary}.yml`
 * ship with `apps/review` under one owner and this is that owner's only test
 * runner. `apps/server/scripts/canary/workflow-wiring.test.ts` grades a
 * different property, that every probe has a caller, and neither file
 * asserts the other's.
 */
const workflowsDir = fileURLToPath(new URL("../../../../.github/workflows/", import.meta.url));
const appsDir = fileURLToPath(new URL("../../../", import.meta.url));

const readWorkflow = <T>(name: string): T => parse(readFileSync(`${workflowsDir}${name}`, "utf8")) as T;

describe("canary.yml probes the owning repository", () => {
  /*
   * The fork guard is the whole condition. A repository variable that silently
   * disables monitoring is a feature flag: CANARY_ENABLED left the canary
   * skipped for every one of its first 258 scheduled runs.
   */
  test("the owning repository runs every schedule; only a fork is skipped", () => {
    const canary = readWorkflow<{ on: Record<string, unknown>; jobs: Record<string, { if?: string }> }>("canary.yml");
    expect(canary.jobs.probe.if).toBe("github.repository == 'smithersai/smithers'");
    expect(Object.keys(canary.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const source = readFileSync(`${workflowsDir}canary.yml`, "utf8");
    expect(source).not.toContain("vars.CANARY_ENABLED");
    expect(source).not.toContain("CANARY_BROWSER_FAILED");
  });

  test("the browser verdict, the drill and the operator assignment reach the alert", () => {
    const source = readFileSync(`${workflowsDir}canary.yml`, "utf8");
    expect(source).toContain("bun scripts/canary-browser.ts");
    expect(source).toContain("--browser \"$BROWSER_RESULT\"");
    expect(source).toContain("--force-fail \"$FORCE_FAILURE\"");
    expect(source).toContain("--assignee \"$ASSIGNEES\"");
    expect(source).toContain("name: canary-browser");
  });
});

describe("apps-deploy.yml calls what this workspace still has", () => {
  /** The declared scripts of one manifest, by its `name`. */
  function scripts(dir: string): Set<string> {
    const manifest = JSON.parse(readFileSync(`${appsDir}${dir}/package.json`, "utf8")) as { scripts?: Record<string, string> };
    return new Set(Object.keys(manifest.scripts ?? {}));
  }

  test("every gated target names a package directory that still exists", () => {
    // A label on a directory that left the tree would gate on nothing. The
    // superset over ci.yml's apps-e2e targets is graded in
    // apps/server/scripts/canary/workflow-wiring.test.ts.
    const text = readFileSync(`${workflowsDir}apps-deploy.yml`, "utf8");
    const dirs = [...text.matchAll(/smthrs (?:build|test|ci) '\/\/apps\/([^/:']+)/g)].map((match) => match[1]!);
    expect([...new Set(dirs)].sort()).toEqual(["app", "server", "site", "tui"]);
    const missing = dirs.filter((dir) => !readdirSync(appsDir).includes(dir) || !readdirSync(`${appsDir}${dir}`).includes("PACKAGE.ts"));
    expect(missing).toEqual([]);
  });

  test("the deploy still calls the server app's own deploy scripts", () => {
    const text = readFileSync(`${workflowsDir}apps-deploy.yml`, "utf8");
    const server = scripts("server");
    expect(server.has("deploy")).toBe(true);
    expect(server.has("deploy:dry")).toBe(true);
    expect(text).toContain("pnpm --filter smithers-server run deploy:dry");
    expect(text).toContain("pnpm --filter smithers-server run deploy");
  });
});
