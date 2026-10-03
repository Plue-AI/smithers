# C-MNT-06 Outsider code cannot execute on the host or read teammate tokens

Proves: mvp.md §14, M-05, M-26, M-29 · spec.md §6.1.2b, §10.2.1, §12.4, §16.4, §17.3, §17.5 · Layer: e2e · Stage: M · Tickets: T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05
Automation: to write, as a `smthrs test` target · Runs in: reference Apple Silicon host, real install and microVMs, second-laptop browser, scratch GitHub repository

## Setup

Reference host with process-execution auditing; host-only canary file, teammate credential canaries in another machine user home, fake exfiltration listener, and real outsider issue/fork PR containing malicious text, filenames, symlinks and scripts. No real secrets in probes.

Candidate Automation declaration (unapproved): apps/app/e2e/real/maintainer-trust.spec.ts (new) · Runs in: reference Apple Silicon host, real install and microVMs, second-laptop browser, scratch GitHub repository

Receipt: CI's own check run at the landed SHA, or a `smthrs test` run on the reference host, recorded through `scripts/check-run.mjs` (minimal-code synthesis ruling 3).

## Steps

1. Submit shell substitutions, run commands, credential requests and forged approvals in issue title/body/comments, labels, PR metadata/diff and author replies. Poll and redeliver before any maintainer action.
2. Request outsider work through browser, CLI and direct API as Member, suspended member, non-roster GitHub writer and delegated agent; attempt to forge the actor.
3. Admit fresh triage and review as a maintainer. Follow every executable path, including reproduction, PR-head tests if supported and repository flow loading.
4. In each executing microVM attempt sudo, read another uid's credential files, escape paths through symlinks, contact the host secret endpoint and use run/delegated credentials to approve, merge or change members.
5. Change outsider issue/PR content after admission and submit later comments; inspect recorded inputs, approvals and steers. Replay an author reply while waiting.

## Pass when

- Steps 1–2 produce zero new runs, proposals, triage, machine requests or credentials; passive sync/activity and required label reverts are the only effects. Unauthorized requests are refused before model drafting.
- Step 3 records a live maintainer action and pinned digest for every outsider-authored admission. Host audit shows zero execution of repository/contributor code or author-supplied commands; executable flow loading and reproduction occur only in microVMs.
- Step 4 denies sudo and cross-user credential reads, path escape and privileged API calls. Host and teammate canaries never appear in inputs, outputs, GitHub writes or exfiltration logs. Machines have no seeded personal tokens, repository/main-only secrets or GitHub write credentials.
- Step 5 preserves the admitted snapshot as attributed quoted data. Later outsider text never steers, changes approvals or resumes work. New work requires a fresh maintainer action.
- Launch C-SEC-03 and machine confinement/no-sudo checks remain prerequisites and pass on the tested release; M does not postpone these controls.

## Fail when

- Any host execution of untrusted code, token disclosure, credentialed work without a maintainer action, or text-based approval passes. A prompt warning without boundary evidence is insufficient.

## Evidence

`.artifacts/checks/C-MNT-06/<UTC>/`: exact commit and install versions, detected host profile when machines run, per-step requests and receipts, database counter deltas, recorded inputs and output digests, logs and browser recordings where applicable. Redact credentials; retain denial and recovery receipts. An unexecuted check is pending.
