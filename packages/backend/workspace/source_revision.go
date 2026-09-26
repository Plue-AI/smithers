package workspace

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"strings"
)

// SourceRevisionRuntime is the slice of a runtime that source resolution
// needs. Every adapter resolves through ResolveSourceRevision, so trusted and
// isolated workspaces apply one rule.
type SourceRevisionRuntime interface {
	InspectWorkspace(ctx context.Context, workspaceID string) (Workspace, error)
	ExecuteCommand(ctx context.Context, workspaceID string, command Command) (CommandResult, error)
	ListFiles(ctx context.Context, workspaceID, path string) ([]FileEntry, error)
}

// ResolveSourceRevision returns the repository snapshot used to launch a Flow
// host. Jujutsu's working-copy commit captures the current snapshot. A plain
// Git checkout is accepted only when its worktree is clean.
func ResolveSourceRevision(ctx context.Context, runtime SourceRevisionRuntime, workspaceID string) (string, error) {
	current, err := runtime.InspectWorkspace(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	if current.State != WorkspaceRunning {
		return "", ErrWorkspaceStopped
	}
	entries, err := runtime.ListFiles(ctx, workspaceID, "")
	if err != nil {
		return "", fmt.Errorf("inspect repository metadata: %w", err)
	}
	jj, err := repositoryMarker(entries, ".jj")
	if err != nil {
		return "", err
	}
	if jj {
		result, err := runtime.ExecuteCommand(ctx, workspaceID, Command{
			Args: []string{"jj", "--color=never", "log", "-r", "@", "--no-graph", "-T", "commit_id ++ \"\\n\""},
		})
		if err != nil {
			return "", fmt.Errorf("resolve Jujutsu workspace revision: %w", err)
		}
		if result.ExitCode != 0 || result.OutputTruncated {
			return "", fmt.Errorf("%w: Jujutsu snapshot failed", ErrWorkspaceSourceUnavailable)
		}
		return validatedSourceRevision(result.Stdout)
	}

	git, err := repositoryMarker(entries, ".git")
	if err != nil {
		return "", err
	}
	if !git {
		return "", ErrWorkspaceSourceUnavailable
	}
	first, err := gitHead(ctx, runtime, workspaceID)
	if err != nil {
		return "", err
	}
	status, err := runtime.ExecuteCommand(ctx, workspaceID, Command{
		Args: []string{"git", "status", "--porcelain=v1", "--untracked-files=normal"},
	})
	if err != nil {
		return "", fmt.Errorf("inspect Git workspace: %w", err)
	}
	if status.ExitCode != 0 || status.OutputTruncated {
		return "", fmt.Errorf("%w: Git status failed", ErrWorkspaceSourceUnavailable)
	}
	if strings.TrimSpace(status.Stdout) != "" {
		return "", fmt.Errorf("%w: Git worktree is not clean", ErrWorkspaceSourceUnavailable)
	}
	second, err := gitHead(ctx, runtime, workspaceID)
	if err != nil {
		return "", err
	}
	if first != second {
		return "", fmt.Errorf("%w: Git HEAD changed while resolving", ErrWorkspaceSourceUnavailable)
	}
	return first, nil
}

func gitHead(ctx context.Context, runtime SourceRevisionRuntime, workspaceID string) (string, error) {
	result, err := runtime.ExecuteCommand(ctx, workspaceID, Command{
		Args: []string{"git", "rev-parse", "--verify", "HEAD"},
	})
	if err != nil {
		return "", fmt.Errorf("resolve Git workspace revision: %w", err)
	}
	if result.ExitCode != 0 || result.OutputTruncated {
		return "", fmt.Errorf("%w: Git HEAD resolution failed", ErrWorkspaceSourceUnavailable)
	}
	return validatedSourceRevision(result.Stdout)
}

func repositoryMarker(entries []FileEntry, name string) (bool, error) {
	for _, entry := range entries {
		if entry.Name != name {
			continue
		}
		if entry.Mode&fs.ModeSymlink != 0 {
			return false, errors.New("repository metadata must not be a symbolic link")
		}
		return true, nil
	}
	return false, nil
}

func validatedSourceRevision(output string) (string, error) {
	revision := strings.TrimSpace(output)
	if len(revision) != 40 || revision != strings.ToLower(revision) {
		return "", fmt.Errorf("%w: revision must be 40 lowercase hexadecimal characters", ErrWorkspaceSourceUnavailable)
	}
	if _, err := hex.DecodeString(revision); err != nil {
		return "", fmt.Errorf("%w: revision must be 40 lowercase hexadecimal characters", ErrWorkspaceSourceUnavailable)
	}
	return revision, nil
}
