---
title: "Catalog rules"
description: "Every rule in the @smthrs/targets catalog, with the verbs it joins, whether its result may be replayed from the cache, whether it declares an output tree, and which route executes it."
---

Every rule this package declares, with the verbs it participates in, whether
its results may be replayed from the cache, whether it declares an output tree,
and which route executes it.

The route matters when you trace a failure. A `flow body` rule plans its own
work through the shared `Exec` action, so a Flow runtime alone can run it. A
`package executor` rule plans `Target.notImplemented` when explicitly lowered with `Target.plan` and is
dispatched natively by [`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli), so running one
under a bare Flow runtime fails loudly instead of doing nothing.

**Unsupported in this release candidate:** `Npm.Publish`, `Changesets.Publish`,
`Github.Release`, `Github.Pages`, `Git.Pr`, and `Github.Pr` have no outward
transport. The plan refuses each one as `not implemented by this executor`, so
`run` fails before any gate or effect. The plan also refuses `Npm.Downstream`
as `not implemented by this executor` because the isolated remote checkout
runner is not implemented.
Each is deferred past 1.0: `Npm.Publish` and `Changesets.Publish` in [#3163](https://github.com/smithersai/smithers/issues/3163),
`Github.Pr` and `Git.Pr` in [#3164](https://github.com/smithersai/smithers/issues/3164), `Github.Release` and `Github.Pages` in
[#3165](https://github.com/smithersai/smithers/issues/3165), `Npm.Downstream` in [#3166](https://github.com/smithersai/smithers/issues/3166). Their declarations remain available for planning; they are not working release
or pull-request operations. Use an implemented publication tool or CI job.

| Rule                     | Module            | Verbs              | Cacheable | Declares outputs | Route            |
| ------------------------ | ----------------- | ------------------ | --------- | ---------------- | ---------------- |
| `Agent.Diff`             | AgentTarget       | run                | no        | no               | flow body        |
| `Agent.Lint`             | AgentTarget       | lint               | no        | no               | flow body        |
| `Agent.Pr`               | AgentTarget       | run                | no        | no               | flow body        |
| `Alias`                  | Compose           | mirrors its target | no        | no               | package executor |
| `Anvil.Fork`             | Anvil             | run                | no        | no               | package executor |
| `Api.Compat`             | NodeArtifact      | test               | yes       | no               | package executor |
| `BiomeCheck`             | BiomeCheck        | lint               | no        | no               | flow body        |
| `Bundler.Rspack.build`   | BundlerTarget     | build              | yes       | yes              | flow body        |
| `Bundler.Rspack.resolve` | BundlerTarget     | build              | yes       | no               | flow body        |
| `Cargo.AppSet`           | Cargo             | none               | no        | no               | package executor |
| `Cargo.Build`            | Cargo             | build              | no        | no               | package executor |
| `Cargo.Clippy`           | Cargo             | lint               | no        | no               | package executor |
| `Cargo.Deny`             | Cargo             | lint               | no        | no               | package executor |
| `Cargo.Doc`              | Cargo             | build, docs        | no        | no               | package executor |
| `Cargo.Fetch`            | Cargo             | build              | no        | no               | package executor |
| `Cargo.Fmt`              | Cargo             | lint               | no        | no               | package executor |
| `Cargo.Nextest`          | Cargo             | test               | no        | no               | package executor |
| `Cargo.Test`             | Cargo             | test               | no        | no               | package executor |
| `Changesets.Publish`     | ChangesetsTarget  | run                | no        | no               | unsupported      |
| `Changesets.Version`     | ChangesetsTarget  | run, lint          | by attrs  | no               | package executor |
| `CloudRun.Preview`       | CloudRun          | run                | no        | no               | package executor |
| `Clean`                  | Compose           | run                | no        | no               | package executor |
| `Copy`                   | NodeArtifact      | build              | yes       | no               | package executor |
| `Cron`                   | CronTarget        | run                | no        | no               | package executor |
| `DepsLint`               | DepsLint          | lint               | no        | no               | flow body        |
| `Dev`                    | Dev               | run                | no        | no               | flow body        |
| `Docker.Bake`            | Docker            | build              | yes       | yes              | package executor |
| `Docker.Build`           | Docker            | build              | yes       | yes              | package executor |
| `Docker.Push`            | Docker            | run                | no        | no               | package executor |
| `Docker.Serve`           | Docker            | run                | no        | no               | package executor |
| `Docker.Service`         | Docker            | run                | no        | no               | package executor |
| `Docs.Check`             | DocsCheck         | lint, docs         | yes       | no               | package executor |
| `Docs.Page`              | DocsPage          | docs               | no        | no               | flow body        |
| `DocsParity`             | DocsParity        | docs               | yes       | no               | flow body        |
| `Dprint`                 | Dprint            | lint               | no        | no               | flow body        |
| `DtsBuild`               | DtsBuild          | build              | no        | yes              | flow body        |
| `EsLint`                 | EsLint            | lint               | no        | no               | flow body        |
| `FactoryProjection`      | Factory           | build, lint        | by attrs  | by attrs         | flow body        |
| `Fetch`                  | Fetch             | build              | no        | yes              | package executor |
| `Filegroup`              | Filegroup         | none               | yes       | no               | flow body        |
| `Foundry.Build`          | Foundry           | build              | yes       | yes              | flow body        |
| `Foundry.Fmt`            | Foundry           | lint, run          | by attrs  | no               | flow body        |
| `Foundry.Test`           | Foundry           | test               | yes       | no               | flow body        |
| `Generate`               | Compose           | run, lint          | no        | no               | flow body        |
| `Git.Commit`             | GitTarget         | run                | no        | no               | package executor |
| `Git.Pr`                 | GitTarget         | run                | no        | no               | unsupported      |
| `Git.Submodule`          | GitTarget         | build              | yes       | no               | package executor |
| `Git.Submodules`         | GitTarget         | build              | yes       | no               | package executor |
| `Github.Ci`              | GithubTarget      | run, lint          | no        | no               | package executor |
| `Github.CiGen`           | GithubTarget      | run, lint          | no        | no               | package executor |
| `Github.Pages`           | GithubTarget      | run                | no        | no               | unsupported      |
| `Github.Pr`              | GithubTarget      | run                | no        | no               | unsupported      |
| `Github.Release`         | GithubTarget      | run                | no        | no               | unsupported      |
| `Github.Setup`           | GithubTarget      | run, lint          | no        | no               | package executor |
| `Github.Workflow`        | GithubTarget      | run, lint          | no        | no               | package executor |
| `GithubCiGen`            | GithubCiGen       | build, lint        | by attrs  | no               | flow body        |
| `Go.Binary`              | Go                | build              | no        | no               | package executor |
| `Go.Fuzz`                | Go                | test               | no        | no               | package executor |
| `Go.Generate`            | Go                | lint, run          | no        | no               | package executor |
| `Go.Lint`                | Go                | lint               | no        | no               | package executor |
| `Go.ModDownload`         | Go                | build              | no        | no               | package executor |
| `Go.Packages`            | Go                | build              | no        | no               | package executor |
| `Go.Test`                | Go                | test               | no        | no               | package executor |
| `ImportClosure`          | Compose           | build              | no        | no               | flow body        |
| `Install`                | Install           | run                | no        | no               | flow body        |
| `JsrPublish`             | JsrPublish        | run                | no        | no               | flow body        |
| `Literal`                | NodeArtifact      | build              | yes       | no               | package executor |
| `LlmLint`                | LlmLint           | review             | no        | no               | flow body        |
| `Lockfile`               | Lockfile          | build              | no        | yes              | flow body        |
| `Markdown.CodeBlocks`    | NodeArtifact      | build, test        | yes       | no               | package executor |
| `Materialize`            | Compose           | run                | no        | no               | package executor |
| `Memory.Retain`          | MemoryTarget      | run                | no        | no               | package executor |
| `NewPackage`             | NewPackage        | run                | no        | no               | flow body        |
| `NodeBinary`             | NodeBinary        | build              | no        | no               | flow body        |
| `NodeTest`               | NodeTest          | test               | by attrs  | no               | flow body        |
| `Npm.Downstream`         | NpmTarget         | test               | yes       | no               | unsupported      |
| `Npm.Pack`               | NpmTarget         | build              | yes       | no               | package executor |
| `Npm.Publish`            | NpmTarget         | run                | no        | no               | unsupported      |
| `Npm.Published`          | NpmTarget         | build              | yes       | no               | package executor |
| `NpmPublish`             | NpmPublish        | run                | no        | no               | flow body        |
| `Overlay`                | NodeArtifact      | build              | yes       | no               | package executor |
| `Owners.Codeowners`      | Owners            | build, lint        | no        | no               | package executor |
| `Owners.Tree`            | Owners            | build, lint        | no        | no               | package executor |
| `PackageJsonCheck`       | PackageJson       | lint               | yes       | no               | flow body        |
| `PackageJsonWrite`       | PackageJson       | run                | no        | no               | flow body        |
| `PackageLint`            | PackageLint       | lint               | no        | no               | flow body        |
| `PnpmWorkspace`          | PnpmWorkspaceFile | build, lint        | no        | yes              | flow body        |
| `Shell.Build`            | Shell             | build              | no        | no               | flow body        |
| `Shell.Diff`             | Shell             | run, lint          | no        | no               | flow body        |
| `Shell.Run`              | Shell             | run                | no        | no               | flow body        |
| `Shell.Serve`            | Shell             | run                | no        | no               | package executor |
| `Shell.Test`             | Shell             | test               | no        | no               | flow body        |
| `Size.Budgets`           | NodeArtifact      | test               | yes       | no               | package executor |
| `SortPackageJson`        | SortPackageJson   | build, lint        | no        | yes              | flow body        |
| `Suite`                  | Compose           | test               | no        | no               | package executor |
| `TargetIndex`            | TargetIndex       | build, lint        | by attrs  | by attrs         | flow body        |
| `Test`                   | Compose           | test               | no        | no               | flow body        |
| `ToolBuild`              | ToolBuild         | build              | by attrs  | yes              | flow body        |
| `ToolRun`                | ToolRun           | run                | no        | no               | flow body        |
| `TsBuild`                | TsBuild           | build              | no        | yes              | flow body        |
| `Tsconfig`               | Tsconfig          | build, lint        | no        | yes              | flow body        |
| `Typecheck`              | Typecheck         | build              | no        | no               | flow body        |
| `TypedocDocs`            | TypedocDocs       | build              | no        | yes              | flow body        |
| `Vitest`                 | Vitest            | test               | no        | no               | flow body        |
| `VitestCoverage`         | VitestCoverage    | test               | no        | yes              | flow body        |
| `VitestWatch`            | VitestWatch       | run                | no        | no               | flow body        |

105 rules.

`PnpmWorkspace` declares `packages`, `allowBuilds`, and `linkWorkspacePackages`
directly. Its `settings` field refuses those names so the generated YAML has
one value for each key.

## Cloud Run previews

`CloudRun.Preview` is outward, uncached, and always manual: only an explicit
label runs it. See [the preview API](./api.md#cloud-run-previews) for attributes,
bootstrap, refusal codes, and the versioned receipt. It uses the runner's
`gcloud` login with service-account impersonation, rather than `HttpSecret`.
