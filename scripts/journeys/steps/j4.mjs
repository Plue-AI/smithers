import { journey } from "./define.mjs"
export default journey("J4", "The team's work", [
  ["home", "C-J4-01", "Seed states through the live product; Home shows exact counts, state filters, merged since last look, sync time and awake machines versus detected capacity. Record matching projections."],
  ["actions", "C-J4-02", "Answer one question, review and merge next, move a ready TODO above a stuck one, retry a failure with a steer. Keep Chat usable while launch and remote execution remain pending; toasts settle only on terminal events."],
  ["order", "C-J4-03", "Verify only the next stack item can merge; later items show Merges after Tn. Record disabled and server-refused out-of-order attempts."]
])
