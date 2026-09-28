import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/capability"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/capability" })

/**
 * Security review of the capability grammar, matcher, and policy evaluator.
 *
 * `security` reviews the diff against origin/main; `securityAudit` reviews
 * every source file.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/capability",
  include: ["src/**"],
  checks: [
    {
      id: "glob-match-never-widens",
      title: "A grant pattern selects only the resources its glob text denotes",
      threat: "A flow or agent holding a narrow grant performs fs, net, or proc actions the owner never granted.",
      lookFor: [
        "matchGlob treating any unit other than `*` and `?` as a metacharacter, or `?` matching zero or two units.",
        "The ` *` suffix rule in matchesResource matching a resource that is not the bare prefix or prefix + space + text.",
        "matchesAction accepting an action outside the `<namespace>:*` prefix, such as `fs:*` selecting `fsx:read`.",
        "A matched resource containing `..` segments that escapes a `/root/**` grant because matching is textual."
      ],
      paths: ["src/matches.ts", "src/internal/matchesAction.ts", "src/internal/metacharacters.ts"]
    },
    {
      id: "match-budget-fails-closed",
      title: "Matching stays linear and an undecidable rule denies",
      threat:
        "An attacker-authored grant or resource stalls the kernel or lets an undecidable deny fall through to a later allow.",
      lookFor: [
        "A RegExp or recursive backtracking matcher reintroduced for resource globs.",
        "matches returning true, or evaluate skipping a rule, when pattern.length * resource.length exceeds maxMatchWork.",
        "withinMatchBudget and matchesResource using different cost formulas, so evaluate trusts a rule matches refused.",
        "A Capability or CapabilityPattern constructible with a resource longer than maxResourceLength."
      ],
      paths: [
        "src/matches.ts",
        "src/withinMatchBudget.ts",
        "src/maxMatchWork.ts",
        "src/maxResourceLength.ts",
        "src/evaluate.ts",
        "src/internal/PatternResource.ts"
      ]
    },
    {
      id: "policy-deny-veto",
      title: "A configured deny cannot be overridden by a later ruleset",
      threat: "A flow-declared or user-granted allow overrides the operator's configured deny for a capability.",
      lookFor: [
        "evaluate computing configuredEffect from any ruleset other than rulesets[0].",
        "An empty rulesets array or no matching rule yielding allow instead of ask.",
        "Last-match-wins order broken by early returns other than the budget veto."
      ],
      paths: ["src/evaluate.ts", "src/Rule.ts", "src/RuleEffect.ts"]
    },
    {
      id: "subsumes-overlap-conservative",
      title: "subsumes answers true and mayOverlap answers false only when provable",
      threat:
        "A grant store widens a grant or drops a deny restriction on an unprovable pattern relationship, granting a flow authority it never asked for.",
      lookFor: [
        "resourceSubsumes returning true for a right resource with `*` or `?` outside the `left/**` prefix, or for `a/**` over `ab`.",
        "actionSubsumes letting a namespace wildcard cover `*` or another namespace.",
        "mayOverlap returning false when a ` *` suffix pattern can match the bare prefix literal.",
        "literalPrefix ignoring a metacharacter that matchGlob honors."
      ],
      paths: ["src/subsumes.ts", "src/mayOverlap.ts", "src/internal/actionSubsumes.ts", "src/isLiteralResource.ts"]
    },
    {
      id: "parse-round-trip",
      title: "Parsing and formatting round-trip without changing authority",
      threat:
        "A persisted or model-supplied capability string parses to a wider action or resource than the text that was reviewed.",
      lookFor: [
        "parse or parsePattern splitting the resource on a colon, or accepting an action missing from Action or PatternAction.",
        "The bare `*` sentinel expanding to `**` for any input other than exactly `*`.",
        "format emitting text that parsePattern reads back as a different action or resource."
      ],
      paths: ["src/parse.ts", "src/parsePattern.ts", "src/format.ts", "src/Action.ts", "src/PatternAction.ts"]
    },
    {
      id: "tier-classification",
      title: "Out-of-workspace writes and spawns classify as irreversible",
      threat:
        "An agent's write outside the workspace or process spawn is classified compensable and runs without approval or idempotency key.",
      lookFor: [
        "lexicalPath or isInsideWorkspace treating `/w-evil` as inside root `/w`, or `..` segments as contained.",
        "A relative or `.` workspaceRoot classifying any write as compensable.",
        "A resource the host resolves as absolute but isAbsolutePath reads as relative, such as `C:\\x` or `\\\\host\\share`, classified compensable.",
        "A relative resource joined to workspaceRoot here while the fs adapter resolves it against a different cwd.",
        "A new Action added without a tierOf case, or net:post, proc:spawn, memory:write below irreversible.",
        "requiresIdempotencyKey returning false for the irreversible tier."
      ],
      paths: ["src/tierOf.ts", "src/requiresIdempotencyKey.ts", "src/EffectTier.ts", "src/TierOptions.ts"]
    },
    {
      id: "permission-error-decoding",
      title: "Untrusted permission-error payloads are validated without running their code",
      threat:
        "A foreign or forged error object runs getters, loops on cycles, or smuggles a forged PermissionRequired that an attended surface approves.",
      lookFor: [
        "isPermissionError or isPermissionMeta reading a property through an accessor or inherited getter.",
        "A cyclic or deeply nested meta object that isPermissionMeta accepts or that exhausts the stack.",
        "decodePermissionError or fromPlatformError constructing an error from fields isPermissionError did not check."
      ],
      paths: [
        "src/isPermissionError.ts",
        "src/decodePermissionError.ts",
        "src/fromPlatformError.ts",
        "src/internal/isPlainObject.ts",
        "src/internal/permissionMetaSnapshot.ts",
        "src/internal/capabilitySnapshot.ts"
      ]
    },
    {
      id: "display-escaping",
      title: "Rendered permission errors escape control and format characters",
      threat:
        "A model- or user-chosen resource spoofs an approval prompt or log line with newlines, bidi overrides, or oversized text.",
      lookFor: [
        "A field in formatError or toPlatformError interpolated without displayField.",
        "displayChunk leaving a Cc, Cf, Zl, or Zp character unescaped, or truncation splitting an escape sequence.",
        "Output longer than maxDisplayFieldLength after truncation."
      ],
      paths: [
        "src/formatError.ts",
        "src/toPlatformError.ts",
        "src/internal/displayField.ts",
        "src/maxDisplayFieldLength.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
