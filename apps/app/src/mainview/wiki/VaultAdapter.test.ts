import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { createAppStore } from "../state/AppStore"
import { addWorldNote } from "../state/TestFixtures"
import { createVaultAdapter, linkGraphOf, linksOf, neighbourhoodOf, resolveLink } from "./VaultAdapter"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const note = (id: string, path: string, body: string, links: ReadonlyArray<string>, title = path.replace(/\.md$/, "")) => ({
  id,
  path,
  title,
  body,
  links,
  updatedAt: 1
})

const upsert = (store: Awaited<ReturnType<typeof createAppStore>>, id: string, path: string, body: string, links: ReadonlyArray<string>) =>
  store.dispatch({
    type: "world.document.upserted",
    actor: "user",
    select: false,
    document: { id, path, title: path.replace(/\.md$/, ""), body, links: [...links], tags: [], sources: [], confidence: 1 }
  }).isPersisted.promise

describe("resolveLink", () => {
  const notes = [note("h", "World.md", "# World", []), note("d", "areas/Deploy cadence.md", "weekly", [], "Deploy cadence")]

  test("matches a path, a path without .md, a file stem and a title, case-insensitively", () => {
    expect(resolveLink(notes, "World.md")?.id).toBe("h")
    expect(resolveLink(notes, "World")?.id).toBe("h")
    expect(resolveLink(notes, "world")?.id).toBe("h")
    expect(resolveLink(notes, "deploy cadence")?.id).toBe("d")
    expect(resolveLink(notes, "areas/Deploy cadence")?.id).toBe("d")
  })

  test("answers nothing for a blank or unknown target", () => {
    expect(resolveLink(notes, "")).toBeUndefined()
    expect(resolveLink(notes, "Nowhere")).toBeUndefined()
  })
})

describe("linksOf and linkGraphOf", () => {
  const notes = [
    note("h", "World.md", "# World", []),
    note("n", "Untitled 1.md", "See [[World]] and [[Ghost]]", ["World", "Ghost"]),
    note("m", "Untitled 2.md", "Also [[world]] twice [[World.md]]", ["world", "World.md"])
  ]

  test("backlinks name every note that links here, once each, and linksOut resolve to paths", () => {
    const links = linksOf(notes, "World.md")
    expect(links?.backlinks).toEqual(["Untitled 1.md", "Untitled 2.md"])
    expect(links?.linksOut).toEqual([])
    const first = linksOf(notes, "Untitled 1.md")
    expect(first?.linksOut).toEqual(["World.md"])
    expect(first?.unresolved).toEqual(["Ghost"])
    expect(linksOf(notes, "Nowhere.md")).toBeUndefined()
  })

  test("the graph has one node per note, a missing node per dangling target, and one edge per link", () => {
    const graph = linkGraphOf(notes)
    expect(graph.notes.map((row) => row.path)).toEqual(["World.md", "Untitled 1.md", "Untitled 2.md", "Ghost.md"])
    expect(graph.notes.find((row) => row.path === "Ghost.md")?.frontmatter).toEqual({ missing: true })
    expect(graph.notes.find((row) => row.path === "World.md")?.backlinks).toEqual(["Untitled 1.md", "Untitled 2.md"])
    expect(graph.links).toEqual([
      { source: "Untitled 1.md", target: "World.md", kind: "link" },
      { source: "Untitled 1.md", target: "Ghost.md", kind: "link" },
      { source: "Untitled 2.md", target: "World.md", kind: "link" }
    ])
  })

  test("a note linking to itself adds no edge", () => {
    const graph = linkGraphOf([note("s", "Self.md", "[[Self]]", ["Self"])])
    expect(graph.links).toEqual([])
    expect(graph.notes).toHaveLength(1)
  })
})

describe("createVaultAdapter over the store", () => {
  test("tree lists the notes without the missing nodes, read answers a body, links answers the rail", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await addWorldNote(store)
    await upsert(store, "n1", "Untitled 1.md", "See [[World]] and [[Ghost]]", ["World", "Ghost"])
    const vault = createVaultAdapter(store)
    const tree = await vault.tree()
    expect(tree.map((row) => row.path)).toEqual(["Untitled 1.md", "World.md"])
    expect(await vault.read("World")).toContain("# World")
    expect(await vault.links?.("World.md")).toEqual({ backlinks: ["Untitled 1.md"], linksOut: [] })
    await expect(vault.read("Nowhere.md")).rejects.toThrow("There is no Wiki note at Nowhere.md.")
  })

  test("write updates a note's body and links through the dispatcher, and creates a note at a new path", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await addWorldNote(store)
    const vault = createVaultAdapter(store)
    const written = await vault.write("World.md", "# World\n\nNow links to [[Plans]].")
    const home = store.collections.worldDocuments.get("world-home")
    expect(home?.body).toContain("[[Plans]]")
    expect(home?.links).toEqual(["Plans"])
    expect(home?.updatedBy).toBe("user")
    expect(written.mtimeMs).toBe(home?.updatedAt)
    await vault.write("Plans", "# Plans\n\nBack to [[World]].")
    const plans = [...store.collections.worldDocuments.values()].find((row) => row.path === "Plans.md")
    expect(plans?.title).toBe("Plans")
    expect(plans?.links).toEqual(["World"])
    // The graph now closes the loop: two notes, two edges, no missing node.
    const graph = await vault.graph?.()
    expect(graph?.notes.map((row) => row.path)).toEqual(["Plans.md", "World.md"])
    expect(graph?.links).toHaveLength(2)
  })
})

describe("neighbourhoodOf", () => {
  const notes = [
    note("h", "World.md", "# World", ["Plans"]),
    note("p", "Plans.md", "See [[World]]", ["World"]),
    note("o", "Other.md", "[[Plans]]", ["Plans"]),
    note("l", "Lonely.md", "nothing", [])
  ]

  test("keeps the note, its neighbours one hop away and the edges among them", () => {
    const focused = neighbourhoodOf(linkGraphOf(notes), "World")
    expect(focused?.notes.map((row) => row.path)).toEqual(["World.md", "Plans.md"])
    expect(focused?.links).toEqual([
      { source: "World.md", target: "Plans.md", kind: "link" },
      { source: "Plans.md", target: "World.md", kind: "link" }
    ])
  })

  test("answers nothing for a path no note has", () => {
    expect(neighbourhoodOf(linkGraphOf(notes), "Nowhere")).toBeUndefined()
  })
})
