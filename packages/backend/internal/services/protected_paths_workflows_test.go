package services

import (
	"context"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

// mapRevisionTree is a revision held in memory.
type mapRevisionTree map[string]string

func (t mapRevisionTree) read(_ context.Context, file string) ([]byte, bool, error) {
	content, found := t[file]
	return []byte(content), found, nil
}

func (t mapRevisionTree) files(_ context.Context, dir string) ([]string, error) {
	var files []string
	for file := range t {
		if strings.HasPrefix(file, dir+"/") {
			files = append(files, file)
		}
	}
	sort.Strings(files)
	return files, nil
}

// checkoutRevisionTree is this repository's working tree.
type checkoutRevisionTree string

func (root checkoutRevisionTree) read(_ context.Context, file string) ([]byte, bool, error) {
	info, err := os.Stat(filepath.Join(string(root), file))
	if os.IsNotExist(err) || (err == nil && !info.Mode().IsRegular()) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	content, err := os.ReadFile(filepath.Join(string(root), file))
	return content, err == nil, err
}

func (root checkoutRevisionTree) files(_ context.Context, dir string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(filepath.Join(string(root), dir), func(file string, entry os.DirEntry, err error) error {
		if os.IsNotExist(err) {
			return filepath.SkipDir
		}
		if err != nil {
			return err
		}
		if entry.IsDir() && entry.Name() == "node_modules" {
			return filepath.SkipDir
		}
		if entry.Type().IsRegular() {
			rel, err := filepath.Rel(string(root), file)
			files = append(files, filepath.ToSlash(rel))
			return err
		}
		return nil
	})
	return files, err
}

func repositoryRoot(t *testing.T) checkoutRevisionTree {
	t.Helper()
	dir, err := os.Getwd()
	require.NoError(t, err)
	for {
		if _, err := os.Stat(filepath.Join(dir, workflowsDir)); err == nil {
			return checkoutRevisionTree(dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("no .github/workflows above the test directory")
		}
		dir = parent
	}
}

var workflowTrustFixture = mapRevisionTree{
	".github/workflows/review.yml": `
on: pull_request
permissions:
  id-token: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: ./tools/review
      - uses: someone/this-repo/tools/published@main
      - uses: someone/else/not/here@v1
      - run: bash scripts/deploy.sh "$TARGET" && node ./scripts/missing.mjs
      - uses: ./apps/x/action
      - run: bash "$GITHUB_WORKSPACE/scripts/ws.sh" && bash ${{ github.workspace }}/scripts/ws2.sh
`,
	".github/workflows/lint.yml": `
on: [push, pull_request]
permissions:
  contents: read
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ./tools/readonly
      - run: bash scripts/unprivileged.sh
  secret:
    runs-on: ubuntu-latest
    steps:
      - run: bun scripts/probe.ts
        working-directory: tools
        env:
          TOKEN: ${{ secrets.TOKEN }}
  defaulted:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: tools
    env:
      ALL: ${{ toJSON(secrets) }}
    steps:
      - run: bash ./defaulted.sh
`,
	"tools/review/action.yml": `
runs:
  using: composite
  steps:
    - uses: ./tools/inner
    - shell: bash
      run: bun "${{ github.action_path }}/src/main.ts"
`,
	"tools/review/src/main.ts": `import { helper } from "../../../lib/helper.ts";
import { run } from "@scope/pkg";
const lazy = await import("./lazy.js");`,
	"tools/review/src/lazy.ts":   `export {};`,
	"lib/helper.ts":              `export * from "./deep.js";`,
	"lib/deep.ts":                `export const deep = 1;`,
	"lib/other.ts":               `export {};`,
	"tools/inner/action.yml":     "runs:\n  using: node24\n  main: index.js\n",
	"tools/inner/index.js":       `require("./util")`,
	"tools/inner/util.js":        ``,
	"tools/published/action.yml": "runs:\n  using: node24\n  main: index.js\n",
	"tools/readonly/action.yml":  "runs:\n  using: node24\n  main: index.js\n",
	"tools/scripts/probe.ts":     `import "../../lib/other.ts";`,
	"scripts/deploy.sh":          "#!/bin/sh\n",
	"scripts/ws.sh":              "#!/bin/sh\n",
	"scripts/ws2.sh":             "#!/bin/sh\n",
	"tools/defaulted.sh":         "#!/bin/sh\n",
	"apps/x/package.json":        "{}",
	"apps/x/action/action.yml":   "runs:\n  using: node24\n  main: ../dist/index.js\n",
	"apps/x/dist/index.js":       "",
	"scripts/unprivileged.sh":    "#!/bin/sh\n",
}

// Every local action a workflow uses, transitively, and every script a job
// with elevated trust runs, with the files those import, is protected.
func TestWorkflowTrustPathsDeriveFromWorkflows(t *testing.T) {
	derived, err := workflowTrustPaths(context.Background(), workflowTrustFixture)
	require.NoError(t, err)
	assert.Equal(t, []string{
		"/apps/x",
		"/apps/x/action",
		"/apps/x/dist/index.js",
		"/lib/deep.ts",
		"/lib/helper.ts",
		"/lib/other.ts",
		"/scripts/deploy.sh",
		"/scripts/ws.sh",
		"/scripts/ws2.sh",
		"/tools/defaulted.sh",
		"/tools/inner",
		"/tools/inner/index.js",
		"/tools/inner/util.js",
		"/tools/published",
		"/tools/published/index.js",
		"/tools/readonly",
		"/tools/readonly/index.js",
		"/tools/review",
		"/tools/review/src/lazy.ts",
		"/tools/review/src/main.ts",
		"/tools/scripts/probe.ts",
	}, derived)

	entries, err := protectedPathsAt(context.Background(), workflowTrustFixture)
	require.NoError(t, err)
	assert.Equal(t, []string{"lib/helper.ts", "tools/inner/index.js", "tools/review/action.yml"}, protectedPathsTouched([]string{
		"tools/inner/index.js", "lib/helper.ts", "lib/unrelated.ts", "scripts/unprivileged.sh",
		"tools/review/action.yml", "vendor/tools/review/action.yml", "tools/reviewer/a.ts",
	}, entries), "derived entries are root-relative")
}

func TestWorkflowTrustPathsRefuseAnUnreadableWorkflow(t *testing.T) {
	_, err := workflowTrustPaths(context.Background(), mapRevisionTree{".github/workflows/bad.yml": "jobs: [\n"})
	require.ErrorContains(t, err, ".github/workflows/bad.yml does not parse")
	_, err = workflowTrustPaths(context.Background(), mapRevisionTree{
		".github/workflows/ok.yml": "jobs:\n  a:\n    steps:\n      - uses: ./act\n",
		"act/action.yml":           "runs: [\n",
	})
	require.ErrorContains(t, err, "act/action.yml does not parse")
	derived, err := workflowTrustPaths(context.Background(), mapRevisionTree{})
	require.NoError(t, err)
	assert.Empty(t, derived)
}

// A privileged local action and its import closure remain protected even when
// the product has no standalone review action.
func TestWorkflowTrustPathsProtectPrivilegedLocalAction(t *testing.T) {
	fixture := mapRevisionTree{}
	for file, content := range workspaceFixture {
		fixture[file] = content
	}
	fixture["tools/act/action/index.js"] = `import "../helpers/run.js"`
	fixture["tools/act/helpers/run.js"] = `import "./policy.js"`
	fixture["tools/act/helpers/policy.js"] = ""
	derived, err := workflowTrustPaths(context.Background(), fixture)
	require.NoError(t, err)
	for _, want := range []string{"/tools/act", "/tools/act/action", "/tools/act/action/index.js", "/tools/act/helpers/run.js", "/tools/act/helpers/policy.js"} {
		assert.Contains(t, derived, want)
	}
	entries, err := protectedPathsAt(context.Background(), fixture)
	require.NoError(t, err)
	assert.Equal(t, []string{"tools/act/action/action.yml", "tools/act/helpers/run.js"},
		protectedPathsTouched([]string{"tools/act/action/action.yml", "tools/act/helpers/run.js", "apps/site/README.md"}, entries))
}

// Workspace dependencies and root install inputs retain the same trust fence.
func TestProtectedPathsFollowPrivilegedActionsWorkspaceDependencies(t *testing.T) {
	entries, err := protectedPathsAt(context.Background(), workspaceFixture)
	require.NoError(t, err)
	assert.Equal(t, []string{"package.json", "packages/lib-a/src/index.ts", "packages/lib-b/src/index.ts", "patches/p.patch", "pnpm-lock.yaml"},
		protectedPathsTouched([]string{"packages/lib-a/src/index.ts", "packages/lib-b/src/index.ts", "apps/site/README.md", "package.json", "pnpm-lock.yaml", "patches/p.patch", "apps/site/package.json"}, entries),
		"privileged action dependencies and root installation inputs remain protected")
}

var workspaceFixture = mapRevisionTree{
	".github/workflows/ci.yml":    "on: push\njobs:\n  a:\n    steps:\n      - uses: ./tools/act/action\n      - uses: ./tools/own\n",
	"tools/own/action.yml":        "runs:\n  using: node24\n  main: index.js\n",
	"tools/own/index.js":          "",
	"tools/own/package.json":      `{"dependencies":{"lib-c":"file:../../packages/lib-c"}}`,
	"tools/act/package.json":      `{"dependencies":{"lib-a":"workspace:*"}}`,
	"tools/act/action/action.yml": "runs:\n  using: node24\n  main: index.js\n",
	"tools/act/action/index.js":   "",
	"pnpm-lock.yaml": `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      root-only:
        specifier: workspace:*
        version: link:packages/root-only
  tools/act:
    dependencies:
      lib-a:
        specifier: workspace:*
        version: link:../../packages/lib-a
      left-pad:
        specifier: ^1.0.0
        version: 1.3.0
  packages/lib-a:
    publishDirectory: dist
    devDependencies:
      lib-b:
        specifier: ^2.0.0
        version: link:../lib-b
    optionalDependencies:
      lib-a-self:
        specifier: workspace:*
        version: link:.
  packages/lib-b:
    dependencies:
      lib-a:
        specifier: workspace:*
        version: link:../lib-a
      outside:
        specifier: link:../../../elsewhere
        version: link:../../../elsewhere
  packages/root-only: {}
  tools/own:
    dependencies:
      lib-c:
        specifier: file:../../packages/lib-c
        version: file:packages/lib-c
      archive:
        specifier: file:vendor/a.tgz
        version: file:vendor/a.tgz
  packages/lib-c: {}
`,
}

// A protected package's workspace dependencies, as the lockfile resolves
// them (a workspace-resolved range too), are protected transitively; a
// registry package, the root package, a path outside the repository and a
// package only the root depends on are not.
func TestWorkflowTrustPathsFollowWorkspaceDependencies(t *testing.T) {
	derived, err := workflowTrustPaths(context.Background(), workspaceFixture)
	require.NoError(t, err)
	assert.Equal(t, []string{
		"/packages/lib-a", "/packages/lib-b", "/packages/lib-c", "/tools/act", "/tools/act/action", "/tools/act/action/index.js",
		"/tools/own", "/tools/own/index.js",
	}, derived, "an action's own package is followed; an injected file: directory is, an archive is not")

	unresolved := mapRevisionTree{}
	for file, content := range workspaceFixture {
		unresolved[file] = content
	}
	delete(unresolved, "pnpm-lock.yaml")
	_, err = workflowTrustPaths(context.Background(), unresolved)
	require.ErrorContains(t, err, "tools/act/package.json depends on lib-a through the workspace, and no pnpm-lock.yaml importer resolves it")

	unresolved["tools/act/package.json"] = `{"dependencies":{"left-pad":"^1.0.0"}}`
	_, err = workflowTrustPaths(context.Background(), unresolved)
	require.ErrorContains(t, err, "tools/own/package.json depends on lib-c through the workspace", "a file: dependency fails closed too")

	unresolved["tools/own/package.json"] = `{}`
	derived, err = workflowTrustPaths(context.Background(), unresolved)
	require.NoError(t, err)
	assert.Equal(t, []string{"/tools/act", "/tools/act/action", "/tools/act/action/index.js", "/tools/own", "/tools/own/index.js"}, derived,
		"no lockfile and no workspace dependency is complete")

	unresolved["pnpm-lock.yaml"] = "importers: [\n"
	_, err = workflowTrustPaths(context.Background(), unresolved)
	require.ErrorContains(t, err, "pnpm-lock.yaml does not parse")
}

// A repository's list is derived once per main commit: an unchanged main is
// a hit that reads nothing, a moved main is a miss that replaces the entry,
// and a failed derivation is never kept.
func TestProtectedPathCacheKeepsOneListPerRepositoryCommit(t *testing.T) {
	ctx := context.Background()
	cache := newProtectedPathCache(2)
	derivations := 0
	derive := func(list ...string) func(context.Context) ([]string, error) {
		return func(context.Context) ([]string, error) {
			derivations++
			return list, nil
		}
	}
	got, err := cache.at(ctx, "Octo/Repo", "c1", derive("a"))
	require.NoError(t, err)
	assert.Equal(t, []string{"a"}, got)
	got, err = cache.at(ctx, "octo/repo", "c1", derive("changed"))
	require.NoError(t, err)
	assert.Equal(t, []string{"a"}, got, "same repository and main commit: a hit")
	assert.Equal(t, 1, derivations)
	got[0] = "mutated"
	got, _ = cache.at(ctx, "octo/repo", "c1", derive("changed"))
	assert.Equal(t, []string{"a"}, got, "a caller cannot change the cached list")

	got, err = cache.at(ctx, "octo/repo", "c2", derive("b"))
	require.NoError(t, err)
	assert.Equal(t, []string{"b"}, got, "main moved: a miss")
	_, _ = cache.at(ctx, "octo/repo", "c1", derive("a"))
	assert.Equal(t, 3, derivations, "the moved main replaced the old entry")

	_, err = cache.at(ctx, "octo/other", "c1", func(context.Context) ([]string, error) { return nil, assert.AnError })
	require.ErrorIs(t, err, assert.AnError)
	_, _ = cache.at(ctx, "octo/other", "c1", derive("o"))
	assert.Equal(t, 4, derivations, "a failure is not cached")

	_, _ = cache.at(ctx, "octo/third", "c1", derive("t"))
	assert.Len(t, cache.entries, 2, "the cache keeps at most its limit of repositories")
	_, err = cache.at(ctx, "octo/repo", "", derive("x"))
	require.ErrorContains(t, err, "commit id")
}

// pullRequestLocalActionJobs names the jobs that pull requests start with
// elevated trust and that run a local action from the pull request's checkout,
// directly or in a reusable workflow the job calls.
func pullRequestLocalActionJobs(workflows []parsedWorkflow) []string {
	byPath := map[string]parsedWorkflow{}
	for _, workflow := range workflows {
		byPath[workflow.path] = workflow
	}
	var found []string
	var visit func(workflow parsedWorkflow, callerElevated bool, seen map[string]bool)
	visit = func(workflow parsedWorkflow, callerElevated bool, seen map[string]bool) {
		if seen[workflow.path] {
			return
		}
		seen[workflow.path] = true
		for name, job := range workflow.doc.Jobs {
			elevated := callerElevated || workflowJobElevated(workflow.doc, job)
			if called, ok := byPath[path.Clean(strings.TrimSpace(job.Uses))]; ok {
				visit(called, elevated, seen)
			}
			if !elevated {
				continue
			}
			for _, step := range job.Steps {
				if uses := strings.TrimSpace(step.Uses); uses == "." || strings.HasPrefix(uses, "./") {
					found = append(found, path.Base(workflow.path)+" "+name+": "+uses)
				}
			}
		}
	}
	for _, workflow := range workflows {
		if workflowTriggeredBy(&workflow.doc.On, "pull_request", "pull_request_target") {
			visit(workflow, false, map[string]bool{})
		}
	}
	sort.Strings(found)
	return found
}

func workflowTriggeredBy(on *yaml.Node, events ...string) bool {
	var names []string
	switch on.Kind {
	case yaml.ScalarNode:
		names = []string{on.Value}
	case yaml.SequenceNode:
		for _, node := range on.Content {
			names = append(names, node.Value)
		}
	case yaml.MappingNode:
		for i := 0; i < len(on.Content); i += 2 {
			names = append(names, on.Content[i].Value)
		}
	}
	for _, name := range names {
		for _, event := range events {
			if name == event {
				return true
			}
		}
	}
	return false
}

// No workflow job that a pull request starts with a secret, id token or
// write permission runs a local action: that code comes from the pull
// request's checkout.
func TestPullRequestWorkflowsRunNoLocalActionWithElevatedTrust(t *testing.T) {
	root := repositoryRoot(t)
	workflows, err := readWorkflows(context.Background(), root)
	require.NoError(t, err)
	require.NotEmpty(t, workflows)
	assert.Empty(t, pullRequestLocalActionJobs(workflows))

	fixture, err := readWorkflows(context.Background(), workflowTrustFixture)
	require.NoError(t, err)
	assert.Equal(t, []string{"review.yml review: ./apps/x/action", "review.yml review: ./tools/review"}, pullRequestLocalActionJobs(fixture),
		"the lint catches a local action in an elevated pull request job and ignores a read-only one")

	called, err := readWorkflows(context.Background(), mapRevisionTree{
		".github/workflows/pr.yml":     "on: pull_request\npermissions:\n  id-token: write\njobs:\n  call:\n    uses: ./.github/workflows/called.yml\n",
		".github/workflows/called.yml": "on: workflow_call\njobs:\n  inner:\n    permissions:\n      contents: read\n    steps:\n      - uses: ./act\n",
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"called.yml inner: ./act"}, pullRequestLocalActionJobs(called), "a called workflow runs with its caller's trust")
}

func TestMythicalProtectedPathsFollowMainsWorkflows(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	for file, content := range workflowTrustFixture {
		require.NoError(t, os.MkdirAll(filepath.Join(f.work, filepath.Dir(file)), 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(f.work, file), []byte(content), 0o600))
	}
	main := f.commit("✨ feat: workflows", "a.txt", "a\n")
	g := mythicalGit{dir: filepath.Join(f.work, ".git")}
	entries, err := g.protectedPaths(context.Background(), main)
	require.NoError(t, err)
	derived, err := workflowTrustPaths(context.Background(), workflowTrustFixture)
	require.NoError(t, err)
	assert.Equal(t, append(append([]string(nil), protectedPathRoots...), derived...), entries)
	assert.Equal(t, []string{"tools/inner/util.js"}, protectedPathsTouched([]string{"src/fix.ts", "tools/inner/util.js"}, entries),
		"an outsider's change to a transitive local action is refused")
}
