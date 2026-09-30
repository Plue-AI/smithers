/**
 * The instructions an agent profile runs with.
 *
 * A profile is the role's markdown flow, `flows/<role>/flow.mdx`: the one
 * shape every flow has. Its frontmatter carries what the runtime reads
 * (`description`, `model`, `effort`, `capabilities`, `budget`, `flows`) and a
 * string `metadata` map with the role's display `name` and its `skills`, a
 * comma-separated list; the body is the charter. Skills are
 * `Skills/<name>/SKILL.md` files in the Agent Skills format. The skills
 * directory may also hold shared instructions every profile starts with
 * (`Common Operating Instructions.md`).
 *
 * The system segments are, in order: the host's {@link turnContract}, the
 * shared instructions, the charter under a `# Role:` heading, then each skill
 * the profile lists, in the profile's order, each under a `# Skill:` heading.
 * Byte caps keep a profile from silently growing: 8 KiB for the shared
 * instructions, 12 KiB for the charter, 16 KiB per skill. A suite names its
 * profile; `--profile` swaps in another file so two versions of one profile
 * run against the same cases.
 *
 * {@link turnContract} is the host's half: the mechanics of one
 * conversational turn (where the final answer goes, that readers see only
 * text). It says nothing about how to behave, so the profile is the whole of
 * the character under test.
 *
 * @since 0.1.0
 */

import * as Capability from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import { Effect, FileSystem, Option } from "effect"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import * as CliError from "../CliError.ts"
import * as Failure from "./Failure.ts"

/**
 * The runtime's description of a turn: the first system segment of every
 * composed profile.
 *
 * @since 0.1.0
 * @category constants
 */
export const turnContract = [
  "# How this runtime works",
  "",
  "You are an agent running one turn. A turn starts with one event: a message to you, a request from another agent, or a scheduled moment.",
  "",
  "- The string you finish with (ctx.done) is posted as your reply where the event arrived: in the conversation that addressed you. Finish with an empty string to post nothing.",
  "- Everything else you do goes through the flows in ctx.flows: messages to other people, handoffs, questions to other agents, calendar, email, pages. Nothing is sent unless you call the flow.",
  "- Readers see only the text you send. They never see your code, tool calls, results or reasoning, so a reply must stand on its own.",
  "- Chat supports Slack-style formatting: *bold*, bullets, and links written <url|label> or [label](url)."
].join("\n")

/**
 * Byte caps per part: the shared instructions, the charter, and each skill.
 *
 * @since 0.1.0
 * @category constants
 */
export const limits = { common: 8_192, charter: 12_288, skill: 16_384 } as const

/**
 * One composed profile: its identity, seat, and system segments.
 *
 * @since 0.1.0
 * @category models
 */
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

/**
 * Strips a leading `---` frontmatter block and returns the body, or the whole
 * text when it has none.
 *
 * @since 0.1.0
 * @category utils
 */
export const splitFrontmatter = (text: string): { readonly body: string } => ({
  body: /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text)?.[1] ?? text
})

const commonCandidates = ["Common Operating Instructions.md", "Common.md"]

const bytes = (text: string): number => Buffer.byteLength(text, "utf8")

/**
 * A role profile the flow author has to fix: a missing grant, a bad skill
 * name, a part over its cap, or a file outside the checkout.
 */
const refused = (message: string): CliError.Refused =>
  new CliError.Refused({ fault: "user", code: "role_profile_refused", message })

/** A composition step that broke the profile's own bookkeeping, not the operator's input. */
const broken = (message: string): CliError.Refused =>
  new CliError.Refused({ fault: "bug", code: "role_profile_broken", message: `${message}. Not your fault.` })

const capped = (part: string, text: string, cap: number): string => {
  if (bytes(text) > cap) throw refused(`${part} is ${bytes(text)} bytes; the cap is ${cap}`)
  return text
}

/**
 * What {@link compose} reads: the org directory holding the shared
 * instructions and `Skills/`, the role, its flow body and frontmatter, and an
 * optional reader that replaces direct file reads.
 *
 * @since 0.1.0
 * @category models
 */
export interface Source {
  readonly org: string
  readonly role: string
  readonly body: string
  readonly meta: Record<string, unknown>
  readonly commonFile?: string | undefined
  readonly read?: ((path: string) => string) | undefined
}

/**
 * Composes a profile's system segments, or throws naming the part that is
 * missing or too large.
 *
 * @since 0.1.0
 * @category constructors
 */
