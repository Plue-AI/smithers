// Reviewed bindings for Automation lines that name files rather than argv.
// A present file without a binding is still runner_absent; do not infer argv.
const services = "packages/backend/internal/services"
const compose = "packages/backend/internal/compose"
const ownerFile = `${compose}/owner_signin_integration_test.go`
const ownerTests = [
  "TestOwnerSignInClaimsTheInstallWithTheSetupToken",
  "TestOwnerSignInRefusesAClaimWithoutTheSetupToken",
  "TestOwnerSignInConcurrentClaimsYieldOneOwner",
  "TestOwnerSignInTokenDiesAtTheClaim",
  "TestOwnerSignInNeedsPushOnGitHub",
  "TestOwnerSignInRefusesASecondGitHubUser",
  "TestOwnerSignInClaimsBeforeTheRepositoryIsChosen",
  "TestInstallHasNoLocalPasswordRoutes"
]
const tokenTests = [
  "TestMintSetupTokenStoresOnlyTheDigest",
  "TestMintSetupTokenReplacesTheTokenOnEachStart",
  "TestMintSetupTokenIssuesNothingOnceAnOwnerExists",
  "TestSetupTokenDigestIgnoresSurroundingSpace"
]
const go = (directory, names, files, prerequisites = []) => ({
  argv: ["go", "test", "-json", "-count=1", `./${directory}`, "-run", `^(${names.join("|")})$`],
  files, reporter: "go", expectedCaseIds: names, prerequisites,
  env: prerequisites.includes("PG18") ? { SMITHERS_REQUIRE_DATABASE_TESTS: "1" } : {}
})
const owner = go(compose, ownerTests, [ownerFile], ["PG18"])
// apps/app's suites use bun:test. Do not silently substitute Vitest.
const bundle = {
  argv: ["bun", "test", "./apps/app/scripts/server-bundle.integration.test.ts"],
  files: ["apps/app/scripts/server-bundle.integration.test.ts"], reporter: "bun",
  prerequisites: ["darwin-arm64", "PG18", "msb", "build-budget"],
  env: { SMITHERS_REQUIRE_DATABASE_TESTS: "1", SMITHERS_REQUIRE_MICROVM_TESTS: "1" }
}

// qa-c12: both targets were executed 2026-10-03, but startup reported no named cases.
// Empty IDs must stay gated by C-UI-12's population blocker until real runs supply them.
const viewUnit = {
  argv: ["bun", "test", "src/mainview/cards/views/Views.test.tsx"], cwd: "apps/app",
  files: ["apps/app/src/mainview/cards/views/Views.test.tsx"], reporter: "bun", expectedCaseIds: []
}
const viewBrowser = {
  argv: ["pnpm", "exec", "playwright", "test", "--config", "playwright.config.ts", "e2e/playwright/view-stories.spec.ts", "--reporter=json"],
  cwd: "apps/app", files: ["apps/app/e2e/playwright/view-stories.spec.ts", "apps/app/playwright.config.ts"],
  reporter: "playwright", expectedCaseIds: [], prerequisites: ["build-budget"],
  env: { SMITHERS_VIEW_STORIES: "1", SMITHERS_E2E_BROWSER: "chromium" }
}

export const commandTable = {
  "C-UI-12": {
    commands: [viewUnit, viewBrowser],
    unboundSubcases: [
      { name: "T-PRC-03-population", reason: "Both attempted targets failed before reporting named cases; expectedCaseIds require real execution" },
      { name: "T-UI-02-04-action-removal-and-callbacks", reason: "Setup/Settings/TODO early returns bypass generic action removal; Setup/Settings do not assert other callback silence" },
      { name: "T-UI-02-copy-effect-isolation", reason: "Clipboard fallback cases assert one copy but do not assert absence of setup/key-storage effects" },
      { name: "T-UI-03-full-draft-input", reason: "No Draft View story or full Draft input/callback assertions" },
      { name: "T-UI-11-editor-updates-and-pins", reason: "No identity/scroll/cursor preservation across model updates or approved export/pin receipt assertion" },
      { name: "T-UI-12-monitor-replay-and-custom-slot", reason: "No Monitor story or replay-only callback/custom-slot security assertions" },
      { name: "T-UI-13-agent-draft-opening", reason: "No Agent View story" }
    ],
    subcases: { unit: { commands: [viewUnit] }, playwright: { commands: [viewBrowser] } }
  },
  "C-STK-01": {
    commands: [{
      // C-STK-01 Automation as adopted by the tech lead (2026-10-02 18:45): transitions, projection,
      // item paths and step 5 (lessons). TestTransitionTableIsTheSpec belongs to T-STK-13, not this binding.
      argv: ["go", "test", "-json", "-count=1", `./${services}`, "-run", "^(TestTodoTransition.*|TestProjectItemState.*|TestTodoItemPath.*|TestTodoLearningDone.*)$"],
      files: [`${services}/todo_state_test.go`], reporter: "go",
      expectedCaseIds: [
        "TestTodoTransitionAllowsExactlyTheSpecTable", "TestTodoTransitionRefusesShortcuts", "TestTodoTransitionGuards",
        "TestProjectItemStateMapsEveryItemState", "TestProjectItemStateTerminalStatesWin", "TestProjectItemStateFollowsTheTodosHistory",
        "TestTodoItemPathCrossesOnlySpecEdges", "TestTodoLearningDoneOnlyCountsLessons"
      ]
    }]
  },
  "C-ACC-04": {
    // The owner's boundary is available tonight. Roster coverage belongs to
    // T-ACC-02; its missing runner keeps the full check NOT IMPLEMENTED.
    files: ["packages/backend/internal/compose/signin_gate_integration_test.go"],
    commands: [owner],
    unboundSubcases: ["roster-signin (T-ACC-02)"],
    subcases: { "owner-claim-and-refusals": { files: [ownerFile], commands: [owner] } }
  },
  "C-SEC-04": {
    files: [`${services}/setup_claim_integration_test.go`, bundle.files[0]],
    commands: [owner, bundle],
    unboundSubcases: ["native-startup (T-ACC-07)", "provisional-owner-and-setup-session-refusals (T-ACC-01)"],
    subcases: {
      "setup-claim": { files: [ownerFile], commands: [owner] },
      "setup-token-digests": { commands: [go(services, tokenTests, [`${services}/setup_token_test.go`])] },
      "native-startup": { files: [`${services}/setup_claim_integration_test.go`], commands: [] },
      "packaged-relay": { commands: [bundle] }
    }
  },
  "C-INS-05": { commands: [bundle] }
}

export const commandProvenance = {
  "C-UI-12": "qa-c12 2026-10-03: ran Views.test.tsx with bun from apps/app and view-stories.spec.ts via playwright.config.ts with JSON reporter; both failed before named population; REPORT-qa-c12.md records gaps",
  "C-STK-01": "C-STK-01 Automation/Steps; QA pepper-todo-state.md names TestTodoTransitionAllowsExactlyTheSpecTable",
  "C-ACC-04": "T-ACC-01 Tests; acc lane owner_signin_integration_test.go, read 2026-10-03 UTC; roster stays unbound",
  "C-SEC-04": "acc lane setup_token_test.go and owner_signin_integration_test.go, read 2026-10-03 UTC; native-startup stays unbound",
  "C-INS-05": "T-INS-01 integration file; apps/app bun:test runner contract"
}
