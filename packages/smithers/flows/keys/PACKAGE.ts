import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/keys"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/keys" })

/** Security review: `security` reviews the diff, `securityAudit` audits the package. */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/keys",
  include: ["src/**", "scripts/**", "package.json", "docs/**", "README.md"],
  checks: [
    {
      id: "key-material-redaction",
      title: "Key derivation failures never carry the key input in a message or reported issue",
      threat:
        "Anyone reading logs, run records, or API errors learns secret-bearing key material a caller hashed into a flow key.",
      lookFor: [
        "A KeyDerivationError message or SchemaIssue message in src/deriveKey.ts or src/DerivedKey.ts that interpolates the input or serialized value.",
        "A decode call on Canonical or the DerivedKey codec that omits `reportInput: false`, so the issue tree retains the input.",
        "The DerivedKey encode path (SchemaGetter.forbidden) or the declareConstructor parser returning an issue that embeds the key or its input.",
        "KeyDerivationError `cause` (Schema.Unknown) holding a schema issue or crypto failure that carries the input, since encoding the error for a journal or API ships `cause` too."
      ],
      paths: ["src/deriveKey.ts", "src/DerivedKey.ts", "src/KeyDerivationError.ts"]
    },
    {
      id: "key-collision",
      title: "Distinct key inputs derive distinct keys",
      threat:
        "A flow author or run input gets a cached or approved result recorded under another computation's key by crafting input that canonicalizes to the same bytes.",
      lookFor: [
        "Values Canonical drops or coalesces before hashing (functions, undefined fields, symbols, NaN, -0) that deriveKey accepts without failing.",
        "Hashing anything other than the full Canonical serialization, or a truncated digest, in src/deriveKey.ts.",
        "Docs or examples that build key input without a stable domain and version, so two protocols share one key space."
      ],
      paths: ["src/deriveKey.ts", "docs/**", "README.md"]
    },
    {
      id: "stored-key-strict-parse",
      title: "Stored keys accept exactly key1_ plus 64 lowercase hex characters",
      threat:
        "A tampered store row or network message smuggles a malformed or unsupported key into cache, journal, or path lookups.",
      lookFor: [
        "The KeyV1 pattern in src/KeyV1.ts losing its ^ or $ anchor, allowing uppercase, a different length, or path characters.",
        "StoredKey in src/StoredKey.ts accepting a key<n>_ prefix this release cannot derive.",
        "`digest` in src/digest.ts accepting an unvalidated string or slicing without the KeyV1 brand guaranteeing the prefix."
      ],
      paths: ["src/KeyV1.ts", "src/StoredKey.ts", "src/digest.ts"]
    },
    {
      id: "derive-vs-parse-confusion",
      title: "Parsing a received key never re-derives it and deriving never accepts a key as-is",
      threat:
        "A caller that decodes a received `key1_` string with DerivedKey gets a fresh key instead of a validation failure, so lookups miss integrity checks or hit the wrong entry.",
      lookFor: [
        "DerivedKey decoding a string that already matches KeyV1 by returning it unchanged instead of hashing it.",
        "Docs or examples in docs/** that use DerivedKey or deriveKey to validate persisted or received keys instead of StoredKey."
      ],
      paths: ["src/DerivedKey.ts", "src/StoredKey.ts", "docs/**"]
    },
    {
      id: "publish-surface",
      title: "The published package exposes only the declared Key entry points and a real SHA-256",
      threat:
        "A consumer of the npm package imports an internal path or a build artifact whose hashing differs from source, weakening every key it derives.",
      lookFor: [
        "package.json exports or publishConfig.exports exposing ./internal/* or paths beyond ., ./Key, ./index and ./package.json.",
        "scripts/build.mjs or package.json `files` publishing sources outside src/ and dist/.",
        "A digest import other than @smthrs/crypto `digest`, or a non-cryptographic hash, in src/deriveKey.ts."
      ],
      paths: ["package.json", "scripts/**", "src/deriveKey.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
