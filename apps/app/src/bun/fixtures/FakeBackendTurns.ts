import type { CloudKeychain } from "../CloudAuth"

/** A keychain already holding a signed-in Cloud login, so a hybrid host's agent sends turns as that user. */
export const signedInKeychain = (): CloudKeychain => {
  let value: string | null = JSON.stringify({ token: "backend-test-token", username: "test", email: null, expiresAt: "2099-01-01T00:00:00Z" })
  return { read: async () => value, write: async (_service, _account, next) => { value = next }, remove: async () => { value = null } }
}
