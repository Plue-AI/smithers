import { testIo } from "../io.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGh as runGhImpl } from "../../src/github/runGh.ts";

// A checked-in, executable fake `gh`. The log destination is passed via
// $SMITHERS_FAKE_GH_LOG so the fixture records its invocation without the test
// writing an executable at runtime.
const FAKE_GH = fileURLToPath(new URL("./fixtures/fake-gh", import.meta.url));

afterEach(() => {
  delete process.env.SMITHERS_GH_BIN;
  delete process.env.SMITHERS_FAKE_GH_LOG;
});

describe("runGh", () => {
  test("executes gh in the repo directory, passes stdin, and reports stderr on failure", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-review-gh-"));
    const log = join(tmp, "gh-log.json");
    process.env.SMITHERS_GH_BIN = FAKE_GH;
    process.env.SMITHERS_FAKE_GH_LOG = log;

    try {
      const stdout = await runGh(tmp, ["api", "ok"], "payload");
      expect(stdout).toBe("fixture stdout");
      await expect(Bun.file(log).json()).resolves.toEqual({
        cwd: await realpath(tmp),
        args: ["api", "ok"],
        input: "payload",
      });
      await expect(runGh(tmp, ["api", "fail"], "")).rejects.toThrow("fixture failure");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

const runGh = (...args: Parameters<typeof runGhImpl>) => testIo(() => runGhImpl(...args));
