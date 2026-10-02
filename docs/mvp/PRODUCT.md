# Superseded: friendly-alpha MVP requirements

Will approved the replacement on 2026-10-02 (mvp.md M-12). The product contract is now:

- [Product overview](../../.specs/product/overview.md): what Smithers is.
- [MVP spec](../../.specs/product/mvp.md): the user, journeys, features, decisions M-01 to M-31, cuts and release.
- [Design](../../.specs/design/README.md) and [engineering](../../.specs/engineering/README.md) specs built on it.

The 2026-09-16 requirements (five maintenance jobs, setup, evals, trials and registration) are [kept in history](https://github.com/smithersai/smithers/blob/d4d2eaccab9382205f4a47e789ce560fb016b388/docs/mvp/PRODUCT.md). Don't build from them.

## Decision index

Code, tests and the MVP spec still cite these IDs. When a decision here and the MVP spec disagree, the spec wins.

### In force

| ID | Decision | Under the MVP spec |
| --- | --- | --- |
| D-09a (Will, 2026-09-25, #1745) | Supersedes D-09: the Wiki and the Mythical history are core. The repository's history is one linear `mythical` stack of logical changes written only by the stack service; every open issue is planned onto it (append, insert or amend), worked in parallel lanes, and reaches append-only `main` as one commit per item (a GitHub PR the owner merges for send-upstream repositories); merged work is folded back into the stack. Mythical history is on by default with no flag; the Wiki default follows its refresh work (#1651). Core jobs still run when a repository has no stack yet. | In force. Refined by M-07 and M-16: each TODO, not each open issue, is one stack item, and it reaches `main` as one squash-merged pull request a person merges. |
| D-09b (Will, 2026-09-26, #1651) | Supersedes the remaining Wiki part of D-09: the Wiki is core and on by default with no flag. One generator (`flows/wiki`, run as `coding/wiki` on a wiki workspace) reviews the pages `.smithers/coding-project.json` declares against the folded source after every fold of the mythical stack (landings and GitHub main pulls), and publishes the verified pages as `generated-<id>` without overwriting a person's edit. The Stack card shows whether the wiki is current, refreshing, stale or failed, with Retry. Stack requests plan with the published pages whose inputs still match their source. | In force. Refined by mvp.md §6.11; the home card shows wiki refresh runs (§6.4). |
| D-10 (revised by Will, 2026-10-01) | Remove the public marketplace and Plugin Library storefront. Preserve reusable plugin APIs and local extensions. Restoration requires a new owner decision ([#3402](https://github.com/smithersai/smithers/issues/3402)). | In force. |
| D-11 | Delete repository welcome/explore/contribute/maintain modes, the dedicated Factory inspection screen, user snapshot/template/fork controls, revision-computer forks, Linear integration, custom-agent configuration, and repository-defined home panes. “Remove” means delete, not flag. | In force, except custom-agent configuration, which returns only as configuration of the factory's agents (M-23). |
| D-16 (Will, 2026-09-26) | User-facing words are product words: conversation, issue, wiki, agent, trigger, flow, run. "Thread", "task", "charter", "grants", "profile" and similar are internal modeling terms (many things share one abstraction) and appear only where a page or screen deliberately discusses implementation. Applies to docs and visible UI copy. | In force. mvp.md §3 adds the MVP words: install, member, stack, TODO, branch, machine, card. |
| D-20 (docs orchestrator, 2026-09-26, #2161; derived from D-09a and the zero-tech-debt rule, not a quote from Will) | One history view: the mythical stack is the repository history; the History button opens it; no separate narrative view. `history.show` is the one command (button, slash and agent call); `history.bootstrap`, `history.backfill`, `history.parallel` and `history.retry` are its writes. | In force. The command is `/stack` (mvp.md Appendix A); bootstrap and backfill controls are hidden (§8). |
| D-21 (review-gates orchestrator, 2026-09-27; follows GitHub's request-changes default, not a quote from Will) | A person's current request-changes review blocks landing for everyone, people included, until the same person's later approval supersedes it (as on GitHub, a later comment does not) or it is dismissed: by that person, or by a repository admin (a person) who is not the landing's author; the author never dismisses it, and run credentials cannot. The landing gate states `changes requested by <login>`. An agent's request-changes review, including one given through a run credential, blocks no one; `required_agent_lgtm` is the agent review policy. | In force for landings. TODOs reach `main` through GitHub pull requests (M-01), where GitHub's review rules apply (§6.3). |
| D-22 (Will, 2026-09-27, owner decision relayed through the orchestrator queue) | Only the reviewer agents a repository names count toward `require_agent_lgtm` and an ownership `auto_land` policy: `S.Github.Policy({ reviewerAgents })`, read from the default bookmark's `.smithers/factory.json`. A reviewer agent is an agent account (bot or service) with that login; a run credential reviews as its person's account and names no agent, so its LGTM never counts. Other agents' reviews stay visible and count for nothing. With no list, no agent LGTM counts. | In force. |
| D-23 (Will, 2026-09-27, owner decision relayed through the orchestrator queue) | An agent's landing onto the default bookmark needs a person's approval through the landing review gate: one current approval by a person (not an agent account, not a run credential), checked before queueing, by auto-land, in the landing list, and again by the worker right before it writes. The gate states one reason: `an agent's landing onto the default bookmark needs a person's approval` (the app shows `person approval missing`). The agent's own person may approve it. An agent (a run credential, or an agent account's own token) cannot land a person's landing onto the default bookmark, retarget one onto it, or set a person's landing to auto-land, and its direct writes of the default bookmark stay refused. A send-upstream repository delivers through its GitHub pull request, whose merge is the approval; that path never passes this gate, and a direct land onto its Smithers main is still gated. Landings onto other bookmarks are unchanged. | In force. mvp.md rule 6 (People merge) and §6.10 build on it. |
| D-24 (Will, 2026-09-27, owner decision relayed through the orchestrator queue) | A repository secret can be main-only, like a GitHub environment limited to the default branch. It reaches only a run whose trigger is a person's push to the default bookmark, or a scheduled or a person's dispatched run on it: the trusted triggers that save workflow caches, on exactly that bookmark. Agent runs, outsider runs, and landing, pull request, branch and tag runs never receive it. An administrator (a person) marks it when setting it or on its own (`/secrets.scope`, `smithers secret set --main-only`, `smithers secret scope`, `PATCH .../secrets/{name}`); replacing its value keeps the mark. Organization secrets are unchanged. | In force. mvp.md §6.15 (Secrets) builds on it. |
| D-25 (Will, 2026-09-27, owner decision relayed through the orchestrator queue) | Issues agents file never start credentialed work on their own. A native issue records who filed it (`filed_by`): the account that wrote it, or an agent source: `run` (an agent run's credential, including one acting as the owner), `linear` (the Linear import), `trial` (a repository job's live trial nobody pressed); issues from before this are `unknown`. Its text is never a maintainer's, even after a maintainer rewrites it; an agent account's own writes are not a maintainer's either. It starts work only through the one trust rule: a maintainer person's trigger label, or an owner-committed `S.Github.Policy({ agentIssueSources })` on the default bookmark naming its source while that source alone wrote its text. A trial's registration no longer approves its issue; a person's own press of Trial (a person-only route) files that request's trial issue as that person's. An unreadable rule approves nothing. Exception (Will, 2026-09-28): an issue a maintainer named in `S.Github.Policy({ maintainers })` writes after its `todoSince` is a TODO at once; the factory labels it `todo` itself. | In force from launch (mvp.md §8, §14). |
| O-04 | Landing requires human approval by default, independently of the setting that starts implementation. | In force: mvp.md rule 6 (People merge). |

### Superseded, cut or deferred

| ID | Status |
| --- | --- |
| D-01 | Superseded by J1: one setup card. The five-job setup is cut (mvp.md §8). |
| D-02 | Deferred to the maintainer release (mvp.md §14). |
| D-03 | Deferred to the maintainer release (mvp.md §14). |
| D-04 | Superseded. Review is a step of the TODO flow, `/review` stays, and outside-PR review moves to the maintainer release (§14). |
| D-05 | Cut: CI setup, AI checks and the CI matrix (mvp.md §8). GitHub checks are the checks. |
| D-06 | Cut: the Feature and Chores jobs (mvp.md §8). TODOs and the TODO flow replace them. |
| D-07 | Superseded by M-11: default flows are built in, and the repository holds `flows/<name>/flow.ts` only after the team customizes it. |
| D-08 | Cut: evals and trials (mvp.md §8). |
| D-09 | Superseded by D-09a and D-09b. |
| D-11a | Superseded by mvp.md §6.4: the home card is the stack. |
| D-12 | Refined. No Electrobun desktop app; the Mac install is a launchd service (mvp.md §6.1). Cloud waits until after the MVP (M-09). |
| D-13 | Replaced by the overview's scope rule: a feature the spec doesn't name is a candidate to delete or defer, decided one at a time. |
| D-14 | Cut: AI checks (mvp.md §8). |
| D-15 | Superseded by mvp.md §11 (build order) and §12 (release). |
| D-17 | Superseded by mvp.md §12: one quickstart for this user plus the flow reference. The TUI is deferred from launch (§8). |
| D-18 | Superseded by mvp.md §6.4: the home card is the stack. The five job tiles are cut (§8). |
| D-19 | Cut: repository registration and admin review (mvp.md §8). |
| O-01 | Deferred to the maintainer release (mvp.md §14). |
| O-02 | Superseded: work starts when a member commits a TODO (mvp.md §4, J2). |
| O-03 | Deferred to the maintainer release, unchanged: replies to authors are draft-first (mvp.md §14). |
| O-05 | Cut with the activation wizard, evals and trials (mvp.md §8). |
| O-06 | Cut with activation (mvp.md §8). |
| O-07 | Cut with AI checks (mvp.md §8). |
| O-08 | Not restated. The jobs it bounded are cut (§8) or deferred (§14, §16). |
| O-09 | Cut with the Feature and Chores jobs (mvp.md §8). |

Requirement IDs from the old document (UX, ISS, PR, CI, FEAT, CHORE, EVAL, KEEP, REL, CUT, FLAG and BOUND) belong to the five-job MVP and have no successor; the spec's journeys J1 to J11 and its §12 release criteria replace them.
