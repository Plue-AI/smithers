import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/crypto"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/crypto" })

/** Security review: `security` reviews the diff, `securityAudit` audits every file. */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/crypto",
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "sha256-fips-correctness",
      title: "The handwritten SHA-256 matches FIPS 180-4 for every length and prefix split",
      threat:
        "Any caller hashing attacker-shaped input gets a wrong or colliding digest, so a content-addressed store or cache accepts forged content as another artifact.",
      lookFor: [
        "Padding or the 64-bit bit-length words in sha256 and Sha256Prefix.finish computed wrongly for lengths at 55, 56, 63, 64 bytes or above 2^29 and 2^32 bytes.",
        "Sha256Prefix.clone or update sharing a hash, tail, or DataView buffer so one prefix's later update mutates a cloned prefix.",
        "A 32-bit arithmetic step in compress missing its >>> 0 so a round constant or schedule word leaks sign bits."
      ],
      paths: ["src/internal/sha256.ts"]
    },
    {
      id: "function-identity-collision",
      title: "Functions that can compute different results never share a FunctionIdentity digest",
      threat:
        "A flow author or imported module gets a plan-time step cache hit for a function with different captured values, so another run's cached output is served as this run's result.",
      lookFor: [
        "Two distinct (source, captures) pairs that produce the same `${source}\\0${captures}` preimage, for example a capture encoding that can contain a raw NUL or unescaped delimiter.",
        "canonicalCapture encoding two different frozen copies (key order, -0, array vs object, nested capture) to the same string.",
        "An unannotated function whose ephemeral identity is reused across functions or processes (ordinal or nonce reuse, nonce seeded from a non-CSPRNG)."
      ],
      paths: ["src/Identity.ts"]
    },
    {
      id: "opaque-source-identity",
      title: "capture and functionIdentity refuse functions whose source text does not describe their behavior",
      threat:
        "A flow author captures two different bound or native functions, both stringifying as `function () { [native code] }`, so one gets the other's cached step result.",
      lookFor: [
        "capture or functionIdentity accepting a function whose Function.prototype.toString contains `[native code]`, such as fn.bind(x), without refusing or folding in ephemeral entropy.",
        "A Proxy-wrapped or class-static function whose toString text is shared by functions computing different results."
      ],
      paths: ["src/Identity.ts"]
    },
    {
      id: "capture-admission-inert",
      title: "capture admits only finite, inert, plain data and freezes a copy the caller cannot mutate",
      threat:
        "A flow author passes a Proxy, getter, or built-in object whose value changes after admission, so the recorded identity no longer describes what the operation reads and a stale cache entry is reused.",
      lookFor: [
        "A path where a caller-controlled getter, Proxy trap, Symbol.toStringTag, or valueOf runs before or after the snapshot and changes what is copied.",
        "A branded built-in (Map, Date, typed array, Error, WeakRef) or non-plain prototype that passes snapshotCapture and refuseExotic.",
        "The wrapped operation receiving the caller's original object instead of the frozen copy, or any copy left writable or configurable."
      ],
      paths: ["src/Identity.ts"]
    },
    {
      id: "identity-global-state",
      title: "The Symbol.for-keyed identity state cannot be pre-seeded or forged by other code in the realm",
      threat:
        "A dependency loaded before this package plants a known nonce or registers fake capture metadata, so ephemeral identities become predictable and forged functions get another function's cached result.",
      lookFor: [
        "globalThis[Symbol.for(\"@smthrs/crypto/Identity/state/v4\")] adopted without checking its shape, WeakMap brands, or nonce format.",
        "processNonce or the shared state letting a caller learn or set the nonce in a way that lets a second process reproduce ephemeral digests."
      ],
      paths: ["src/Identity.ts"]
    },
    {
      id: "text-encoding-canonical",
      title: "Text is hashed as strict UTF-8 with no lossy replacement or normalization",
      threat:
        "An attacker supplies two different strings, such as ones with lone surrogates, that encode to the same bytes, so two distinct inputs share one digest.",
      lookFor: [
        "isWellFormed missing a lone high surrogate at the string end or a lone low surrogate, letting TextEncoder substitute U+FFFD.",
        "makeDigestPartsSync documented or used as a structured hash although [\"ab\",\"c\"] and [\"a\",\"bc\"] digest identically.",
        "Byte input not copied before hashing, so a caller mutating the Uint8Array concurrently changes what is hashed."
      ],
      paths: ["src/Sha256.ts"]
    },
    {
      id: "host-digest-validation",
      title: "digest rejects an injected Crypto host's malformed output instead of returning it as a Digest",
      threat:
        "A faulty or hostile injected Crypto layer returns short, non-byte, or mutable output, so callers store a Digest that is not a real SHA-256 of their input.",
      lookFor: [
        "A host result branded as Digest without the Uint8Array check, copy, and exact 32-byte length check.",
        "A host throw or defect escaping as an untyped defect instead of Sha256Error digest_failed.",
        "syncCrypto answering randomBytes or a non-SHA-256 algorithm instead of refusing."
      ],
      paths: ["src/Sha256.ts"]
    },
    {
      id: "digest-input-leak",
      title: "Hash failures and schema issues never carry the hashed input",
      threat:
        "A service hashing a secret logs a Sha256Error or SchemaError that includes the secret, exposing it to anyone who reads the logs.",
      lookFor: [
        "A Sha256Error message or schema issue message that interpolates the input string or bytes.",
        "Sha256Schema decoding without reportInput: false, or an issue annotation that retains the input rather than the typed error."
      ],
      paths: ["src/Sha256.ts"]
    },
    {
      id: "docs-misuse-guidance",
      title: "Docs never teach SHA-256 as a MAC, password hash, KDF, or constant-time comparison",
      threat:
        "A developer copies a docs snippet that hashes a secret prefix or compares a secret-bearing digest with ===, so an attacker forges a MAC or times the comparison.",
      lookFor: [
        "A docs or README example building digest(secret + message) as authentication or hashing a password.",
        "An example comparing a digest derived from secret input with === in an authentication decision."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
