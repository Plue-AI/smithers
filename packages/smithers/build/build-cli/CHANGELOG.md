# Changelog

## Unreleased

- `review --credential-receiver <absolute executable>` writes each review's
  credential discoveries (revision, file, line and name, never a value) to the
  receiver's stdin before inference. A nonzero exit fails the review; the
  receiver's output is discarded (plue#730).

- `ci` accepts mixed exact labels for different target kinds and runs their
  union once, retaining compatible roots when another label belongs to a
  different verb. An exact label that no CI verb supports still fails (#2482).

- **Breaking:** `KnownRed.Entry` requires `failureDigest`; `Verdict` includes
  `observed` failures. Use `fingerprint` on the complete diagnostic so a new
  failure cannot reuse an old target exemption (#2466).

- Compare all generated declaration files in `Api.Compat`, including ignored output
  directories and directories containing package markers.

- Include nested Filegroup sources, declared output files, and complete output
  directories in `Files.digest` comparisons, including ignored generated files.

- Resolve private local baseline and surface producers in `Api.Compat` by their planned identities.

## 1.0.0-rc.0

- First public release candidate of the Smithers build CLI.
