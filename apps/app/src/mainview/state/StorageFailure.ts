import { isPrivacyRetirementError, type PrivacyRetirementError } from "../chain/PrivacyRetirement"
import { StorageWriteFailedError, type WriterMovedToAnotherTabError } from "./StorageRecoveryContract"

export type StoreFailure = PrivacyRetirementError | StorageWriteFailedError

// A fenced document cannot publish its failure through the durable store.
// This content-free host signal replaces its UI with the recovery surface.
let failure: StoreFailure | WriterMovedToAnotherTabError | undefined
const listeners = new Set<() => void>()
export const storageFailure = () => failure
export const subscribeStorageFailure = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const reportStorageFailure = (reason: NonNullable<typeof failure>): void => {
  if (failure === undefined || (failure instanceof StorageWriteFailedError && isPrivacyRetirementError(reason))) failure = reason
  for (const listener of listeners) listener()
}
