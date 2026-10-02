/**
 * The package's own entry point, loaded through its export map the way
 * `flows/review` loads it.
 *
 * `flows/review` imports this package under Node ESM, where a relative specifier
 * without an extension does not resolve. `tests/generatedThemes.test.ts` guards
 * that discipline for `src/themes/*` only, and the barrel's own specifiers were
 * checked nowhere in this package -- an extension dropped from `src/index.ts`
 * surfaced two packages away, in `flows/review/tests/diffsBarrelImport.test.ts`.
 *
 * The suite itself runs under Bun, which resolves extensionless specifiers, so
 * this has to be a real Node process. `process.execPath` is not that process:
 * under this package's only runner it is `bun`, and a child spawned from it
 * would have passed this test with the extensions removed. The binary comes
 * from `tests/nodeBinary.ts`, and the first assertion proves what it launched.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeExecutable } from "./nodeBinary.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("node ESM resolution", () => {
  test("spawns Node, not the Bun that runs this suite", () => {
    const probe = spawnSync(nodeExecutable, ["-p", "`${process.versions.bun} ${process.release.name}`"], {
      encoding: "utf8",
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("undefined node");
  }, 60_000);

  test("imports the barrel and every export it names", () => {
    const program = [
      `const m = await import("@smthrs/ui-styleguide");`,
      "const names = Object.keys(m).sort().join(',');",
      "if (typeof m.workflowUiThemeCss !== 'string') throw new Error('workflowUiThemeCss is not a string');",
      "if (typeof m.standaloneThemeCss() !== 'string') throw new Error('standaloneThemeCss() is not a string');",
      "if (Object.keys(m.themeRegistry).length !== 1) throw new Error('registry is not Paper');",
      "process.stdout.write(names);",
    ].join("\n");
    const result = spawnSync(nodeExecutable, ["--experimental-strip-types", "--input-type=module", "-e", program], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.split(",")).toEqual([
      "DEFAULT_THEME_KEY",
      "SOFT_TINT_AMOUNT",
      "STRONG_TINT_AMOUNT",
      "contrastRatio",
      "contrastRatioOf",
      "findTheme",
      "mixChannels",
      "mixColors",
      "reducedMotionCss",
      "serializeThemeVariant",
      "standaloneThemeCss",
      "themeCss",
      "themeRegistry",
      "workflowUiLayoutCss",
      "workflowUiPrimitiveCss",
      "workflowUiStyles",
      "workflowUiThemeCss",
    ]);
  }, 60_000);
});
