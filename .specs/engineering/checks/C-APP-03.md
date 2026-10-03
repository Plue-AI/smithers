# C-APP-03 Add to machine image from Settings and from a failed step

Proves: spec.md §8.6.1, §8.6.2, §14.3 (Settings; TODO failure) · mvp.md M-29, §6.1 Machine image without declarations · Layer: e2e · Stage: S1 · Tickets: T-APP-02, T-APP-03, T-MCH-10
Automation: `apps/app/e2e/real/machine-image.spec.ts` (new) · Runs in: reference host

## Setup
- Scratch repository with `.smithers/machine.json` `{"packages": ["jq"]}` and a check script that runs `figlet ok`. The base image has no `figlet`.
- Maya (owner) and Ben (member) signed in.

## Steps
1. Ben makes T1. Its check step fails because `figlet` is missing.
2. Ben opens `/todo T1` and presses **Add to machine image** on the failure.
3. Ben discards that Draft. Maya opens `/settings` and enters `Fig Let` in Add to machine image, then `figlet`.
4. Maya commits the Draft as T2 and merges T2.
5. Ben retries T1.
- Invoke mounted S1 `GET /api/branches/{b}/files/{path}`, including `main:.smithers/machine.json`, with literal bytes and absent-file status.

## Pass when
- Step 1: T1's failure names `figlet` and `.smithers/machine.json`, with class `user`.
- Step 2: a private Draft opens for Ben, titled "Add figlet to the machine image", with a read-only seed that changes only `.smithers/machine.json`, to `{"packages": ["jq", "figlet"]}`. Maya's browser shows nothing.
- Step 3: `Fig Let` is refused in the field with the name rule's reason, and no Draft opens. `figlet` opens the same Draft for Maya.
- Step 4: T2's PR diff is exactly that change. After the merge, the machine recipe digest for `main` differs from the one before.
- Step 5: T1's retry passes its check on a machine built from the new recipe.
- The mounted file route returns the literal bytes and absent-file status. It neither wakes a machine nor executes repository code.

## Fail when
- The seed drops or reorders existing packages, or touches another file.
- A refused name opens a Draft or makes a TODO.
- The control appears on the Terminal card (T-APP-12 excludes it).

## Evidence
`.artifacts/checks/C-APP-03/<UTC timestamp>/`: the videos, the Draft's seed diff, T2's PR diff, the recipe digests before and after, T1's check logs, the commit and install version.
