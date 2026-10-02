import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ")

describe("documentation contracts", () => {
  it("requires durable runner deduplication for at-least-once launch attempts (documentation/1)", () => {
    for (
      const path of [
        "README.md",
        "docs/README.md",
        "docs/concepts/claim-protocol.md",
        "docs/troubleshooting.md",
        "docs/api.md"
      ]
    ) {
      const doc = read(path)
      expect(doc, path).toContain("at-least-once launch attempts")
      expect(doc, path).toContain("durably deduplicate by `idempotencyKey`")
      expect(doc, path).toContain("same run identity on replay")
    }
    expect(read("docs/concepts/claim-protocol.md")).toMatch(/accepted.*before.*`launched` result/)
    expect(read("docs/troubleshooting.md")).not.toContain("which the store's transaction forbids")
    expect(read("docs/quickstart.md")).not.toContain("fire the occurrence once")
    expect(read("docs/api.md")).not.toContain("two hosts never fire the same scheduled run twice")
  })

  it("keys webhook deduplication on signed bytes, never an unsigned delivery header (security/replay)", () => {
    const guide = read("docs/guides/ingest-a-webhook.md")
    expect(guide).toContain("Derive the key from bytes the signature covers.")
    expect(guide).toContain("are not signed")
    expect(guide).toContain("refuse deliveries outside a short window")
    expect(guide).not.toContain("idempotencyKey: deliveryId")
    expect(guide).not.toContain("`idempotencyKey` is the transport's own delivery id")
  })

  it("describes catch-up enumeration subject to overlap, not lossless billing (documentation/2, api-design/2)", () => {
    const guide = read("docs/guides/choose-a-policy.md")
    expect(guide).toContain("subject to overlap")
    expect(guide).toContain("holds the trigger until its run settles")
    expect(guide).toContain("durable queue")
    expect(guide).toContain("interval backlog")
    expect(guide).not.toContain("const hourlyRollup")
    expect(guide).not.toContain("pair `all` with `skip` or `buffer-one`")
  })

  it("states that a bound breach abandons the backlog but never the current occurrence (documentation/3)", () => {
    for (
      const path of [
        "docs/concepts/policies.md",
        "docs/api.md",
        "docs/guides/choose-a-policy.md",
        "docs/troubleshooting.md"
      ]
    ) {
      const doc = read(path)
      expect(doc, path).toContain("first poll after a restart")
      expect(doc, path).toContain("subject to overlap")
      expect(doc, path).not.toContain("drops the entire owed list")
    }
  })

  it("states what the in-memory store shares with SQL and where it stops (documentation/6)", () => {
    const guide = read("docs/guides/testing.md")
    expect(guide).toContain("Both stores apply one shared claim decision")
    expect(guide).toContain("Registration validates the declaration and serializes its input at the call boundary")
    expect(guide).toContain("`list` and `listEnabled` order by id in both")
    expect(guide).toContain("never reports a `store` failure from a write")
    expect(guide).not.toContain("so a test that passes against this one is testing the protocol")
    const reference = read("docs/api.md")
    expect(reference).toContain("It applies the same claim decision as the SQL store")
    expect(reference).toContain("Registration validates the declaration and serializes its input at the call boundary")
    expect(reference).toContain("never reports a `store` failure from a write")
    expect(read("docs/concepts/claim-protocol.md")).toContain("apply one claim decision, not two implementations")
    expect(read("README.md")).toContain("It keeps no rows and applies no migrations")
  })

  it("names list as the method a scheduler tick polls (documentation/4, maintainability/1)", () => {
    const declare = read("docs/guides/declare-a-trigger.md")
    expect(declare).toContain("Every trigger, ordered by id, as `Listed` rows. This is what the scheduler polls.")
    expect(declare).not.toContain("Every enabled trigger, ordered by id. This is what the scheduler polls.")
    expect(declare).toContain("A tick polls `list`, not `listEnabled`, because a disabled trigger can still")
    const host = read("docs/guides/run-the-scheduler.md")
    expect(host).toContain("Every tick it lists every trigger, recovers the occurrences already running")
    expect(host).not.toContain("lists the enabled triggers")
    const testing = read("docs/guides/testing.md")
    expect(testing).toContain("TriggerStore.layerNoop({ list: () => Effect.succeed([]) })")
    expect(testing).not.toContain("TriggerStore.layerNoop({ listEnabled:")
    const protocol = read("docs/concepts/claim-protocol.md")
    expect(protocol).toContain("`TriggerStore.list` returns every trigger, and nothing more")
    expect(protocol).not.toContain("`TriggerStore.listEnabled` returns the enabled triggers")
  })

  it("limits the missing-row failure to the methods that report it (documentation/7)", () => {
    for (const path of ["docs/api.md", "docs/concepts/claim-protocol.md", "src/TriggerStore.ts"]) {
      const doc = read(path).replace(/ \* /g, " ")
      expect(doc, path).not.toContain("Every method addressing one trigger fails with `unknown_trigger`")
      expect(doc, path).not.toContain("Every method addressing one trigger reports this")
      expect(doc, path).toContain("`get` answers `None`")
    }
    expect(read("docs/api.md")).toContain("`register` creates the row")
  })

  it("documents fire ledger growth and the retention rule that bounds it (performance/4)", () => {
    const reference = read("docs/api.md")
    expect(reference).toContain("Nothing else in the store deletes from the fire ledger")
    expect(reference).toContain("Deletes settled ledger rows older than `olderThan` and answers how many")
  })

  it("documents accepted getters and their two evaluations (documentation/5)", () => {
    for (const path of ["docs/troubleshooting.md", "docs/api.md", "src/Trigger.ts"]) {
      const doc = read(path).replace(/ \* /g, " ")
      expect(doc, path).toContain("Enumerable getters are accepted")
      expect(doc, path).toContain("evaluated during decoding and again during SQL serialization")
    }
  })
})
