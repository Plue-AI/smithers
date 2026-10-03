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

export const commandTable = {
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
  "C-STK-01": "C-STK-01 Automation/Steps; QA pepper-todo-state.md names TestTodoTransitionAllowsExactlyTheSpecTable",
  "C-ACC-04": "T-ACC-01 Tests; acc lane owner_signin_integration_test.go, read 2026-10-03 UTC; roster stays unbound",
  "C-SEC-04": "acc lane setup_token_test.go and owner_signin_integration_test.go, read 2026-10-03 UTC; native-startup stays unbound",
  "C-INS-05": "T-INS-01 integration file; apps/app bun:test runner contract"
}
