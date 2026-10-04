/**
 * The factory that develops smithersai/smithers: what this repository
 * features, what its Dispatcher listens for, who writes `main`, and the app
 * home a visitor sees first. Declared here beside WORKSPACE.ts, never in a
 * PACKAGE.ts; a target it needs is named by label, `S.label("//:ci")`, never
 * imported. `//:factoryProjection` projects this file into
 * `.smithers/factory.json` and `.smithers/home.json`, the files smithers.sh
 * reads from the public mirror signed out; `ci` fails on drift.
 */
import { Smithers as S } from "@smthrs/targets"

// --- featured flows --------------------------------------------------------
// The flows this repository recommends first, and the one line each shows
// under its id. A flow describes itself in flows/<id>/flow.mdx; how the
// repository presents it is declared here and nowhere else, riding the same
// summary and featured pair every target carries. The projection joins these
// declarations over the discovered flows; a declaration naming no discovered
// flow fails that projection by id.
export const review = S.Flow({
  flow: "review",
  summary: "Review the uncommitted change and return a verdict.",
  featured: true
})
export const lint = S.Flow({
  flow: "lint",
  summary: "Lint the files you name against this repository's conventions and fix what it finds.",
  featured: true
})
export const prTriage = S.Flow({
  flow: "pr-triage",
  summary: "Triage one pull request for scope, tests, docs, and review readiness from its diff alone.",
  featured: true
})
export const issueTriage = S.Flow({
  flow: "issue-triage",
  summary: "Reproduce and triage one GitHub issue into a structured maintainer response.",
  featured: true
})
export const releaseNotes = S.Flow({
  flow: "release-notes",
  summary: "Draft release notes from the commits since the last tag, grouped by package.",
  featured: true
})
export const issueSweep = S.Flow({
  flow: "issue-sweep",
  summary: "Work every open GitHub issue that no other machine holds.",
  featured: true
})
// --- end featured flows ----------------------------------------------------

export const factory = S.Factory({
  summary: "How smithersai/smithers develops itself.",
  flows: [review, lint, prTriage, issueTriage, releaseNotes, issueSweep],
  // The day-one Dispatcher table (factory design 2026-09-07 §7). These are
  // the rules the factory declares; the Dispatcher card shows each as a
  // declared row with its sentence. The flows they name land with the
  // factory flows; a rule whose flow is not registered yet is still the
  // declaration, never a live registration.
  // No issue.opened rule: issue-triage reads a prepared context file and
  // leaves its report for a token-holding apply step, and an unapproved
  // outsider's issue starts no factory run (#2915). Triage stays a manual
  // flow and never authorizes implementation; only a TODO does.
  on: {
    // The stack service itself runs these three rows: it implements every
    // TODO (an issue a maintainer labeled todo) as a Change on the mythical
    // history, reviews the pull request each Change opens or updates, and
    // merges it once the review approves a TODO a maintainer also labeled
    // automerge. Anyone else's todo or automerge label is taken off.
    "issue.labeled:todo": { flow: "todo", description: "Implement every TODO" },
    "change.opened": { flow: "review/change", description: "Review every Change" },
    "change.updated": { flow: "review/change", description: "Review every Change" },
    // The stack service itself folds main into the mythical history after
    // every landing and GitHub main pull, then refreshes the wiki on the
    // folded tip (coding/wiki); these rows declare the flows it runs.
    "change.landed": {
      flow: ["coding/wiki", "improve.mine"],
      description: "Refresh the wiki, mine the landing"
    },
    "github.push:main": {
      flow: "coding/wiki",
      description: "Refresh the wiki after outside merges"
    },
    "schedule:0 9 * * 1-5": { flow: "review", description: "Weekday morning review of main" },
    "schedule:0 2 * * *": { flow: "security-audit", description: "Audit security nightly" },
    "box.session.ended": {
      flow: "improve.mine",
      description: "Mine every landing and box session for a better factory"
    },
    "schedule:0 10 * * 1": {
      flow: "improve.suggest",
      description: "Suggest factory improvements once a week; every one needs your approval"
    }
  },
  // For now GitHub writes main: a Change opens a GitHub pull request that a
  // maintainer merges there, Smithers Cloud follows GitHub's main, and issues
  // move both ways. Returns to `mirror: "push", changes: "land"` (RULINGS 23)
  // once landing on Smithers Cloud is proven (flows/coding/finalization.md).
  // Only the maintainer's todo and automerge labels count; no todoSince, so
  // an issue is a TODO only when a maintainer labels it (agents file GitHub
  // issues under the maintainer's account). The factory's lanes spend at
  // most dailyTokens a day.
  github: S.Github.Policy({
    mirror: "pull",
    issues: "two-way",
    changes: "send-upstream",
    maintainers: ["roninjin10"],
    dailyTokens: 2_000_000_000
  })
})

// --- homepage --------------------------------------------------------------
// The app home (PRODUCT.md D-18): one question, the composer, and the apps.
// An app is a featured flow with a picture; opening one renders that flow's
// form, then the run card. Other repositories declare their own.
export const home = S.Factory.Home({
  blocks: [
    S.Home.Prompt({ title: "What should we work on?", placeholder: "Ask Smithers…" }),
    S.Home.App({ flow: "issue.implement", title: "Fix an issue", picture: "issue" }),
    S.Home.App({ flow: "prs.triage", title: "Review a PR", picture: "review" }),
    S.Home.App({ flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" }),
    S.Home.App({ flow: "triggers.register", title: "Run it every night", picture: "schedule" })
  ]
})
// --- end homepage ----------------------------------------------------------
