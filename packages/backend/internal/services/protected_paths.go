package services

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// protectedPathRoots are the repository's trust roots: CI, Smithers and agent
// configuration, and the declarations that decide what runs with the
// repository's credentials. A change that an outsider's issue text started may
// never touch them; a maintainer makes such a change. A repository adds its
// own entries with S.Github.Policy({ protectedPaths }) and cannot remove these.
var protectedPathRoots = []string{
	// CI and hooks that run on a pushed branch.
	".github", ".gitlab-ci.yml", ".circleci", ".buildkite", "Jenkinsfile",
	".husky", ".githooks", "lefthook.yml", ".pre-commit-config.yaml",
	// Smithers, agent, editor and environment configuration.
	".smithers", ".agents", ".claude", ".codex", ".cursor", ".cursorrules", ".gemini", ".mcp.json",
	".devcontainer", ".vscode", ".envrc", ".npmrc", ".gitattributes", ".gitmodules",
	// Declarations and instructions.
	"AGENTS.md", "CLAUDE.md", "GEMINI.md", "FACTORY.ts", "PACKAGE.ts", "WORKSPACE.ts", "OWNERS", "CODEOWNERS",
}

// factoryProjectionPath is the committed projection of .smithers/FACTORY.ts.
const factoryProjectionPath = ".smithers/factory.json"

// protectedPaths is the built-in trust roots plus the entries main's factory
// projection declares. A missing projection yields the built-ins; an
// unreadable one is an error, never an empty list.
func protectedPaths(projection []byte) ([]string, error) {
	entries := append([]string(nil), protectedPathRoots...)
	if len(projection) == 0 {
		return entries, nil
	}
	var factory struct {
		Github *struct {
			ProtectedPaths []string `json:"protectedPaths"`
		} `json:"github"`
	}
	if err := json.Unmarshal(projection, &factory); err != nil {
		return nil, errors.New(factoryProjectionPath + " is not valid JSON")
	}
	if factory.Github != nil {
		for _, entry := range factory.Github.ProtectedPaths {
			entry = strings.Trim(strings.TrimSpace(entry), "/")
			if entry == "" || strings.Contains("/"+entry+"/", "/../") {
				return nil, errors.New(factoryProjectionPath + " declares an invalid protected path")
			}
			entries = append(entries, entry)
		}
	}
	return entries, nil
}

// revisionTree reads one revision of a repository.
type revisionTree interface {
	// read returns a file's content; found is false when it does not exist.
	read(ctx context.Context, path string) (content []byte, found bool, err error)
	// files lists every file under dir, at any depth; none when dir is absent.
	files(ctx context.Context, dir string) ([]string, error)
}

// protectedPathsAt is the protected-path list on one revision: the built-in
// trust roots, the entries its factory projection declares, and every path
// its workflows execute with elevated trust (workflowTrustPaths).
func protectedPathsAt(ctx context.Context, tree revisionTree) ([]string, error) {
	projection, _, err := tree.read(ctx, factoryProjectionPath)
	if err != nil {
		return nil, err
	}
	entries, err := protectedPaths(projection)
	if err != nil {
		return nil, err
	}
	derived, err := workflowTrustPaths(ctx, tree)
	if err != nil {
		return nil, err
	}
	return append(entries, derived...), nil
}

// protectedPathMatches reports whether path is protected by entry: an entry
// without "/" names a file or directory at any depth; an entry with "/"
// (a leading "/" marks a root-level one) is a root-relative path and
// everything under it. Matching is case-insensitive, as on the
// case-insensitive checkouts a change also reaches.
func protectedPathMatches(path, entry string) bool {
	path, entry = strings.ToLower(strings.Trim(path, "/")), strings.ToLower(entry)
	rooted := strings.Contains(entry, "/")
	entry = strings.Trim(entry, "/")
	if !rooted {
		for _, segment := range strings.Split(path, "/") {
			if segment == entry {
				return true
			}
		}
		return false
	}
	return path == entry || strings.HasPrefix(path, entry+"/")
}

// protectedPathsTouched lists, sorted and once each, the paths that any
// entry protects.
func protectedPathsTouched(paths, entries []string) []string {
	var touched []string
	seen := map[string]bool{}
	for _, path := range paths {
		if seen[path] {
			continue
		}
		seen[path] = true
		for _, entry := range entries {
			if protectedPathMatches(path, entry) {
				touched = append(touched, path)
				break
			}
		}
	}
	sort.Strings(touched)
	return touched
}
