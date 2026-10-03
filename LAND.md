# Landing

For authorized bootstrap work, use `pnpm commit --push --test "<command>"`
from the invoking checkout. The helper also requires the existing test receipts
or an explicit `--no-test "<reason>"` exception.
Before either Git or jj publication it runs:

```sh
smthrs lint '//:driftCi' '//:targetIndex' '//:ci' '//scripts:trackedHygiene' '//scripts:conflictMarkers'
```

A nonzero gate prevents publication and preserves its output. Gates receive no
install credentials. Publication records the exact validated tree; edits during
validation refuse push. Fix failures and rerun; do not exempt known failures.

The generated drift workflow retains one non-cancelling verdict per SHA.
The required status is `Per-commit drift`. The CI owner verifies repository
settings and a clean per-SHA run before activating enforcement. Long CI stays
advisory while its separate repair is outstanding.
