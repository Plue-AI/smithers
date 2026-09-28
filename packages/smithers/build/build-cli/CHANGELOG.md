# Changelog

## Unreleased

- Compare all generated declaration files in `Api.Compat`, including ignored output
  directories and directories containing package markers.

- Include nested Filegroup sources, declared output files, and complete output
  directories in `Files.digest` comparisons, including ignored generated files.

- Resolve private local baseline and surface producers in `Api.Compat` by their planned identities.

## 1.0.0-rc.0

- First public release candidate of the Smithers build CLI.
