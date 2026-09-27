/**
 * The MCP docs, checked against the servers they describe (#1856).
 *
 * The site reference once told agents to discover `flow_start`, which the
 * executable never serves. Every name here comes from the server, never from
 * a copy in this file.
 */
import { Cli as Incur, Mcp } from "incur"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
const guide = read("../docs/guides/wire-the-mcp-server.md")
const reference = read("../../../apps/site/src/content/docs/docs/reference/mcp-tools.mdx")
const setup = read("../../../apps/site/src/content/docs/docs/guides/mcp-setup.mdx")

/** Backticked names in one piece of text, in order. */
const names = (text: string) => [...text.matchAll(/`([a-z_-]+)`/g)].map((match) => match[1] ?? "")

/** The tool names `smthrs --mcp` serves through its discovery tools. */
const unified = new Set(
  Mcp.collectTools(Incur.toCommands.get(makeCli() as never) ?? new Map(), []).map((tool) => tool.name)
)

describe("the unified MCP docs", () => {
  it("says the approval-bearing verbs are absent, and they are", () => {
    const sentence = guide.replaceAll(/\s+/g, " ").match(/([^.]*) are absent from both discovery and dispatch/)?.[1]
    const absent = names(sentence ?? "")

    expect(absent.length).toBeGreaterThan(0)
    expect(absent.filter((name) => unified.has(name))).toEqual([])
  })

  it("tells agents to discover only tools the server serves", () => {
    const section = reference.split("## Command names")[1]?.split("\n## ")[0] ?? ""
    const table = section.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Task"))
    const cells = table.map((line) => line.split("|")[2]?.trim() ?? "")
    const listed = cells.filter((cell) => !cell.startsWith("Search for")).flatMap(names)

    expect(listed.length).toBeGreaterThan(0)
    expect(listed.filter((name) => !unified.has(name))).toEqual([])
  })

  it("never describes an unserved verb as an MCP tool", () => {
    const tools = (text: string) =>
      names(text).filter((name) => /^(flow|approvals|runs|run)_/.test(name) && !unified.has(name))

    expect(tools(reference)).toEqual([])
    expect(tools(setup)).toEqual([])
  })
})
