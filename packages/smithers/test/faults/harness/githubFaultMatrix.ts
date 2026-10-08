// C-DUR-03's literal acceptance case identities. Keep the supplemental fault
// cases mandatory in the runner as well as in the production Go harness.
const stages = ["before-send", "potentially-sent", "remote-success"] as const
export const githubCrossings = [
  ...["push", "open", "body", "merge", "close"].flatMap(kind => stages.map(stage => `${kind}/${stage}`)),
  "open-drop/remote-success",
  "body-order/remote-success",
  "push-foreign/potentially-sent",
  "close-reopen/remote-success",
  ...["revoked", "stale-head", "missing-approval", "competing-fence"].flatMap(refusal => stages.map(stage => `merge-${refusal}/${stage}`)),
  ...["person", "other-app", "canonical"].flatMap(identity => [
    `close-${identity}-event/potentially-sent`,
    `close-${identity}-marker/potentially-sent`,
  ]),
]
export const githubPoints = githubCrossings.map(crossing => `github-${crossing.replace("/", "-")}`)
