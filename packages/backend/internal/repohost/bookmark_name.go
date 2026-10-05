package repohost

import (
	"fmt"
	"strings"
)

// ValidateBookmarkName enforces git refname syntax for "refs/heads/<name>"
// (the rules of git-check-ref-format, plus git's refusal of "HEAD" as a
// branch name). jj itself accepts any bookmark name, but every Smithers
// bookmark must export as a git branch; a name that fails these rules is
// recorded in jj and then silently fails to export, leaving the API
// advertising a branch that can never be fetched or mirrored to GitHub.
func ValidateBookmarkName(name string) error {
	if name == "" {
		return fmt.Errorf("bookmark name is required")
	}
	if name == "@" || name == "HEAD" {
		return fmt.Errorf("bookmark name %q is reserved by git", name)
	}
	if problem := refFormatProblem(name); problem != "" {
		return fmt.Errorf("bookmark name %s", problem)
	}
	return nil
}

// ValidateRefName admits the ref a receive-pack command names: a fully
// qualified name under refs/ that passes git-check-ref-format. HEAD, the
// other pseudorefs (FETCH_HEAD, ORIG_HEAD, MERGE_HEAD) and every bare name
// are refused before git runs, whoever pushes: git resolves such a name
// through HEAD, so any later write or delete of it, a rollback's included,
// would land on the branch HEAD names.
func ValidateRefName(name string) error {
	if !strings.HasPrefix(name, "refs/") {
		return fmt.Errorf("ref %q is not a fully qualified name under refs/", name)
	}
	if problem := refFormatProblem(name); problem != "" {
		return fmt.Errorf("ref %q %s", name, problem)
	}
	return nil
}

// refFormatProblem says which rule of git-check-ref-format name breaks, or
// "" when it passes them all.
func refFormatProblem(name string) string {
	if name == "@" {
		return "must not be '@'"
	}
	if strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") {
		return "must not start or end with '/'"
	}
	if strings.HasSuffix(name, ".") {
		return "must not end with '.'"
	}
	if strings.Contains(name, "..") {
		return "must not contain '..'"
	}
	if strings.Contains(name, "@{") {
		return "must not contain '@{'"
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7F {
			return "must not contain control characters"
		}
		if strings.ContainsRune(" ~^:?*[\\", r) {
			return fmt.Sprintf("must not contain %q", r)
		}
	}
	for _, component := range strings.Split(name, "/") {
		if component == "" {
			return "must not contain consecutive '/'"
		}
		if strings.HasPrefix(component, ".") {
			return "components must not start with '.'"
		}
		if strings.HasSuffix(component, ".lock") {
			return "components must not end with '.lock'"
		}
	}
	return ""
}
