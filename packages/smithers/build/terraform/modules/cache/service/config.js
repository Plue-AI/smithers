/*
 * Startup configuration, validated before anything binds a port or opens a
 * connection.
 *
 * A cache that starts with a NaN port or an undefined connection string fails
 * later, in a request, as a 503 that looks like a storage outage. Refusing at
 * startup with the list of what is wrong is the only diagnosis an operator can
 * act on.
 */

import { maxArtifactBodyBytes } from "./protocol.js"

/** The largest artifact bound an operator may configure. */
export const maxConfigurableBodyBytes = maxArtifactBodyBytes

const defaultPort = 8080
const defaultMaxBodyBytes = maxArtifactBodyBytes
const maxDatabaseUrlBytes = 8192
const maxTokenBytes = 4096
const textEncoder = new TextEncoder()
const controlCharacters = /[\u0000-\u001f\u007f]/

const utf8Bytes = (value) => textEncoder.encode(value).byteLength

/** Parses a decimal integer, rejecting "8080.5", "0x10", "1e3", and " 12". */
const integer = (text) => (typeof text === "string" && /^[0-9]+$/.test(text) ? Number(text) : Number.NaN)

const sha256Hex = (text) => new Bun.CryptoHasher("sha256").update(text, "utf8").digest("hex")

/**
 * Reads and validates one bearer credential.
 *
 * A credential travels as an `Authorization` value, and a credential is
 * visible ASCII with no spaces. A token carrying a space hashes to something no
 * client can present, because the header value arrives with its optional
 * whitespace already trimmed; the symptom is every request answering 401 with
 * nothing to read. The shape is the one variables.tf validates, so both ends
 * refuse the same values, and the value itself is never echoed.
 */
const readToken = (env, name, problems) => {
  const token = env[name] ?? ""
  if (typeof token !== "string" || controlCharacters.test(token)) {
    problems.push(`${name} must not contain control characters`)
    return ""
  }
  if (token !== "" && (token.length < 16 || utf8Bytes(token) > maxTokenBytes || !/^[!-~]+$/.test(token))) {
    problems.push(
      `${name} must be 16-${maxTokenBytes} printable ASCII bytes with no spaces, ` +
        "or empty for development mode"
    )
    return ""
  }
  return token
}

/**
 * Validates the service environment.
 *
 * Returns every problem at once rather than the first, so one restart reports
 * the whole misconfiguration.
 *
 * The cache takes two credentials, not one. A single token that both reads and
 * publishes is the cache-poisoning path `infra/CACHE-TRUST.md` describes: every
 * holder can replace an entry every later job trusts. `SMITHERS_CACHE_READ_TOKEN`
 * may read, and only `SMITHERS_CACHE_WRITE_TOKEN` may publish or delete. They
 * are set together or not at all: one of the two on its own is a deployment
 * that silently grants one direction to nobody, or write access to whoever
 * holds the only token there is.
 *
 * They must also differ. Two equal values are one credential under two names,
 * and the classifier answers `write` for it, so accepting them would leave
 * every reader able to publish while the configuration claimed otherwise.
 *
 * Both empty is the documented development mode: the bearer check is disabled,
 * and the module publishes the port on loopback only. `SMITHERS_CACHE_TOKEN`,
 * the name the single-credential service used, is refused rather than accepted
 * as both, because accepting it would hand write access to every reader of a
 * deployment that thought it had upgraded.
 *
 * @category constructors
 */
export const readConfig = (env) => {
  const problems = []

  const readNamespacePrefix = env.SMITHERS_CACHE_READ_NAMESPACE_PREFIX ?? ""
  if (typeof readNamespacePrefix !== "string" || (readNamespacePrefix !== "" && !/^[A-Za-z0-9_-]+\/$/.test(readNamespacePrefix))) {
    problems.push("SMITHERS_CACHE_READ_NAMESPACE_PREFIX must be one namespace ending in /")
  }

  const rawPort = env.PORT ?? String(defaultPort)
  const port = integer(rawPort)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    problems.push("PORT must be an integer between 1 and 65535")
  }

  const rawMaxBodyBytes = env.SMITHERS_CACHE_MAX_BODY_BYTES ?? String(defaultMaxBodyBytes)
  const maxArtifactBytes = integer(rawMaxBodyBytes)
  if (
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes < 1 ||
    maxArtifactBytes > maxConfigurableBodyBytes
  ) {
    problems.push(
      `SMITHERS_CACHE_MAX_BODY_BYTES must be an integer between 1 and ${maxConfigurableBodyBytes}`
    )
  }

  const databaseUrl = env.DATABASE_URL ?? ""
  let parsedDatabaseUrl = null
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    problems.push("DATABASE_URL must be set to the cache connection string")
  } else if (utf8Bytes(databaseUrl) > maxDatabaseUrlBytes || controlCharacters.test(databaseUrl)) {
    problems.push(`DATABASE_URL must be at most ${maxDatabaseUrlBytes} bytes and contain no control characters`)
  } else {
    try {
      parsedDatabaseUrl = new URL(databaseUrl)
    } catch {
      // The value is never echoed: a connection string carries the password.
    }
    if (
      parsedDatabaseUrl === null ||
      (parsedDatabaseUrl.protocol !== "postgres:" && parsedDatabaseUrl.protocol !== "postgresql:") ||
      parsedDatabaseUrl.hostname.length === 0 ||
      parsedDatabaseUrl.pathname.length <= 1 ||
      parsedDatabaseUrl.hash.length > 0
    ) {
      problems.push("DATABASE_URL must be a well-formed postgres URL with a host and database name")
    }
  }

  const read = readToken(env, "SMITHERS_CACHE_READ_TOKEN", problems)
  const write = readToken(env, "SMITHERS_CACHE_WRITE_TOKEN", problems)
  const legacy = env.SMITHERS_CACHE_TOKEN ?? ""
  if (typeof legacy === "string" && legacy !== "") {
    problems.push(
      "SMITHERS_CACHE_TOKEN is no longer accepted: set SMITHERS_CACHE_READ_TOKEN and " +
        "SMITHERS_CACHE_WRITE_TOKEN, so a job that only consumes the cache cannot publish to it"
    )
  }
  if ((read === "") !== (write === "")) {
    problems.push(
      "SMITHERS_CACHE_READ_TOKEN and SMITHERS_CACHE_WRITE_TOKEN must both be set, " +
        "or both be empty for loopback development mode"
    )
  } else if (read !== "" && read === write) {
    // Two equal values are one credential wearing two names, and the classifier
    // answers `write` for it, so the split would be configuration theatre: every
    // holder of the read token could publish. variables.tf refuses this too; the
    // service refuses it as well, because a deployment can reach this file
    // without Terraform.
    problems.push(
      "SMITHERS_CACHE_READ_TOKEN and SMITHERS_CACHE_WRITE_TOKEN must differ, " +
        "or every holder of the read credential can publish"
    )
  }

  if (problems.length > 0) return { ok: false, problems }
  const development = read === "" && write === ""
  if (development && readNamespacePrefix !== "") {
    return { ok: false, problems: ["SMITHERS_CACHE_READ_NAMESPACE_PREFIX requires a configured read token"] }
  }
  return {
    ok: true,
    config: {
      port,
      maxArtifactBytes,
      databaseUrl,
      // Neither token is retained, so nothing downstream can log one.
      readTokenHash: development ? null : sha256Hex(read),
      readNamespacePrefix,
      writeTokenHash: development ? null : sha256Hex(write),
      development,
      hostname: development ? "127.0.0.1" : "0.0.0.0"
    }
  }
}
