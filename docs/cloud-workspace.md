# Cloud development

Open this repository in Smithers, select its cloud workspace, and request one focused change in Chat. Track actionable work in a GitHub issue. Inspect the run's result and checks, and use **History** (`/history.show smithersai/smithers`) to follow the repository's issue lanes and pull requests.

The stack service alone writes the repository's linear `mythical` stack. For this send-upstream repository, work reaches append-only `main` through a GitHub pull request merged by the owner, with one commit per stack item. Never push to `mythical` by hand or rewrite `main`.

Cloud runs the coding factory and CI/CD. A launch receipt is not completion: verify the terminal run, tested revision, merged commit, and issue write-back. Wiki publication has separate source and review receipts; its remaining refresh work is tracked in [#1923](https://github.com/smithersai/smithers/issues/1923).

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development gates and [the factory](../factory/README.md) for the operating workflow.
