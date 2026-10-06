import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
// Writes to real GitHub repositories are forbidden in tests. Preload only the
// external GitHub and git-process boundaries; execute the publication CLI.
for (const command of ["assets", "tap"]) test(`${command} refuses absent qualification before any external write`, () => {
  const dir = mkdtempSync(join(tmpdir(), "homebrew-publication-"))
  try {
    const preload = join(dir, "fake.mjs")
    const log = join(dir, "requests.json")
    writeFileSync(preload, `import cp from "node:child_process";
      import {syncBuiltinESMExports} from "node:module";
      import {writeFileSync} from "node:fs";
      cp.execFileSync = (cmd, args) => args[0] === "rev-parse" ? "${"a".repeat(40)}\\n" : "";
      syncBuiltinESMExports();
      const requests = [];
      process.on("exit", () => writeFileSync(${JSON.stringify(log)}, JSON.stringify(requests)));
      globalThis.fetch = async (url, options) => {
        requests.push({url, method: options?.method ?? "GET"});
        if (options?.method && options.method !== "GET") throw new Error("unexpected mutation");
        return Response.json({check_runs: []});
      };`)
    const child = spawnSync(process.execPath, ["--import", preload, resolve("scripts/homebrew-publish.mjs"), command, dir, "v1.2.3"], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, GITHUB_TOKEN: "fixture", RELEASE_QUALIFICATION_TOKEN: "fixture", RELEASE_QUALIFICATION_APP_ID: "42" }
    })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /Missing authenticated C-REL-02/)
    const requests = JSON.parse(readFileSync(log, "utf8"))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, "GET")
    assert.match(requests[0].url, /\/check-runs\?per_page=100$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
