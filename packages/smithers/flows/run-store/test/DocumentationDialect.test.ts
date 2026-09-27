import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it.each(["guides/compose-the-stores.md", "installation.md"])(
  "%s states the SQLite and serialized-writer requirements",
  (page) => {
    const text = readFileSync(new URL(`../docs/${page}`, import.meta.url), "utf8").replace(/\s+/g, " ")

    expect(text).not.toContain("anything that provides `SqlClient` works")
    expect(text).toContain("SQLite and PostgreSQL")
    expect(text).toContain("`DurableWriter` serialization contract")
    expect(text).toContain("`PostgresDatabase`")
    expect(text).toContain("READ COMMITTED")
  }
)
