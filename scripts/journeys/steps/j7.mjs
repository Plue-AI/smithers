import { journey } from "./define.mjs"
export default journey("J7", "Plan and fork", [
  ["placement", "C-J7-01", "Insert before T3 and amend T2's prompt; T2 shows +1 with no second TODO. Record exact stack ordering and prompt revision."],
  ["fork", "C-J7-02", "Fork T2's captured revision into scratch, edit by hand, Add to stack after T2, then drop T2. The new item retains the entire scratch change including T2's work; source machine remains running."],
  ["rebase", "C-J7-03", "Move main with a real unrelated canary PR. Record conflict resolution once, or Needs you with Resolve if it cannot resolve. Verify presence holds and approvals/checks reset on new heads."]
])
