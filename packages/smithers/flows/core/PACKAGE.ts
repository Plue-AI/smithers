import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows/core"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "skill-yaml-parsing",
      title: "SKILL.md frontmatter parsing stays failsafe, alias-bounded, and prototype-safe",
      threat:
        "The author of a third-party SKILL.md exhausts the loading host's memory or CPU, or pollutes object prototypes in the process that lowers the skill.",
      lookFor: [
        "parseDocument called with a schema other than \"failsafe\", or with maxAliasCount raised or disabled, so tags or alias expansion reach toJS.",
        "Parsed mappings copied onto an ordinary object or with Object.assign instead of Object.defineProperty on an Object.create(null) record, letting a __proto__ key set a prototype.",
        "An exception or parser message that is returned without the catch or the summarizeIssue truncation, so frontmatter source text reaches a caller log.",
        "split fence regexes that can backtrack superlinearly on a long document with no closing ---."
      ],
      paths: ["src/internal/skillFrontmatter.ts", "src/Markdown.ts"]
    },
    {
      id: "skill-frontmatter-validation",
      title: "Skill frontmatter validation rejects every non-conforming name, description, and field",
      threat:
        "A malicious skill author registers a name that collides with or shadows a trusted flow tag, or smuggles a path-like name into registry lookups.",
      lookFor: [
        "isSkillName accepting a name outside /^[a-z0-9]+(?:-[a-z0-9]+)*$/ or longer than 64 characters, such as one containing '/', '.', or uppercase.",
        "A MarkdownError message that echoes the offending field value.",
        "Fields lowered from `extra` (model, placement, capabilities, effects) into the flow by lowerSkill, rather than staying in the frozen extra record."
      ],
      paths: ["src/Markdown.ts"]
    },
    {
      id: "markdown-lowering-authority",
      title: "Lowering markdown grants no authority the frontmatter did not declare",
      threat:
        "A markdown or skill author obtains a wider capability set, effect envelope, or host placement than declared, running a prompt on the local host or with write access it never requested.",
      lookFor: [
        "lowerMarkdown defaulting placement to local or client, or to any placement, when frontmatter omits it.",
        "Default effects in lowerMarkdown other than empty reads/writes, hermetic mode, and serialize.",
        "allowed-tools lowered into capabilities instead of the advisory `flows` collaborator list."
      ],
      paths: ["src/Markdown.ts"]
    },
    {
      id: "flow-tier-and-capability-ceiling",
      title: "A flow's tier and capability ceiling never widen implicitly",
      threat:
        "A flow with no declared effects content-shares another tenant's or run's cached result, or a decorator widens a flow's capability ceiling without the author declaring it.",
      lookFor: [
        "tierOf returning \"sealed\" or anything but \"irreversible\" when effects are undefined.",
        "build preferring an annotated Durable.Capabilities or Annotations.Effects value in a way withFlows or within can trigger without the caller supplying that key.",
        "A combinator rebuilding from the lowered `annotations` bag instead of the author's original options, so an earlier override resurfaces.",
        "Effects.sealed keeping a declared write set while setting tier \"sealed\", so a side-effecting flow's result is content-shared across runs.",
        "annotate copying Durable.Capabilities, Annotations.Effects, or Annotations.Placement from a caller-supplied context without the flow author opting in."
      ],
      paths: ["src/Flow.ts", "src/Annotations.ts"]
    },
    {
      id: "identity-digest-stability",
      title: "Step identity digests are canonical and cover all behavior",
      threat:
        "A flow author changes a body's behavior while keeping its step key, so a cached or approved result from the old body is replayed for the new one.",
      lookFor: [
        "The non-struct input adapter in build carrying a captured body identity when the body is not captured with sha256-source-captures/v5.",
        "Digest.canonical or Digest.digest diverging from @smthrs/crypto digestSync or RFC 8785 canonical bytes.",
        "KeyMaterial placing nodeId or other graph-local names into hashed material."
      ],
      paths: ["src/Flow.ts", "src/Digest.ts", "src/KeyMaterial.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
