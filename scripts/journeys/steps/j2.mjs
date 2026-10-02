import { journey } from "./define.mjs"
export default journey("J2", "Issue to merged PR", [
  ["issue", "C-J2-01", "A teammate opens and discusses a real canary issue. Make TODO, edit the draft, place and commit it; retain frozen source revision, GitHub label/comment and created TODO."],
  ["label", "C-J2-02", "Label another issue todo, then edit it and repeat delivery. Verify one appended TODO with the original title/body. Send the same mutating command twice with one Idempotency-Key, then double-activate its button: original result and one durable launch. Retain request/result IDs and projection receipts.", { operation: "duplicate-launch" }],
  ["answer", "C-J2-03", "Wait for a real agent question, verify Needs you and owner/branch toasts; two members answer it, with only the first settling it and its author shown. Record event ordering while Chat remains usable."],
  ["evidence", "C-J2-04", "Open the PR evidence: diff, executed machine checks, GitHub checks and agent review summary, bound to the current head. A launch receipt alone must not settle progress."],
  ["merge", "C-J2-05", "A person merges in the app. Verify Merged follows GitHub confirmation, a fixes issue closes with its link, a non-fixes issue stays open, and a real learning run completion receipt follows."]
])
