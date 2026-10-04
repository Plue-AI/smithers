// Package gitutil shares git plumbing without choosing the caller's execution policy.
package gitutil

import (
	"context"
	"errors"
	"os/exec"
)

// IsAncestor preserves Git's three outcomes: success, exit 1 (not an
// ancestor), and an execution error. Callers retain their controlled command
// environment, cancellation and repository lock. This replaces the repo-host,
// mythical, main-pull and mirror copies; it never executes repository code.
func IsAncestor(ctx context.Context, gitDir, ancestor, descendant string, command func(context.Context, ...string) *exec.Cmd) (bool, error) {
	err := command(ctx, "--git-dir", gitDir, "merge-base", "--is-ancestor", ancestor, descendant).Run()
	if err == nil {
		return true, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return false, nil
	}
	return false, err
}
