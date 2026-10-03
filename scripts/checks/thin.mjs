// Finite QA overlay for G-THIN, validation-plan.md §§2,4,5 (v1.1).
// These are obligation bindings, not invented expected test cases. Each full
// check remains responsible for its own literal oracle and case enumeration.
// The reference-host conflict on activation remains explicit, per §5.
const obligation = (id, check, subcases, ownerTicket, ownerIssue, requiredEnvironment, source) => ({
  id, check, subcases, ownerTicket, ownerIssue, requiredEnvironment, source
})

export const thinObligations = [
  obligation("thin.bundle", "C-INS-05", [], "T-INS-01", 3432, ["darwin-arm64", "PG18", "msb", "built-bundle"], "T-INS-01 Acceptance; G-THIN built-bundle install"),
  obligation("thin.isolation", "C-SEC-02", [], "T-INS-02", 3521, ["reference-host", "PG18", "msb", "built-bundle"], "T-INS-02 Acceptance; G-THIN isolation/no host fallback"),
  obligation("thin.service", "C-INS-06", [], "T-INS-08", 3523, ["reference-host", "msb", "built-bundle"], "T-INS-08 Acceptance; G-THIN install"),
  obligation("thin.signin", "C-ACC-04", ["owner-claim-and-refusals"], "T-ACC-01", 3443, ["PG18"], "T-ACC-01 owns claim/refusal, T-ACC-02 roster is outside this subcase"),
  obligation("thin.claim", "C-SEC-04", ["setup-claim"], "T-ACC-01", 3443, ["PG18"], "T-ACC-01 Acceptance; G-THIN real sign-in"),
  obligation("thin.provisional-owner", "C-SEC-04", ["provisional-owner-and-setup-session-refusals"], "T-ACC-01", 3443, ["PG18"], "C-SEC-04 steps 3–8; real sign-in must not grant product access before verification"),
  obligation("thin.setup-startup", "C-SEC-04", ["native-startup"], "T-ACC-07", 3607, ["PG18", "built-bundle"], "C-SEC-04 step 10; T-INS-02 runtime dependency ACC-07"),
  obligation("thin.setup-relay", "C-SEC-04", ["packaged-relay"], "T-INS-02", 3521, ["darwin-arm64", "PG18", "msb", "built-bundle"], "C-SEC-04 step 11; T-INS-02 packaged setup handoff"),
  obligation("thin.authorizer", "C-ACC-01", [], "T-ACC-03", 3492, ["PG18"], "T-ACC-03 Acceptance; G-THIN real authorizer (later-owned rows cannot pass early)"),
  obligation("thin.state", "C-STK-01", [], "T-STK-01", 3433, [], "T-STK-01 Acceptance; G-THIN honest committed state"),
  obligation("thin.committed-state", "C-UI-05", [], "T-STK-01", 3433, ["PG18", "reference-host", "real-browser"], "T-STK-01 Acceptance; G-THIN honest committed state"),
  obligation("thin.candidate", "C-STK-06", [], "T-STK-12", 3533, ["reference-host", "PG18", "msb", "built-bundle", "jj-helper"], "T-STK-12 Acceptance; G-THIN candidate/tree/inputs and checked PR"),
  obligation("thin.merge-fence", "C-STK-07", [], "T-STK-04", 3529, ["PG18", "jj-helper", "real-flow-host"], "T-STK-04 Acceptance; exact person approval, required-head checks and merge fence"),
  obligation("thin.outbound", "C-GH-09", [], "T-GH-09", 3520, ["PG18"], "T-STK-04 runtime dependency; G-THIN outbound reconciliation"),
  obligation("thin.person-merge", "C-J2-05", ["s1-person-merge"], "T-STK-04", 3529, ["reference-host", "real-browser", "real-GitHub", "built-bundle", "msb"], "T-STK-04 S1 Acceptance; G-THIN person squash-merge (S3 learning excluded)"),
  obligation("thin.journey", "C-J1-04", [], "T-REL-02", 3445, ["reference-host", "second-Mac", "real-browser", "real-GitHub", "built-bundle", "msb", "QA-HOST-ACTIVATION"], "validation-plan §5 thin J1→J2 driver; activation profile awaits 8a ruling")
]

export const thinSourcePaths = [
  ".specs/qa/validation-plan.md", ".specs/engineering/spec.md", ".specs/product/mvp.md",
  ...new Set(thinObligations.map(({ ownerTicket }) => `.specs/engineering/tickets/${ownerTicket}.md`)),
  ...new Set(thinObligations.map(({ check }) => `.specs/engineering/checks/${check}.md`))
]
