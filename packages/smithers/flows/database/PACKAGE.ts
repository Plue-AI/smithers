import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { ReviewTagsMigrationsAndKeys } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/flows/database",
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] }),
  buildProgram: Smithers.file("//packages/repo-targets/scripts/build.mjs"),
  circularScript: Smithers.file("//packages/repo-targets/scripts/circular.mjs"),
  eslintConfigs: [
    Smithers.file("eslint.config.js"),
    Smithers.file("//eslint.package.js"),
    Smithers.file("//eslint.jsdoc.js"),
    Smithers.file("//eslint.invariants.js")
  ]
})

/** Run the database matrix against a declared PostgreSQL service in CI. */
const adapterPostgresDatabase = Smithers.Docker.Service({
  image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  env: { POSTGRES_PASSWORD: "smithers-adapter-test", POSTGRES_DB: "smithers_adapter_test" },
  ports: { "5432": 55436 },
  readiness: {
    exec: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "smithers_adapter_test"],
    timeout: "120s"
  },
  stop: { signal: "SIGTERM", grace: "10s" }
})

const test = Smithers.Shell.Test({
  shell: "cd packages/smithers/flows/database && node scripts/test-matrix.mjs",
  data: [
    lib,
    Smithers.file("scripts/test-matrix.mjs"),
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("test/**/*.ts"),
    Smithers.file("package.json"),
    Smithers.file("vitest.config.ts"),
    Smithers.glob("//packages/repo-targets/test-utils/effect-property.*")
  ],
  timeout: "20m",
  hosts: ["linux"],
  env: { SMITHERS_TEST_PG_URL: "postgres://postgres:smithers-adapter-test@127.0.0.1:55436/smithers_adapter_test" },
  services: [adapterPostgresDatabase],
  sandbox: { network: "loopback" }
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/database" })

/**
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`.
 */
const faults = Smithers.FaultSuite({ cwd: "packages/smithers/flows/database" })

/**
 * The security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every reviewed file.
 *
 * @since 1.0.0
 * @category lint
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/database",
  include: ["src/**", "scripts/**"],
  checks: [
    {
      id: "sql-identifier-injection",
      title: "Schema, table, trigger, and JSON-path text reaches SQL only escaped or from trusted constants",
      threat:
        "A caller or environment that controls a schema name, table name, trigger clause, or JSON path runs arbitrary SQL against every Smithers flow table in the database.",
      lookFor: [
        "A sql.unsafe or sql.literal call in Dialect.ts or TestDatabase.ts whose interpolated name, table, when, body, reject, or path is exported without a check that it is a constant or a safe identifier.",
        "Dialect.query rewriting every '?' into $n, so a template containing a '?' in a string literal or a jsonb ?-operator binds values into the wrong position.",
        "A SET search_path, CREATE SCHEMA, or DROP SCHEMA that quotes the schema by hand instead of through sql(identifier), or omits doubling embedded quotes."
      ],
      paths: ["src/Dialect.ts", "src/postgres/**", "src/test/TestDatabase.ts", "src/Migrations.ts"]
    },
    {
      id: "postgres-schema-isolation",
      title: "Environment-selected PostgreSQL gives each local store its own schema",
      threat:
        "A second Smithers workspace or user sharing SMITHERS_POSTGRES_URL reads or overwrites another store's runs because two filenames resolve to the same schema.",
      lookFor: [
        "The unprefixed schema derived from anything other than a digest of resolve(filename), or docs that stop warning that SMITHERS_POSTGRES_SCHEMA plus basename is path-independent by design and needs a distinct prefix per workspace.",
        "A ?schema= query parameter or SMITHERS_POSTGRES_SCHEMA value accepted without restricting it to a safe identifier or rejecting system schemas such as public or pg_catalog.",
        "DATABASE_URL or SMITHERS_POSTGRES_URL silently redirecting a :memory:, file: URI, or explicit SQLite path to a shared PostgreSQL server."
      ],
      paths: ["src/internal/PostgresSelection.ts", "src/postgres/**"]
    },
    {
      id: "connection-secret-leak",
      title: "PostgreSQL connection URLs and passwords never reach errors, spans, or logs",
      threat:
        "Anyone who reads a Smithers error message, trace, or CI log learns the database password of the operator's PostgreSQL server.",
      lookFor: [
        "An Error, UnsupportedDatabase message, or span attribute that interpolates the url, parsed URL, or DATABASE_URL.",
        "A connection URL passed to PgClient without Redacted.make, or a Redacted value unwrapped into a string.",
        "A test-matrix child process or console line that prints SMITHERS_TEST_PG_URL with credentials."
      ],
      paths: ["src/internal/PostgresSelection.ts", "src/postgres/**", "scripts/test-matrix.mjs"]
    },
    {
      id: "sqlite-file-permissions",
      title: "SQLite databases and their WAL and SHM sidecars are created owner-only on every driver",
      threat:
        "Another local user on a shared machine reads run transcripts, prompts, and stored secrets from a world-readable smithers database file.",
      lookFor: [
        "BunDatabase.layer handing a plain path straight to SqliteClient.layer without the exclusive 0o600 pre-create NodeDatabase.ts does in createDatabaseFile, so the file and its -wal and -shm sidecars get the umask default (0644).",
        "createDatabaseFile following a symlink or a pre-planted file at the target path instead of creating it exclusively.",
        "A mode option accepted from configuration that widens permissions beyond owner read and write without a warning."
      ],
      paths: ["src/node/**", "src/bun/**"]
    },
    {
      id: "open-guard-bypass",
      title: "The 0.x database refusal cannot be bypassed by URI parameters or lock timing",
      threat:
        "A caller opening a 0.x smithers.db through a crafted file: URI or during a peer's lock silently mixes schemas and corrupts the operator's existing run history.",
      lookFor: [
        "A file: URI whose query (mode, immutable, vfs, repeated parameters) makes probeTarget or isMemoryModeUri inspect a different file than the client opens.",
        "readTableNames returning undefined for an error other than not-found or not-a-database, which waves the open through.",
        "A lock-text match on an error string that contains a caller-chosen path, so a refusal is misclassified as a transient lock."
      ],
      paths: ["src/internal/SqliteOpen.ts", "src/node/**", "src/bun/**"]
    },
    {
      id: "migration-ledger-integrity",
      title: "The migration ledger never runs a migration twice, skips one, or lets one package claim another's block",
      threat:
        "A misdeclared or malicious package migration set rewrites or drops another storage package's tables in the shared database.",
      lookFor: [
        "A path in Migrations.ts finish or loaderFromPlan that applies a migration in a block whose recorded ledger names are not declared by the same namespace.",
        "previousNames accepting a name from another namespace, so a renamed migration adopts a foreign ledger row.",
        "A retry in run that re-applies a migration after a partial commit because the ledger insert and the migration are not in one transaction."
      ],
      paths: ["src/Migrations.ts", "src/internal/WriteRetry.ts"]
    },
    {
      id: "test-helper-production-reach",
      title: "Constraint-disabling test helpers are unreachable from production code",
      threat:
        "A production store importing @smthrs/database/test/TestDatabase disables CHECK and foreign-key constraints or drops a schema in a user's real database.",
      lookFor: [
        "TestDatabase.layer selecting a PostgreSQL server from SMITHERS_TEST_PG_URL alone, so the variable set in a production environment points constraint-dropping helpers at a real server.",
        "checks, foreignKeys, dropTrigger, or dropSchema reachable with a client that is not a disposable test_<uuid> schema, or dropSchema accepting a schema other than the one the layer created.",
        "The test-matrix script starting PostgreSQL with -A trust on a TCP listener, which lets any local user on the machine connect as superuser while the suite runs, or leaving the cluster running after a failure."
      ],
      paths: ["src/test/**", "scripts/test-matrix.mjs"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    reviewTagsMigrationsAndKeys,
    faults,
    fmt,
    lib,
    lint,
    test,
    adapterPostgresDatabase,
    ...securityReview
  }
})
