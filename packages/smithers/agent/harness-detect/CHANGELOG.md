# @smthrs/harness-detect

## [Unreleased]

### Security

- `findBinary` and `probeEnv` skip relative `PATH` entries, so a binary or
  interpreter planted in the cwd is never resolved.
- `--version` probes get no provider API key; `modelProbeEnv(id, source)`
  gives a model-list probe only its harness's `listCredentials`.
- `parseVersionLine` strips escape sequences and control characters and caps
  the result at `VERSION_MAX_LENGTH` (64).

### Added

- Extracted harness detection from `apps/app/src/bun/Harnesses.ts` into this
  package with the same public surface: `detectHarnessesWith`, `HarnessHost`,
  `DETECTORS`, `harnessCandidateDirs`, `findBinary`, `decodeJwtClaims`,
  `harnessModels`, `harnessModelSpec`, `parseVersionLine`, `probeEnv`,
  `PROBE_ENV_KEYS` and `VERSION_TIMEOUT_MS`.
- Kept the library runtime-neutral: nothing here spawns a process or reads a
  file. The Bun adapter — `Bun.env`, `Bun.spawn` for `--version`, the
  seatbelt-wrapped probe and the per-binary version cache — stays in
  `apps/app/src/bun/Harnesses.ts`.
