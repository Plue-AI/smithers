import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // House convention (see packages/smithers/flows/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-integrations-coverage-${process.pid}`),
      include: ["src/**"],
      // Ratcheted to exactly what the default gate reaches. Raise these when a
      // case closes; never lower them. The explicit shortfall below is limited
      // to host/runtime boundaries the real suite cannot manufacture safely.
      //
      // The numbers are the exact figures the suite reaches, carrying no
      // slack, so any new uncovered branch fails the gate. Only the three
      // `test/*Live.test.ts` suites change the figures, and only upward: they
      // execute more of `src` when a credential is present, and `include`
      // fixes the denominator whether they run or not.
      //
      // What the remaining shortfall stands for, behavior by behavior:
      //
      // - `core/Channel.ts:68` can only see `Unauthorized`, the declared failure
      //   of `Credential.resolve`; its other arm needs a fake implementation
      //   that violates the service type. `core/Channel.ts:156` is the `map`
      //   placeholder that the returned channel's provider decoder bypasses.
      // - `core/Signature.ts:83` is the catch around Node's permissive
      //   `Buffer.from(value, "base64")`, which does not throw for a string.
      // - `github/GitHubClient.ts:264` is the null fallback for capture group 1
      //   after a regex that requires that group. At `:565`, `Schedule.while`
      //   removes non-retryable failures before `Schedule.addDelay` can see one.
      // - `linear/LinearClient.ts:434` needs Effect to enter `tryPromise` with
      //   an already-aborted signal. Effect stops an already-aborted run before
      //   the callback, and no interrupt can land between the two synchronous
      //   statements once it starts.
      // - `telegram/InitData.ts:267` and `:365` are the two `UNSUPPORTED`
      //   runtime checks. Supported Node has `crypto.subtle` and Ed25519;
      //   deleting either would remove a runtime capability check.
      // - `telegram/TelegramClient.ts:354-355` has the same Effect signal
      //   boundary as Linear.
      //
      // Slack, Google Calendar, Gmail, and X reach every line and branch.
      thresholds: {
        branches: 99.81,
        functions: 99.74,
        lines: 99.88,
        statements: 99.83
      }
    }
  }
})
