// History writes/readback still need real-host receipts: https://github.com/smithersai/smithers/issues/1921.
export const history = [
  "history.bootstrap", "history.backfill", "history.parallel", "history.retry",
  "history.show", "history.todo",
] as const
