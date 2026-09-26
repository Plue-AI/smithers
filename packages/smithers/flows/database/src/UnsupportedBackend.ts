/** Notices for legacy database settings that are no longer consumed.
 * @since 1.0.0
 */
import * as ReleasePolicy from "./internal/ReleasePolicy.ts"

/** An environment as `process.env` presents it. */
type Source = Readonly<Record<string, string | undefined>>

/**
 * The `SMITHERS_*` names rc.0 ignores: `SMITHERS_TEST_PG_URL` and every
 * `SMITHERS_POSTGRES_*` name (the release policy).
 *
 * The separator is part of the prefix. Every name 0.x actually read carries it
 * (`SMITHERS_POSTGRES_URL`, `SMITHERS_POSTGRES_POOL_MAX`,
 * `SMITHERS_POSTGRES_ACQUIRE_TIMEOUT_MS`), and dropping it would announce
 * `SMITHERS_POSTGRESQL_URL`, a name neither release reads, as one rc.0 decided
 * to ignore.
 *
 * Sorted, so an operator reading two runs compares two identical lists, and
 * de-duplicated by construction because an environment has one value per name.
 * An exported-but-blank name counts as unset, the convention every other read
 * of the environment follows.
 *
 * @category getters
 * @since 1.0.0
 */
export const ignoredNames = (environment: Source): ReadonlyArray<string> =>
  Object.keys(environment)
    .filter((name) =>
      (name === "SMITHERS_TEST_PG_URL" ||
        (name.startsWith("SMITHERS_POSTGRES_") && name !== "SMITHERS_POSTGRES_URL" &&
          name !== "SMITHERS_POSTGRES_SCHEMA")) &&
      environment[name] !== undefined && environment[name] !== ""
    )
    .sort()

/**
 * The one line an ignored name gets, verbatim from the release policy.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ignoredNotice = (name: string): string =>
  `ignored: ${name} has no effect in ${ReleasePolicy.releaseVersion} (use SMITHERS_POSTGRES_URL to select PostgreSQL)`