export const compose = (source: Source): Composed => {
  const read = source.read ?? ((path: string) => readFileSync(path, "utf8"))
  const { body, meta } = source
  const metadata = typeof meta.metadata === "object" && meta.metadata !== null
    ? meta.metadata as Record<string, unknown>
    : {}
  const commonPath = source.commonFile ?? commonCandidates.map((name) => join(source.org, name)).find(existsSync)
  const common = commonPath === undefined
    ? ""
    : capped("common instructions", read(commonPath), limits.common)
  const name = String(metadata.name ?? source.role)
  const charter = capped("charter", `# Role: ${name} (${source.role})\n\n${body.trim()}`, limits.charter)
  const skills = typeof metadata.skills === "string"
    ? metadata.skills.split(",").map((skill) => skill.trim()).filter((skill) => skill !== "")
    : []
  const skillTexts = skills.map((skill) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) throw refused(`invalid skill name: ${skill}`)
    const path = join(source.org, "Skills", skill, "SKILL.md")
    if (!existsSync(path)) throw refused(`skill ${skill} is listed but ${path} does not exist`)
    return capped(
      `skill ${skill}`,
      `# Skill: ${skill}\n\n${splitFrontmatter(read(path)).body.trim()}`,
      limits.skill
    )
  })
  const system = [turnContract, ...(common === "" ? [] : [common]), charter, ...skillTexts]
  const effort = meta.effort === "low" || meta.effort === "medium" || meta.effort === "high" ? meta.effort : undefined
  return {
    role: source.role,
    name,
    seat: typeof meta.model === "string" ? meta.model : "",
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

const attempt = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => cause instanceof Error ? cause : new Error(Failure.unknownSentence, { cause })
  })

/**
 * Composes a declared shared page and optional skills through the guarded
 * filesystem. Returns no segments when the run grants no shared page and
 * lists no skills.
 *
 * @since 0.1.0
 * @category constructors
 */
export const forRun = (
  root: string,
  descriptor: { readonly name: string; readonly frontmatter: Readonly<Record<string, unknown>> },
  body: string,
  capabilities: ReadonlyArray<string>
) =>
  Effect.gen(function*() {
    const meta = descriptor.frontmatter
    const metadata = meta.metadata as Record<string, unknown> | undefined
    const common = capabilities.flatMap((value) => value.startsWith("fs:read:") ? [value.slice(8)] : [])
      .find((path) => !/[?*]/.test(path) && commonCandidates.some((name) => path === name || path.endsWith(`/${name}`)))
    if (common === undefined) {
      if (typeof metadata?.skills !== "string") return []
      return yield* Effect.fail(refused("role profile requires a granted shared instructions page"))
    }
    const base = yield* attempt(() => realpathSync(root))
    const org = dirname(resolve(base, common))
    const skills = typeof metadata?.skills === "string"
      ? metadata.skills.split(",").map((skill) => skill.trim()).filter(Boolean)
      : []
    for (const skill of skills) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) {
        return yield* Effect.fail(refused(`invalid skill name: ${skill}`))
      }
    }
    const patterns = capabilities.flatMap((value) => Option.toArray(Capability.parsePattern(value)))
    const granted = CapabilitySet.fromPatterns(patterns)
    const fs = yield* FileSystem.FileSystem
    const texts = new Map<string, string>()
    for (const path of [resolve(base, common), ...skills.map((skill) => join(org, "Skills", skill, "SKILL.md"))]) {
      yield* attempt(() => {
        const local = relative(base, path)
        if (isAbsolute(local) || local === ".." || local.startsWith("../")) {
          throw refused("profile file is outside the checkout")
        }
        if (!CapabilitySet.allows(granted, Capability.make("fs:read", local))) {
          throw refused(`profile file is not granted: ${local}`)
        }
        const actual = relative(base, realpathSync(path))
        if (isAbsolute(actual) || actual === ".." || actual.startsWith("../")) {
          throw refused("profile file is outside the checkout")
        }
        if (!CapabilitySet.allows(granted, Capability.make("fs:read", actual))) {
          throw refused(`profile file is not granted: ${actual}`)
        }
      })
      // The native host supplies descriptor-relative no-follow reads here. The
      // checks above describe errors; the guarded service owns race safety.
      const logical = resolve(root, relative(base, path))
      const exact = Capability.patternFromCapability(Capability.make("fs:read", logical))
      if (Option.isNone(exact)) return yield* Effect.fail(broken("The role profile file could not be granted exactly"))
      // The envelope above grants a checkout-relative resource; the kernel
      // authorizes its absolute logical path. Translate only this checked file.
      texts.set(path, yield* fs.readFileString(logical).pipe(CapabilitySet.attenuate([exact.value])))
    }
    return yield* attempt(() =>
      compose({
        org,
        role: descriptor.name,
        body,
        meta,
        commonFile: resolve(base, common),
        read: (path) => {
          const text = texts.get(path)
          if (text === undefined) throw broken("The role profile file was not read before composing")
          return text
        }
      }).system
    )
  })
