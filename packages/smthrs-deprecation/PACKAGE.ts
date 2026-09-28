import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smthrs-deprecation"

const standard = BuildAndCheckTypeScriptPackage({ cwd })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = standard

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "bin/**", "scripts/**", "package.json"],
  checks: [
    {
      id: "bin-runs-pinned-cli",
      title: "The smthrs and smithers bins execute only the pinned @smthrs/cli entry",
      threat:
        "Anyone who can place a file in the caller's working directory or environment makes `npx smthrs` run their code with the user's privileges.",
      lookFor: [
        "A bin import target resolved from process.cwd(), argv, or an env var instead of import.meta.resolve of the package's own @smthrs/cli dependency.",
        "A @smthrs/cli dependency range in package.json that is not the exact synchronized release version, so a later or squatted version installs.",
        "A new bin name in package.json that shadows an unrelated system or third-party executable on PATH."
      ],
      paths: ["bin/**", "package.json"]
    },
    {
      id: "no-install-time-code",
      title: "Installing or importing smthrs runs no code beyond throwing the notice",
      threat:
        "A compromised maintainer or build step makes every `npm install smthrs` run code on developer machines and CI runners.",
      lookFor: [
        "A preinstall, install, postinstall, or prepare script added to package.json.",
        "Any statement in src/index.ts other than building the constant notice string and throwing it: a network call, fs access, env read, or dynamic import."
      ],
      paths: ["src/**", "package.json"]
    },
    {
      id: "published-files-allowlist",
      title: "The npm tarball ships only the bin, the notice source, and its built output",
      threat:
        "Anyone who downloads the public package reads a maintainer's tokens, local paths, or unreleased code swept in by a broad files glob.",
      lookFor: [
        "A package.json files entry wider than bin/**/*.mjs, src/**/*.ts, dist/**, LICENSE, README.md, and CHANGELOG.md, such as a bare directory or '**'.",
        "publishConfig losing provenance: true or tag: next, so a publish is unattested or becomes the default latest install."
      ],
      paths: ["package.json", "scripts/**"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
