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
   backend changes.
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
| Agent readiness | A score for how ready the repository is for coding agents. |
| Slop score | How AI-generated the code looks, framed positively; method in research (see below). |
| Commit graph | Commit frequency over time and signs of agent use (co-author trailers, bot authors, bursts). |
| Contributors | Charts of who contributes and how much. |
| Contribution intake | External vs internal PRs, merge rate, time to first review, CONTRIBUTING/CLA. |
| Workflows to build | A general finder: mine PRs, use Jev to flag PRs that imply an extractable lint rule and other repeatable chores. Inspiration: the smithersai example analyses (artsy force, aomi). |
| CI speedup | Estimate on a real PR: affected build graph plus caching. |
| Anything else | Other notable findings. |

Slop-score research: `~/smithers-slop-score-research-2026-09-26.md`
(to be folded into this file when it lands).

## Tests

Unresolved admin wait; duplicate start; decline and retry; restart
mid-analysis and mid-wait; cached repository replays without model calls;
chat stays usable throughout (instant-chat rule).
