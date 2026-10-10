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
// The standalone docs site was retired for M-35. The npm package retains
// its MCP guide; verify the documentation users actually receive.
const reference = guide.split("## Canonical tools and independent approval")[1]?.split("`approvals_approve`")[0] ?? ""

/** Backticked names in one piece of text, in order. */
const names = (text: string) => [...text.matchAll(/`([a-z_-]+)`/g)].map((match) => match[1] ?? "")
const excluded = names(
  guide.replaceAll(/\s+/g, " ").match(/([^.]*) are absent from both discovery and dispatch/)?.[1] ?? ""
)

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
    const listed = names(reference).filter((name) => /^(flow|approvals|runs)_/.test(name))

    expect(listed.length).toBeGreaterThan(0)
    expect(listed.filter((name) => !unified.has(name))).toEqual([])
  })

  it("never describes an unserved verb as an MCP tool", () => {
    const tools = (text: string) =>
      names(text).filter((name) =>
        /^(flow|approvals|runs|run)_/.test(name) && !excluded.includes(name) && !unified.has(name)
      )

    expect(tools(reference)).toEqual([])
    expect(tools(guide)).toEqual([])
    expect(excluded).toEqual(["approvals_approve", "approvals_deny", "flow_start"])
  })
})
