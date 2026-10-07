# Cross-package globs

Since 1.0.0, `TargetIndex` compares declared globs with their package-scoped
cache-key expansion. A glob matching files only across package boundaries is
refused by `DeclaredInputCrossesPackage` from `@smthrs/build-cli/PackageError`.
Its `crossing` entries (`CrossingInput`) contain `path`, `label`, `sourceFile`,
and `packages`, the workspace-relative owning package directories. Depend on
an owning package's label instead of globbing its files.

`scripts/fixtures/cross-package-globs.json` records reviewed existing crossings
as `{ label, path }`. It permits only those exact declarations. Remove an entry
when its declaration stops crossing; stale entries fail with
`CrossPackageGlobReviewInvalid` (`reason: "stale"`, `entries`). Malformed or
unreadable lists fail with `reason: "unreadable"` and the original `cause`.
An absent list permits no crossings. The list does not change cache keying.
Both index writing and checking enforce this ratchet, including exclusions,
ignore rules and repository boundaries used by normal input expansion.
