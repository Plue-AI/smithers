import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets plus package-owned documentation generation.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent/registry"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent/registry",
  include: ["src/**"],
  checks: [
    {
      id: "discovery-confinement",
      title: "Discovery never reads or registers a flow outside its source confinement root",
      threat:
        "A third-party pack author symlinks a flow directory or entry to host files and gets them registered or hashed as that pack's flows.",
      lookFor: [
        "withinRoot in Discovery.ts returning true when realPath of the candidate fails while the root resolved.",
        "A stat, readFile, or readDirectory in Discovery.visit reached before withinRoot vetted that location.",
        "A path-prefix containment test without a trailing separator, so /pack-evil passes for /pack."
      ],
      paths: ["src/Discovery.ts", "src/Pack.ts"]
    },
    {
      id: "pack-manifest-paths",
      title: "Pack manifest flows and skills paths stay lexically and physically inside the pack root",
      threat:
        "A malicious installed pack's manifest points a source at ../../ or an absolute path and exposes host files as flows.",
      lookFor: [
        "isPackRelativePath accepting an absolute, drive-letter, backslash, or empty segment path.",
        "Pack.sources skipping the realPath check when only one side fails to resolve, letting a symlinked source escape.",
        "A local-vs-installed precedence rule that lets an installed pack shadow a local flow name."
      ],
      paths: ["src/Pack.ts"]
    },
    {
      id: "execution-integrity",
      title: "A module flow executes only the exact entry and relative-import bytes discovery measured",
      threat:
        "Anyone who can write the project tree swaps a flow or one of its sibling imports after approval and runs unapproved code with the approved plan's authority.",
      lookFor: [
        "loadModule importing before both readVerifiedBody and verifyImports succeed.",
        "ModuleClosure.specifiersOf missing an import form (export * from, dynamic import with template, require) so a sibling runs unpinned.",
        "An unpinnable closure entry (no contentDigest) that does not refuse execution.",
        "verifyImports comparing only measured entries and ignoring recorded paths that disappeared, or vice versa."
      ],
      paths: ["src/Executable.ts", "src/internal/ModuleClosure.ts", "src/internal/Body.ts"]
    },
    {
      id: "load-sibling-files",
      title: "The digest-named load sibling cannot clobber or delete unrelated files",
      threat:
        "A flow directory author makes the loader overwrite, follow a symlink for, or sweep away files next to the flow entry.",
      lookFor: [
        "reserveSibling writing without exclusive create, so a pre-planted symlink at the sibling name is followed.",
        "removeStaleSiblings deleting any name matching the loadSibling regex, including user files, or following symlinks.",
        "fileSpecifier producing a specifier that addresses a different file than modulePath (unescaped #, ?, %)."
      ],
      paths: ["src/Executable.ts"]
    },
    {
      id: "authority-projection",
      title: "Projected capabilities, effects, and tier never understate what a flow can do",
      threat:
        "A flow author declares or omits authority so an agent host treats an irreversible or shell-capable flow as sealed or compensable and runs it without approval.",
      lookFor: [
        "tierForCapability classifying fs:write paths with .., ~, $VAR, %VAR%, scheme, or absolute prefixes as compensable.",
        "A malformed capabilities or effects frontmatter value narrowing authority instead of widening to the conservative projection.",
        "A declared tier lower than the inferred tier that survives projectEffects.",
        "Module metadata the static reader cannot evaluate being projected as narrower than conservativeEffects."
      ],
      paths: ["src/internal/Authority.ts", "src/MarkdownFlow.ts", "src/internal/ModuleMetadata.ts"]
    },
    {
      id: "catalog-prompt-injection",
      title: "Flow names and descriptions rendered into model prompts cannot break out of their slot",
      threat:
        "A third-party skill author injects instructions or fake skill entries into the agent's available_skills catalog or rendered body prompt.",
      lookFor: [
        "Disclosure.toXml emitting a name or description without escapeXml, or listing entries whose modelInvocable is false.",
        "MarkdownFlow rendering baseDirectory, frontmatter, or body text into a prompt header without delimiting it.",
        "A frontmatter name that fails Markdown.isSkillName still used as the registry key."
      ],
      paths: ["src/Disclosure.ts", "src/MarkdownFlow.ts", "src/internal/Names.ts"]
    },
    {
      id: "registry-precedence",
      title: "A pack or project flow cannot replace a system flow or a registry descriptor after it is approved",
      threat:
        "A pack author reuses a system or project flow name, or a host caller mutates a handed-out descriptor, so an approved plan runs different code or authority than was reviewed.",
      lookFor: [
        "firstFound.fold keeping or replacing an entry on a collision with a system source instead of returning system_collision.",
        "An installed pack outranking a local pack or project source when Pack.merge or layerFromPacks orders by caller order.",
        "ownedValue leaving a nested object or array unfrozen, so a mutation outlives the WeakMap-memoized executionDigest.",
        "executionDigest omitting a field that changes what runs (body path, model, capabilities, effects, closure digests)."
      ],
      paths: ["src/Registry.ts", "src/Descriptor.ts", "src/Pack.ts"]
    },
    {
      id: "untrusted-parse-bounds",
      title: "Parsing hostile flow sources stays bounded in memory, time, and prototype safety",
      threat:
        "A malicious flow file exhausts the host's memory or CPU during a scan, or pollutes object prototypes via frontmatter.",
      lookFor: [
        "readFile of an entry or closure module before a byte ceiling is enforced on the bytes actually read.",
        "YAML parsed with a schema other than failsafe, or aliases and merge keys expanded without a limit.",
        "Frontmatter results built on a normal prototype so __proto__ or constructor keys reach consumers.",
        "A ModuleMetadata tokenizer loop or regex with super-linear behavior on crafted input."
      ],
      paths: [
        "src/Discovery.ts",
        "src/internal/Frontmatter.ts",
        "src/internal/ModuleMetadata.ts",
        "src/internal/ModuleClosure.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
