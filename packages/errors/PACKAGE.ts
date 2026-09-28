import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/errors"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "error-context-exposure",
      title: "SmithersError never adds a serialization path that widens what a caller attached",
      threat:
        "A log reader or API client sees a bot token, API key, or webhook secret an adapter attached to details or cause, because the error re-exposes it in message, toJSON, or inspect output.",
      lookFor: [
        "A toJSON, Symbol.for('nodejs.util.inspect.custom'), or enumerable getter on SmithersError that folds cause or nested details into message or serialized output.",
        "The constructor interpolating details or cause into message or summary instead of storing them in separate fields.",
        "details stored by reference instead of the shallow Object.freeze({ ...details }) copy, letting a caller mutate it after a redaction check."
      ],
      paths: ["src/SmithersError.ts"]
    },
    {
      id: "shape-refinement-forgery",
      title: "hasSmithersErrorShape stays a total, side-effect-contained structural check that is never trusted as provenance",
      threat:
        "A caller who throws an attacker-built object (proxy or getter-laden Error) crashes or misroutes a failure classifier, or passes a forged error as a genuine Smithers failure.",
      lookFor: [
        "A property read on value in hasSmithersErrorShape that runs outside the try block, letting a throwing getter or proxy trap escape.",
        "A code, summary, docsUrl, or details test that accepts values outside the closed code set or non-plain details (arrays, null).",
        "Docs or JSDoc that present hasSmithersErrorShape or the name field as proof an error came from Smithers rather than a structural match."
      ],
      paths: ["src/SmithersError.ts", "docs/guides/detect-an-error-across-module-copies.md"]
    },
    {
      id: "closed-code-table",
      title: "The error-code table is frozen and lookups only accept own keys",
      threat:
        "Any module sharing the process adds or rewrites a code definition, or a string like __proto__ or toString passes as a valid code and misroutes error handling.",
      lookFor: [
        "isSmithersErrorCode or getSmithersErrorDefinition using `in`, bracket lookup, or optional chaining instead of Object.hasOwn on smithersErrorDefinitions.",
        "smithersErrorDefinitions, a nested definition, or smithersErrorCodes left unfrozen after module load.",
        "ERROR_REFERENCE_URL or docsUrl derived from caller input or served over a non-https URL, since it is appended to every user-visible message."
      ],
      paths: ["src/ErrorCode.ts", "src/SmithersError.ts"]
    },
    {
      id: "docs-redaction-examples",
      title: "Copyable examples redact credentials before constructing an error",
      threat:
        "A developer copies a docs snippet that attaches a raw bot token, API key, or webhook secret to details or cause, leaking it into their users' logs.",
      lookFor: [
        "A docs or README example passing a token, key, secret, or authorization header into SmithersError details, summary, or cause without a redaction call.",
        "A literal credential-shaped value (bot<id>:<secret>, sk-..., ghp_...) in an example."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
