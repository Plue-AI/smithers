package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

var _ workspaceapi.SessionCredentialWriter = (*Runtime)(nil)

// sessionTokenDirectory is the workspace's own copy of the guest's
// /run/smithers/sessions: the trusted-process runtime has no guest, so a
// session's processes read their credential under the workspace directory.
func sessionTokenDirectory(ws *workspace, sessionID string) string {
	return filepath.Join(ws.directory, "run", "smithers", "sessions", sessionID)
}

// PutSessionToken writes the session's credential file, mode 0600 in a 0700
// directory, replacing an earlier one atomically, and answers its path.
func (r *Runtime) PutSessionToken(ctx context.Context, workspaceID, sessionID string, token []byte) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := workspaceapi.ValidateSessionCredential(sessionID, token); err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.runningWorkspaceLocked(workspaceID)
	if err != nil {
		return "", err
	}
	directory := sessionTokenDirectory(ws, sessionID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("session credential directory: %w", err)
	}
	// The directory is this runtime's own: refuse one a session replaced.
	if info, err := os.Lstat(directory); err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		if err == nil {
			err = errors.New("not a private directory")
		}
		return "", fmt.Errorf("session credential directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".token-*")
	if err != nil {
		return "", fmt.Errorf("session credential: %w", err)
	}
	defer func() { _ = os.Remove(temporary.Name()) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("session credential: %w", err)
	}
	if _, err := temporary.Write(append(append([]byte(nil), token...), '\n')); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("session credential: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("session credential: %w", err)
	}
	path := filepath.Join(directory, "token")
	if err := os.Rename(temporary.Name(), path); err != nil {
		return "", fmt.Errorf("session credential: %w", err)
	}
	return path, nil
}

// DeleteSessionToken removes the session's credential directory. A
// workspace that is gone has no credential left to remove.
func (r *Runtime) DeleteSessionToken(ctx context.Context, workspaceID, sessionID string) error {
	if err := workspaceapi.ValidateSessionCredential(sessionID, nil); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
			return nil
		}
		return err
	}
	return os.RemoveAll(sessionTokenDirectory(ws, sessionID))
}
