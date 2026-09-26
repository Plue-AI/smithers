/**
 * The instructions an agent profile runs with.
 *
 * A profile is a Markdown file: YAML frontmatter (`name`, `seat`, `effort`,
 * `skills`, grants and the rest, which the host reads) and a body (the
 * charter). Skills are `Skills/<name>/SKILL.md` files in the Agent Skills
 * format. A directory may also hold shared instructions every profile starts
 * with (`Common Operating Instructions.md`).
 *
 * The system segments are, in order: the host's {@link turnContract}, the
 * shared instructions, the charter under a `# Role:` heading, then each skill
 * the profile lists, in the profile's order, each under a `# Skill:` heading.
 * Byte caps keep a profile from silently growing: 8 KiB for the shared
 * instructions, 12 KiB for the charter, 16 KiB per skill. A profile file can
 * be swapped (`profileFile`) so two versions of one profile run against the
 * same cases.
 *
 * {@link turnContract} is the host's half: the mechanics of one
 * conversational turn (where the final answer goes, that readers see only
 * text). It says nothing about how to behave, so the profile is the whole of
 * the character under test.
 *
 * @since 0.1.0
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"

/** The runtime's description of a turn. */
export const turnContract = [
  "# How this runtime works",
  "",
  "You are one agent on Will's team, running one turn. A turn starts with one event: a message to you, a request from another agent, or a scheduled moment.",
  "",
  "- The string you finish with (ctx.done) is posted as your reply where the event arrived: in Will's DM when Will wrote, or to the agent or channel that wrote to you. Finish with an empty string to post nothing.",
  "- Everything else you do goes through the flows in ctx.flows: messages to other people, handoffs, questions to other agents, calendar, email, pages. Nothing is sent unless you call the flow.",
  "- Readers see only the text you send. They never see your code, tool calls, results or reasoning, so a reply must stand on its own.",
  "- Chat supports Slack-style formatting: *bold*, bullets, and links written <url|label> or [label](url)."
].join("\n")

/** Byte caps per part. */
export const limits = { common: 8_192, charter: 12_288, skill: 16_384 } as const

/** One composed profile. */
export interface Composed {
  readonly role: string
  readonly name: string
  readonly seat: string
  readonly effort: "low" | "medium" | "high" | undefined
  readonly skills: ReadonlyArray<string>
  readonly system: ReadonlyArray<string>
  /** SHA-256 over the system segments: two runs with one digest ran identical instructions. */
  readonly digest: string
  readonly bytes: { readonly common: number; readonly charter: number; readonly skills: number }
}

/** Where a profile's instructions come from. */
export interface Source {
  /** The directory holding `Roles/`, `Skills/` and the shared instructions. */
  readonly org: string
  readonly role: string
  /** Replaces `Roles/<role>.md`, e.g. an older version of the same profile. */
  readonly profileFile?: string | undefined
  /** Replaces the shared instructions page. */
  readonly commonFile?: string | undefined
}

const commonCandidates = ["Common Operating Instructions.md", "Common.md"]

const split = (text: string): { readonly meta: Record<string, unknown>; readonly body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  return match === null
    ? { meta: {}, body: text }
    : { meta: (parseYaml(match[1]!) ?? {}) as Record<string, unknown>, body: match[2]! }
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8")

const capped = (part: string, text: string, cap: number): string => {
  if (bytes(text) > cap) throw new Error(`${part} is ${bytes(text)} bytes; the cap is ${cap}`)
  return text
}

/** Composes a profile's system segments, or throws naming the part that is missing or too large. */
export const compose = (source: Source): Composed => {
  const profilePath = source.profileFile ?? join(source.org, "Roles", `${source.role}.md`)
  const { body, meta } = split(readFileSync(profilePath, "utf8"))
  const commonPath = source.commonFile ?? commonCandidates.map((name) => join(source.org, name)).find(existsSync)
  const common = commonPath === undefined
    ? ""
    : capped("common instructions", readFileSync(commonPath, "utf8"), limits.common)
  const name = String(meta.name ?? source.role)
  const charter = capped("charter", `# Role: ${name} (${source.role})\n\n${body.trim()}`, limits.charter)
  const skills = Array.isArray(meta.skills) ? meta.skills.map(String) : []
  const skillTexts = skills.map((skill) => {
    const path = join(source.org, "Skills", skill, "SKILL.md")
    if (!existsSync(path)) throw new Error(`skill ${skill} is listed but ${path} does not exist`)
    return capped(
      `skill ${skill}`,
      `# Skill: ${skill}\n\n${split(readFileSync(path, "utf8")).body.trim()}`,
      limits.skill
    )
  })
  const system = [turnContract, ...(common === "" ? [] : [common]), charter, ...skillTexts]
  const effort = meta.effort === "low" || meta.effort === "medium" || meta.effort === "high" ? meta.effort : undefined
  return {
    role: source.role,
    name,
    seat: String(meta.seat ?? ""),
    effort,
    skills,
    system,
    digest: createHash("sha256").update(JSON.stringify(system)).digest("hex"),
    bytes: {
      common: bytes(common),
      charter: bytes(charter),
      skills: skillTexts.reduce((sum, text) => sum + bytes(text), 0)
    }
  }
}
