// History writes/readback still need real-host receipts: https://github.com/smithersai/smithers/issues/1921.
// The Stack card these specs drove was deleted with the Home mount; the stack's real-host spec follows the `home` topic.
export const history = [
  "history.bootstrap", "history.land", "history.parallel", "history.show", "history.todo",
] as const
