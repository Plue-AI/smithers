import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Catalog from "../src/Catalog.ts"
import { runOn } from "./harness.ts"

const entry: Catalog.Entry = {
  description: "search the tree",
  handler: () => Effect.succeed({ files: [] }),
  name: "grep"
}

describe("Catalog", () => {
  it("looks entries up by name", () => {
    const catalog = Catalog.make([entry])
    expect(catalog.entries).toEqual([entry])
    expect(catalog.lookup("grep")).toEqual(entry)
    expect(catalog.lookup("grep")?.handler).toBe(entry.handler)
    expect(catalog.lookup("missing")).toBeUndefined()
  })

  it("snapshots caller-owned entry declarations", () => {
    const mutable = {
      description: "d",
      handler: entry.handler,
      name: "before"
    }
    const catalog = Catalog.make([mutable])
    mutable.name = "after"
    mutable.description = "changed"

    expect(catalog.entries[0]?.name).toBe("before")
    expect(catalog.entries[0]?.description).toBe("d")
    expect(catalog.lookup("before")?.name).toBe("before")
    expect(catalog.lookup("after")).toBeUndefined()
  })

  it("snapshots the caller's entries array", () => {
    const other: Catalog.Entry = { ...entry, name: "other" }
    const list = [entry]
    const catalog = Catalog.make(list)

    list.push(other)
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.lookup(other.name)).toBeUndefined()
    list.pop()
    expect(catalog.entries).toHaveLength(1)
  })

  it("snapshots declared capabilities", () => {
    const capabilities = ["fs:read:src/**"]
    const catalog = Catalog.make([{ ...entry, capabilities }])
    const declared = catalog.entries[0] as Catalog.Entry
    const digest = Catalog.entryDigest(declared)

    capabilities.push("fs:write:src/**")
    expect(declared.capabilities).toEqual(["fs:read:src/**"])
    expect(Catalog.entryDigest(declared)).toBe(digest)
  })

  it("keeps system entries last-wins against host impostors", () => {
    // Replay determinism rests on system entries being indexed after host
    // declarations, so a host cannot shadow the journaled clock or RNG.
    const catalog = Catalog.make(Catalog.withSystem([
      {
        description: "an impostor clock",
        handler: () => Effect.succeed(0),
        name: "sys/now"
      },
      {
        description: "an impostor generator",
        handler: () => Effect.succeed(0),
        name: "sys/random"
      }
    ]))

    expect(catalog.lookup("sys/now")?.description)
      .toBe("The current wall-clock time in epoch milliseconds, journaled for replay")
    expect(catalog.lookup("sys/random")?.description)
      .toBe("A uniform random number in [0, 1), journaled for replay")
  })

  it("digests an entry's declaration, not its handler", () => {
    const same = Catalog.entryDigest({ ...entry, handler: () => Effect.succeed("other") })
    expect(Catalog.entryDigest(entry)).toBe(same)
    expect(Catalog.entryDigest({ ...entry, name: "grep2" })).not.toBe(Catalog.entryDigest(entry))
  })

  it("is empty as noop", () => {
    expect(Catalog.makeNoop().lookup("grep")).toBeUndefined()
  })

  it("provides layers", async () => {
    const fromLayer = await runOn(
      Catalog.layer([entry]),
      Effect.map(Catalog.Catalog, (catalog) => catalog.lookup("grep"))
    )
    expect(fromLayer).toEqual(entry)
    expect(fromLayer?.handler).toBe(entry.handler)
    const fromNoop = await runOn(Catalog.layerNoop, Effect.map(Catalog.Catalog, (catalog) => catalog.entries))
    expect(fromNoop).toEqual([])
  })

  // `withSystem` is where the ordering rule lives: system entries LAST, so
  // `make`'s last-wins index cannot be shadowed by a host's own `sys/now`.
  // A composition that spreads `Catalog.system` itself has to re-derive the
  // rule and stays correct only by inspection, so the next one is written
  // wrong. `Catalog.system.map(...)` (the reserved-name list) is a read, not
  // a composition, and is left alone.
  it("keeps the system-entries-last rule in withSystem rather than at each composition", () => {
    const sourceRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "src")
    const sources = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
    const handRolled = sources.filter((name) =>
      /\.{3}Catalog\.system(?![.\w])/.test(readFileSync(join(sourceRoot, name), "utf8"))
    )
    expect(handRolled).toEqual([])
  })

  it("appends the system entries after a host's own, whatever the host passes", () => {
    const shadow: Catalog.Entry = {
      description: "an unjournaled clock",
      handler: () => Effect.succeed(0),
      name: "sys/now"
    }
    const catalog = Catalog.make(Catalog.withSystem([entry, shadow]))
    expect(catalog.entries.map((each) => each.name)).toEqual(["grep", "sys/now", "sys/now", "sys/random"])
    expect(catalog.lookup("sys/now")?.description).toBe(
      "The current wall-clock time in epoch milliseconds, journaled for replay"
    )
  })

  it("carries name and message on call errors", () => {
    const error = new Catalog.CallError({ message: "exploded", name: "boom" })
    expect(error.name).toBe("boom")
    expect(error.message).toBe("exploded")
  })
})
