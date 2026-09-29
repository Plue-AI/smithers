import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

test("deployment security check focuses on the active config and scripts", () => {
  const root = new URL("../../..", import.meta.url)
  const script = `
    const { Package } = await import(${JSON.stringify(new URL("../PACKAGE.ts", import.meta.url).href)});
    const { Smithers } = await import("@smthrs/targets");
    const rubric = Smithers.Target.metadata(Package.security).attrs.rubric;
    const focus = rubric.split("[deploy-scripts]")[1].split("Focus: ")[1].split("\\n")[0];
    console.log(JSON.stringify(focus));
  `
  const loaded = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8"
  })

  expect(loaded.status).toBe(0)
  const focus = JSON.parse(loaded.stdout) as string
  expect(focus).toBe("apps/server/scripts/**, apps/server/wrangler.jsonc")
})
