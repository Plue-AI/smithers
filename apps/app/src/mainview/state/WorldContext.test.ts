import { describe, expect, test } from "bun:test"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { WORLD_BODY_PER_DOCUMENT, worldContextDocuments } from "./WorldContext"
import { addWorldNote, memoryStorage, recordingAgent, settled } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * §10.8 — the World reaches the model, or it is decoration.
 *
 * Measured on canary: a note was edited to say "the canary codeword for this
 * workspace is zarquon-mimsy-7741", the edit persisted, and the model then
 * answered that it could not retrieve the codeword and reached for a
 * repository file read instead. The value genuinely was not in its context —
 * the per-turn runtime context carried world documents by path, title and
 * confidence, never by body.
 */

/** An agent double that records every turn request and ends the turn fast. */
const note = (id: string, body: string, path = `${id}.md`) => ({
  id,
  path,
  title: id,
  body,
  confidence: 1
})

describe("world notes ride the turn under a budget", () => {
  test("every note carries its own words", () => {
    const carried = worldContextDocuments(
      [note("World", "The codeword is zarquon-mimsy-7741."), note("Notes", "Second note.")],
      "World"
    )
    expect(carried.map((document) => document.body)).toEqual([
      "The codeword is zarquon-mimsy-7741.",
      "Second note."
    ])
    expect(carried.some((document) => document.bodyTruncated === true)).toBe(false)
  })

  test("a note longer than one note's share is cut, and says it was cut", () => {
    const long = "x".repeat(WORLD_BODY_PER_DOCUMENT + 500)
    const [carried] = worldContextDocuments([note("World", long)], "World")
    expect(carried?.body?.length).toBe(WORLD_BODY_PER_DOCUMENT)
    expect(carried?.bodyTruncated).toBe(true)
  })

  test("the open note is served first, so the budget is spent where the user is looking", () => {
    // A budget with room for one note only: the note the user has open must
    // be the one that fits, whatever order the snapshot sorts them into.
    const carried = worldContextDocuments(
      [note("Alphabetical", "a".repeat(40)), note("Selected", "the codeword is here")],
      "Selected",
      "the codeword is here".length,
      40
    )
    const selected = carried.find((document) => document.path === "Selected.md")
    const other = carried.find((document) => document.path === "Alphabetical.md")
    expect(selected?.body).toBe("the codeword is here")
    expect(selected?.bodyTruncated).toBeUndefined()
    expect(other?.body).toBe("")
    expect(other?.bodyTruncated).toBe(true)
    // Output order is the caller's order — the list the model reads is the
    // list the pane shows.
    expect(carried.map((document) => document.path)).toEqual(["Alphabetical.md", "Selected.md"])
  })

  test("an empty note is empty, never truncated", () => {
    const [carried] = worldContextDocuments([note("World", "   ")], null)
    expect(carried?.body).toBe("")
    expect(carried?.bodyTruncated).toBeUndefined()
  })

  test("the turn the client sends carries the note's text, not just its path", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await addWorldNote(store)
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, recordingAgent(requests))
    const seeded = [...store.collections.worldDocuments.values()][0]
    expect(seeded).toBeDefined()
    controller.changeWorldDocument(
      seeded?.id ?? "",
      "Project glossary. The canary codeword for this workspace is zarquon-mimsy-7741."
    )

    controller.send("What is the canary codeword for this workspace?")
    await settled()

    const documents = requests[0]?.context?.worldState.documents ?? []
    expect(documents.some((document) => document.body?.includes("zarquon-mimsy-7741"))).toBe(true)
  })
})
