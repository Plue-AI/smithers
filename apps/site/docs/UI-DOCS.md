# Maintaining the app docs

The app is the default path at `/docs/` and `/docs/quickstart/`. Task guides
live in `src/content/docs/docs/learn/`, one page per job with GUI, TUI, CLI,
and API tabs (`<Tabs syncKey="surface">`). `app/index.mdx` is only a short
tour of the interface. TUI references live in `docs/tui/`. The original terminal quickstart is
at `/docs/cli-quickstart/`, and `/docs/developers/` holds the generated CLI
entry point and package support policy.

The structure follows the task-based progression in
[Cursor's quickstart](https://cursor.com/docs/get-started/quickstart): open
the application, get a useful result, inspect it, then expand into more
features. Keep instructions tied to actual UI labels and expected results.
Separate task guides from technical reference.

## Product words

User guides, the quickstart, the overview, and visible UI labels use the
words a user sees: Chat or conversation, issue, flow, run, change, review
comment, wiki, and request. Internal model terms such as thread, task,
`HumanTask`, principal, grant set, and charter leak how Smithers models
things; use them only on pages deliberately about implementation (reference,
concepts, package and API docs) and in type or module names. For example, the
concept page on memory threads and `smthrs memory threads` keep the word.

## Product facts

Check owning UI source and the deployed app before changing a claim. The
September 7, 2026 product direction describes a free private alpha for selected
public repositories. Paid contributor seats and multiplayer boxes are planned;
no paid rates or usage allowances are published here.

`src/content/docs/docs/pricing.mdx` is the shared pricing source. Both the
Starlight docs and `src/pages/pricing.astro` render it. Do not add a second
pricing table with independently maintained terms.

The public Dispatcher shows declared rules, not proof of active event
listeners. Wiki notes are distinct from a generated repository wiki. History
can be empty. The Account and Secrets cards do not provide editors or billing
controls. Preserve those distinctions when the implementation changes.

## Screenshots

Run these commands from `apps/site` with the repository dependencies installed:

```sh
node scripts/capture-ui-docs.mjs
```

This uses Chromium from the UI package and a fresh signed-out context for each
screen. It visits the public Smithers repository, opens read-only views, and
saves PNGs to `public/images/app/`. It does not log in or submit writes. Pass
screen names, such as `file factory`, to refresh a subset. Captures fail when
their expected controls disappear; update the guide and capture together.

The four `*-example.png` images render the actual local app using the existing
browser-test server fixtures for runs, changes, and boxes. They do not show a
production account or completed production work. Every caption identifies
example data. To refresh them:

```sh
pnpm exec astro dev --host 127.0.0.1 --port 4325
node scripts/capture-ui-examples.mjs
```

The example script requires a loopback origin, intercepts API requests, and
blocks external requests. Do not point it at production or relabel its output
as a live capture. `captures.json` records provenance, dimensions, and capture
dates for both kinds of image. The `AppScreenshot` component uses those
dimensions and provides a keyboard-accessible full-size image link.

Review every image before publishing it. Keep real account details, private
source, credentials, and nonpublic project activity out of screenshots. Do not
replace product screenshots with generated mockups.

## Tutorial captures

The tutorials under `src/content/docs/docs/learn/` show GUI and TUI captures
from `public/images/learn/`. Re-capture them all with one command:

```sh
pnpm --filter smithers-app run build:web
pnpm --filter @smithers/site run capture:learn
```

`app-*` images come from the real app server and built SPA, offline, with a
scripted model reply (`scripts/journeys/app-host.mjs`). `tui-*` images come
from the TUI docs recorder, which drives the production TUI with deterministic
replies. `preview-*` images are design previews of unreleased screens rendered
from fixture data; use them only beside a Planned or Partly available marker,
captioned as a preview, and replace them once the screen ships
(`capture:learn previews <dir>`). `captures.json` records each image's source
and revision. The journeys live in `scripts/journeys/journeys.mjs`. Where no
real capture exists yet, a page carries a `:::note[Capture needed]` naming the
capture and what it waits on.

## Verify a docs change

From the repository root:

```sh
node apps/site/scripts/generate-project-copy.mjs
node apps/site/scripts/generate-llms.mjs
pnpm --filter @smithers/site run check:docs
pnpm --filter @smithers/site run check
pnpm --filter @smithers/site run build
```

Preview the built site on desktop and mobile. Check navigation, screenshots,
full-size links, pricing tables, and search. App pages use the private-alpha
notice; developer pages retain the package release notice. The LLM export
includes the app guides and screenshot captions.

The September 7 capture session verified the public app's home, guide-file
reading and maximize, Wiki, Dispatcher, History, Account sign-in prompt, slash
discovery, search help, and Factory card. Signed-in controls were inspected
in source and the local fixture-backed application. That does not establish
production acceptance of an authenticated flow, box, or landing.
