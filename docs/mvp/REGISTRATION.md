# Register a repository

Owner direction (Will, 2026-09-26). Decision D-19 in [PRODUCT.md](PRODUCT.md).
Tracking issue: #2153.
Target screen: `apps/site/public/images/app/register.png` (source
`docs/mvp/mockups/register.html`) and the Overview's "Register your repository" section.

## Goal

Signing up is valuable on its own: the user watches a workflow analyze their
repository and gets a report worth keeping, before any approval.

## Shape

1. **Start.** A **Register repository** app (`/repository.register`, deep
   link `https://smithers.sh/?register=1`). One freeform input: the
   repository link. Nothing is multiple choice for the user.
2. **Analysis is one workflow**, `flows/register-repository`, built only from
   core Smithers primitives (flows, runs, human waits, the step cache). No
   backend changes beyond the admin review relay authorized for #2157.
3. **Cached globally per GitHub repository** (canonical `owner/repo`). An
   already-registered repository never re-runs analysis: the UI says it is
   already registered and replays the whole recorded run from its journal,
   with no new model calls.
4. **Auto-discovery is visible.** Each step appears as a question the
   workflow answers itself. An AI choice has its own distinct animation (the
   options shimmer, then one locks in, marked as Smithers' choice), clearly
   different from a person's click.
5. **Admin review.** After analysis the run waits for the Smithers admin
   (Will). Approval starts a separate setup/onboarding workflow; a decline
   carries a note.
6. **Quiet status.** A sidebar row shows the repository and its state
   (Analyzing, In review, Setting up, Ready, Declined). No banners.
7. **One at a time.** A user can register many repositories over time but
   only one at once; a second start points to the unfinished run. Repeated
   clicks are deduplicated.

## Analysis steps

Each step writes a typed result that the report card renders.

| Step | How |
| --- | --- |
| Theme | Jev finds the project's name, logo, and colors; the report uses them. |
| Clone | Import the repository into Smithers Cloud through the existing path. |
| License | Jev detects it; shown as an auto-selected answer. |
| Checks | Jev answers how checks run (GitHub Actions, Makefile, scripts…). |
| Agent readiness | Level 1–5 plus a number over seven areas (test loop, CI, types and lint, AGENTS.md, reproducible setup, docs, safety), measured by actually running tests, lint, and build; top three fixes. |
| Agent-written share | Traced floor (co-author trailers, agent config, branch names) plus a Jev-estimated range; never a per-file claim. |
| Cleanup opportunities | The slop score (internal name only): 0–100 as a range from ten weighted signals (55 deterministic, 25 hybrid, 20 Jev-judged); the top three causes with file:line links and **Fix with Smithers**; "insufficient data" below 60% coverage. |
| Commit graph | Commit frequency over time and signs of agent use (co-author trailers, bot authors, bursts). |
| Contributors | Charts of who contributes and how much. |
| Contribution intake | External vs internal PRs, merge rate, time to first review, CONTRIBUTING/CLA. |
| Workflows to build | A general finder: mine PRs, use Jev to flag PRs that imply an extractable lint rule and other repeatable chores. Inspiration: the smithersai example analyses (artsy force, aomi). |
| CI speedup | Estimate on a real PR: affected build graph plus caching. |
| Anything else | Other notable findings. |

Score method and sources: [research/registration-scores.md](research/registration-scores.md).
Build order: agent readiness, deterministic cleanup signals, agent-written
share, then Jev-judged signals once the calibration corpus exists. No
per-file authorship classifier. Wording never insults the owner: "slop" stays
internal, agent use is a strength, every finding has a fix, no claims about
individual people, results private by default.

## Implementation (#2153)

- **Where it runs.** Clone is the existing GitHub import, so the registrant
  owns a Smithers Cloud repository and a workspace for it. `register-repository`
  is a coding-host builtin (`flows/repository/registry.ts`) and runs there,
  which is what lets readiness run the repository's own install, tests, lint
  and build on an exported copy (scratch `HOME`, bounded time).
- **Steps.** `flows/register-repository/workflow.ts`; typed results in
  `schema.ts`. A step whose evidence cannot be read returns `unavailable`
  naming its step, and the card hides it. GitHub is read only through the
  repository's proxy at its source coordinates, for pull requests, reviews,
  files and Actions runs (`remote.ts` `githubReadable`). Jev decides only when
  the evidence does not settle it (several names, conflicting license texts,
  several check runners) and classifies merged pull requests as lint rule,
  chore or neither.
- **Cleanup.** Deterministic signals S1-S5 only, labeled `deterministic-v0`,
  with provisional anchors and a seeded interval widened for the unmeasured
  45 points; S6-S10 and the agent-written estimate wait on the calibration
  corpus (#2160).
- **Review.** A durable `select` (Approve / Decline), then a note on decline.
  Approval runs `register-repository/setup` as a child flow in the same
  workspace. The admin's approvals inbox includes other accounts' reviews
  through `packages/backend` (#2157). The relay discovers persisted workspace
  hosts, exposes only registration review and decline-note waits, and requires
  an admin person; run credentials cannot read or answer these reviews.
  Listing is a read: it never wakes a box or starts its host. A box that is
  asleep or not answering is reported unread, its earlier inbox card stands,
  and the inbox counts it as not checked rather than failing or claiming no
  reviews (#2341).
  Answers use the existing `Approval.Submit` and durable resume path. No
  registration table or second approval model is added. Deployment verification
  remains required before removing the closed-alpha gate (#2145).
- **Cache.** Per account: a repeated registration of the same repository
  reopens the recorded run and replays its journal (no launch, no model call).
  Across accounts needs #2158.

## Tests

Unresolved admin wait; duplicate start; decline and retry; restart
mid-analysis and mid-wait; cached repository replays without model calls;
chat stays usable throughout (instant-chat rule).
