/** Presentation metadata only: importing a button must not initialize the Flow engine. */
export const STORAGE_RECOVERY_EXPORT = "storage.recovery.export"
export const STORAGE_RECOVERY_USER_ONLY_REASON =
  "a raw local recovery download is the human's browser gesture; the agent renders the step with storage.recovery"
export const RECOVERY_DOWNLOAD_LABEL = "Download local recovery file"
export const RECOVERY_PRIVATE_WARNING =
  "Recovery files can include private conversations, authored notes and older account data. Keep the file local; do not share it unredacted."
export const RECOVERY_HUMAN_ONLY =
  "A raw local recovery download requires the human's browser gesture. Render the download step with storage.recovery."

export const STORAGE_RECOVERY_RESET = "storage.recovery.reset"
export const STORAGE_RESET_USER_ONLY_REASON =
  "erasing this browser's saved Smithers data and reloading the page is the human's browser gesture; the agent renders the step with storage.recovery"
export const RECOVERY_RESET_LABEL = "Reset this browser's data"
export const RECOVERY_RESET_CONFIRM_LABEL = "Confirm: erase this browser's data"
/** Shown once the act is armed, so the second press is an informed one. */
export const RECOVERY_RESET_ARMED =
  "This erases this browser's saved Smithers conversation, cards and run history, then reloads. Download the recovery file first if you want to keep it. Press again to reset."
export const RECOVERY_RESET_RUNNING = "Erasing this browser's saved data…"
export const RECOVERY_RESET_HUMAN_ONLY =
  "Erasing this browser's saved data requires the human's browser gesture. Render the reset step with storage.recovery."
/** A page that still owns wa-sqlite's sync access handles cannot remove the files. */
export const RECOVERY_RESET_HELD =
  "This browser's saved data is still open in another Smithers tab, so the reset did not finish. Close the other tabs and try again."

/**
 * The one failure the erase can name precisely. It lives here, with the rest
 * of this act's vocabulary, so the startup panel can recognize it without
 * importing AppStore and initializing the store it is trying to erase.
 */
export class HeldBrowserStorageError extends Error {
  override readonly name = "HeldBrowserStorageError"
  constructor() {
    super(RECOVERY_RESET_HELD)
  }
}
export const RECOVERY_RESET_FAILED =
  "This browser's saved data could not be erased. The reset did not finish; reload and try again."

export class WriterHeldByAnotherTabError extends Error {
  override readonly name = "WriterHeldByAnotherTabError"
  readonly kind = "writer-held" as const
  constructor() {
    super("Smithers is already open in another tab of this browser. Use Smithers here or close that tab and reload.")
  }
}

export class WriterMovedToAnotherTabError extends Error {
  override readonly name = "WriterMovedToAnotherTabError"
  readonly kind = "writer-moved" as const
  constructor() {
    super("Smithers moved to another tab.")
  }
}

export type WriterOwnershipError = WriterHeldByAnotherTabError | WriterMovedToAnotherTabError
export const isWriterOwnershipError = (error: unknown): error is WriterOwnershipError =>
  error instanceof WriterHeldByAnotherTabError || error instanceof WriterMovedToAnotherTabError

/** The runtime writer stopped accepting changes; never carries private SQL or input. */
export class StorageWriteFailedError extends Error {
  override readonly name = "StorageWriteFailedError"
  readonly kind = "write-failed" as const
  constructor() { super("Changes could not be saved.") }
}
