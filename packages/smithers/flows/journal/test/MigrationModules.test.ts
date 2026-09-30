/**
 * The migration modules export named bindings and no default export.
 *
 * The CommonJS build converts each source file with esbuild in Node interop
 * mode. There a default import of a sibling module resolves to that module's
 * whole exports object (`{ __esModule, default }`) instead of the Effect, so
 * `set.migrations["0001_initial"].pipe` was undefined under `require` while
 * the ESM build kept working. A named export has one shape in both formats,
 * and the second case here fails as soon as a default export comes back.
 */
import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as Initial from "../src/migrations/0001_initial.ts"
import * as Checkpoints from "../src/migrations/0002_checkpoints.ts"
import * as StartupIndex from "../src/migrations/0003_startup_index.ts"
import * as Dedup from "../src/migrations/0004_dedup.ts"
import * as RunEventType from "../src/migrations/0005_run_event_type.ts"
import * as Consensus from "../src/migrations/0006_consensus.ts"

describe("migration modules", () => {
  it("registers an Effect for every migration in the set", () => {
    const entries = Object.entries(Migrations.set.migrations)
    expect(entries.map(([id]) => id)).toEqual([
      "0001_initial",
      "0002_checkpoints",
      "0003_startup_index",
      "0004_dedup",
      "0005_run_event_type",
      "0006_consensus"
    ])
    for (const [, migration] of entries) {
      expect(typeof migration.pipe).toBe("function")
    }
  })

  it("exports each migration as a named binding and no default", () => {
    expect("default" in Initial).toBe(false)
    expect("default" in Checkpoints).toBe(false)
    expect("default" in StartupIndex).toBe(false)
    expect("default" in Dedup).toBe(false)
    expect("default" in RunEventType).toBe(false)
    expect("default" in Consensus).toBe(false)
    expect(typeof Consensus.consensus.pipe).toBe("function")
    expect(typeof RunEventType.runEventType.pipe).toBe("function")
    expect(typeof Dedup.dedup.pipe).toBe("function")
    expect(typeof Initial.initial.pipe).toBe("function")
    expect(typeof Checkpoints.checkpoints.pipe).toBe("function")
    expect(typeof StartupIndex.startupIndex.pipe).toBe("function")
  })

  it("keeps one src/migrations file per migration id, with no gaps", () => {
    const files = readdirSync(new URL("../src/migrations/", import.meta.url)).filter((name) => name.endsWith(".ts"))
    expect(files.sort()).toEqual(Object.keys(Migrations.set.migrations).map((id) => `${id}.ts`))
  })
})
