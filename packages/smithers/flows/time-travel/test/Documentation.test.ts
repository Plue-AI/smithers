import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ")

it.each(["../README.md", "../docs/api.md", "../CHANGELOG.md"])(
  "%s documents the shipped CLI and unified MCP access",
  (path) => {
    const text = read(path)
    expect(text).toContain("`smthrs runs inspect|replay|fork|rewind`")
    expect(text).toContain("https://smithers.sh/docs/reference/cli/")
    expect(text).toMatch(/MCP[^.]*only through the unified command tools/)
    expect(text).not.toMatch(/no (?:time-travel|CLI) verb|only a library API|`smithers` command-line/)
  }
)

it("documents the current documentation sync pipeline", () => {
  const text = read("../CHANGELOG.md")
  expect(text).not.toMatch(/docs\/Manifest\.ts|scripts\/docs\.mjs|docs\/pages\//)
  expect(text).toContain("contentSync")
  expect(text).toContain("apps/site/scripts/sync-api-docs.mjs")
})

const readRaw = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

it("names every public root export in the README table and the API reference", () => {
  const readme = read("../README.md")
  const api = read("../docs/api.md")
  for (
    const name of [
      "ReadOnlyTimeTravel",
      "readOnly",
      "forkWorkspaceName",
      "Position",
      "retainWorkspace",
      "engineEvents"
    ]
  ) {
    expect(readme, `README.md omits ${name}`).toContain(name)
    expect(api, `docs/api.md omits ${name}`).toContain(name)
  }
})

it("documents ReplayOptions.engineEvents and that inspect cannot supply it", () => {
  const api = read("../docs/api.md")
  expect(api).toContain("readonly engineEvents?: EngineEvent.Consumer | undefined")
  expect(api).toMatch(/versioned engine[^.]*only through `replay`|`inspect` takes no options/)
})

it("keeps the runtime requirement in its own README paragraph", () => {
  expect(readRaw("../README.md")).toMatch(/\n\nNode\.js 26\.4\.0 or later\./)
})

it("documents completed-prefix reuse and fresh child actions", () => {
  const guide = readRaw("../docs/guides/fork-a-run.md")
  const readme = readRaw("../README.md")

  expect(guide).toContain("## Keep completed steps from re-executing")
  expect(guide).toContain("This includes sealed, compensable, and irreversible actions")
  expect(guide).toContain("Actions first reached after the frame use the child's own identity")
  expect(guide).toContain("A frame inside an irreversible action")
  expect(readme).toContain("A durable fork reuses completed action results through its frame")
  expect(readme).toContain("child's own identity, even with a shared cache environment")
  expect(readme).toContain("https://time-travel.smithers.sh/guides/fork-a-run/")
})

it("tells a handler author that receipts persist unredacted and must not carry credentials", () => {
  const guide = read("../docs/guides/compensate-an-effect.md")
  expect(guide).toContain("without the redaction pass")
  expect(guide).toContain("A receipt must never carry a credential.")
})

it("documents the rewind rate limiter as a knob the composition supplies", () => {
  const api = read("../docs/api.md")
  expect(api).toContain("`rateLimit` | `(input) => Effect<RateLimitDecision, TimeTravelError>`")
  expect(api).toContain("TimeTravel.layerWith({")
  expect(read("../docs/troubleshooting.md")).toContain("TimeTravel.layerWith({ rateLimit })")
  // The code is only raised by a limiter a build supplied, so no page may
  // describe it as something the package applies on its own.
  for (const path of ["../docs/api.md", "../docs/troubleshooting.md", "../docs/guides/rewind-a-run.md"]) {
    expect(read(path), `${path} omits Options.rateLimit beside rate_limited`).toContain("`Options.rateLimit`")
  }
})
