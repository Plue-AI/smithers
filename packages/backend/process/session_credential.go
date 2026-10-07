package process

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

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
func (r *Runtime) PutSessionToken(ctx context.Context, workspaceID, sessionID string, token []byte, expectedIdentity string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := workspaceapi.ValidateSessionCredential(sessionID, token); err != nil {
		return "", err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(expectedIdentity, true); err != nil {
		return "", err
	}
	if token == nil {
		return "", errors.New("session credential: missing token")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.runningWorkspaceLocked(workspaceID)
	if err != nil {
		return "", err
	}
	directory := sessionTokenDirectory(ws, sessionID)
	if err := matchSessionToken(filepath.Join(directory, "token"), expectedIdentity); err != nil {
		return "", err
	}
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
func (r *Runtime) DeleteSessionToken(ctx context.Context, workspaceID, sessionID, expectedIdentity string) error {
	if err := workspaceapi.ValidateSessionCredential(sessionID, nil); err != nil {
		return err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(expectedIdentity, false); err != nil {
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
	directory := sessionTokenDirectory(ws, sessionID)
	if _, err := os.Lstat(directory); os.IsNotExist(err) {
		return nil
	}
	if err := matchSessionToken(filepath.Join(directory, "token"), expectedIdentity); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(directory, "token")); err != nil {
		return err
	}
	return os.Remove(directory)
}

func matchSessionToken(path, expected string) error {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if os.IsNotExist(err) && expected == "" {
		return nil
	}
	if err != nil {
		return fmt.Errorf("session credential identity: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if expected == "" || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Size() > 513 {
		return errors.New("session credential: identity mismatch")
	}
	body, err := io.ReadAll(io.LimitReader(file, 514))
	if err != nil {
		return err
	}
	token := []byte(strings.TrimSuffix(string(body), "\n"))
	if err := workspaceapi.ValidateSessionCredential("valid", token); err != nil {
		return err
	}
	if workspaceapi.SessionCredentialIdentity(token) != expected {
		return errors.New("session credential: identity mismatch")
	}
	return nil
}
