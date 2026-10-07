# C-UI-14 Remote carets keep keystroke latency in budget (M-43 falsifier)

Proves: mvp.md M-43, §6.8 · spec.md §7.4.5 · Layer: e2e on the reference host plus a second Mac · Stage: S3 · Tickets: T-UI-19

## Steps
1. Two members open the same file in the File card on one branch machine, with the carets flag on; each types continuously for 5 minutes while the other's caret and selection move.
2. Repeat with the flag off.

## Pass when
- Keystroke p95 for each member stays within C-SPK-07's 1 s with the flag on (n ≥ 1,000 keystrokes per member), and each sees the other's caret and selection in that person's colour beside the gutter name flag.

## Fail when
- p95 exceeds 1 s with the flag on: the flag ships off and the result goes to 98.

## Evidence
`.artifacts/checks/C-UI-14/<UTC>/`: per-keystroke latency samples for both members, flag state, build sha.
