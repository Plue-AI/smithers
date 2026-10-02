# Cloud sign-in browser tests

`CloudAuthFragment.test.ts` exercises the retained local host sign-in callback
with real loopback HTTP fixtures and Chromium. Run `pnpm --filter smithers-app
test:e2e:auth`. Native application tests were retired in smithers#3387.
