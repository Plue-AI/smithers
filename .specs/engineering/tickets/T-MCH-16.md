# T-MCH-16 Secrets as files at a declared path; model logins from secrets (M-42)

Stage S2 · Size M · Depends on T-MCH-12, T-MCH-11, T-SEC-01 · Unblocks —
Spec: spec.md §8.8.1a, §8.8.1b, §8.8.0, §8.7.3 · Product: mvp.md M-42 (Will, 2026-10-06, 1bca931365)

Added 2026-10-06 by smithers-8a. Extends the landed T-MCH-12 (env-var delivery) with file delivery; it does not reopen T-MCH-12.

## Goal
A maintainer adds a secret once, as an environment variable or a file at a declared path, and every branch machine's tools use it with no sign-in step. Provider API keys bound to their hosts never enter the machine.

## Scope
In: an optional `path` field on secret writes, plus its validation (`~/…` in each home, or under `/run/smithers/files/`; refusals for the working copy, escaping the home, or symlinks); the broker writing, rewriting within 5 s, and deleting files with the stated owner and mode, without following symlinks; placeholder delivery for host-bound secrets so the relay substitutes the real value; the Secrets card's path field (design: smithers-06).
Out: personal subscription sign-ins (never copied); the install's own model-access keys (unchanged, host-only); per-use recording ([D] §8.8.1); main-only secrets (§8.8.2, unchanged).

## Changes
- Reshape the existing secrets write route (T-MCH-12's surface; Owner/Maintainer per §5.2) to accept `path`; no new table beyond the column.
- Reshape the machine broker's env writer (T-MCH-12, `put-env`) into one writer that also writes files.
- Reuse the egress relay's host-bound substitution (§8.8.0) for placeholders.

## Decisions and pre-review
- smithers-3f approves path validation, the no-symlink write and the placeholder substitution before this lands. smithers-06 supplies the Secrets card's path field. smithers-b8 owns the app binding.

## Tests

C-MCH-12:
1. Add `ANTHROPIC_API_KEY` bound to `api.anthropic.com` with `path: ~/.config/anthropic/key`. Boot a fresh machine: the file exists in each home, mode 0600 and owned by that user, holding a placeholder. A request to the provider host from the machine carries the real key at the relay, and the real key appears nowhere on the machine's disk or in its environment.
2. M-42 falsifier: a fresh branch machine's coding tool runs a TODO with no sign-in step.
3. Declare a path inside the working copy, `~/../x`, a path through a symlink, and `/etc/x`: each is refused with class `user`.
4. Replace the secret: the file changes within 5 s; remove it: the file is gone within 5 s.
5. Plant a symlink at the target path before boot: the write refuses and nothing outside the home changes.

Pass when:
- Steps 1 to 5 hold with literal fixtures through the production route, broker and relay.

## Acceptance
- [C-MCH-12](../checks/C-MCH-12.md)

## Risks and notes
- A secret without declared hosts is readable by any session on the machine, including the coding agent steered by untrusted text (§8.8.1, §17). Bind model API keys to their hosts; the Secrets card should suggest the provider host for known key names.
