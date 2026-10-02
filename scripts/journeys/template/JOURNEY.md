# Fixed journey inputs

Code question (J1): "Where do failed deliveries get retried? Show the file."

First TODO (J1): "Extend retry.ts so retry(operation, attempts = 3) retries a failed operation up to attempts times and returns the first success. Preserve the final error if all attempts fail. Reject attempts less than 1. Add tests for success, exhausted retries and invalid attempts. Update CHANGELOG.md."

Question TODO (J2): "Add exponential backoff to retry.ts. Ask the team which base delay to use before implementing it."

Answer (J2/J3): "Use the existing retry helper with a base delay of 100 ms."

Factory edit (J5): "Every TODO must run pnpm test and update the changelog."

Wiki page: `retry-policy`.

Wiki decision (J8): "Webhook retries must use retry() with exponential backoff and a base delay of 100 ms. Do not add a second retry loop. Inject the wait function so unit tests do not sleep."

Related TODO (J8): "Add deliverWebhook() using our retry policy. Cite the exact retry-policy page revision in the plan and cover a transient failure with a test."

Review comment (J10): "Add a regression test for the final error after retries are exhausted."

The template has no Smithers declarations or third-party dependencies. Keep all prompts identical between themes. Do not seed an answer or use a scripted model.
