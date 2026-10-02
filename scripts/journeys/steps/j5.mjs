import { journey } from "./define.mjs"
export default journey("J5", "Teach the factory", [
  ["flow", "C-J5-01", "Ask Every TODO must run pnpm test and update the changelog. Review the proposed TODO-flow diff, merge its TODO as a person, and verify Active after load. New runs use the new version; an existing working run keeps its original digest. Kill the backend with SIGKILL mid-step on the reference host; let launchd restart it and retain the recovery receipt proving no completed step re-ran.", { operation: "restart" }],
  ["broken", "C-J5-02", "Merge a deliberately broken flow through a human-reviewed canary TODO; load fails visibly and the prior version stays Active. Fix and retry through the same flow machinery; retain both load receipts."],
  ["learning", "C-J5-03", "A real learning run proposes an improvement with its source evidence. Make TODO, merge it, then verify the next related TODO uses the improvement and passes its check."]
])
