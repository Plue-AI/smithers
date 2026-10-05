package microsandbox

import (
	"context"
	"errors"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

var _ workspaceapi.SessionCredentialWriter = (*Runtime)(nil)

// PutSessionToken writes a signed-in terminal's credential in the guest
// through the digest-checked helper (put-token): /run/smithers/sessions/<id>/
// token, owned by the guest's single user, mode 0600, replaced by rename in a
// root-owned directory. The token travels on the helper's stdin, never in
// argv or the environment.
func (r *Runtime) PutSessionToken(ctx context.Context, workspaceID, sessionID string, token []byte) (string, error) {
	if err := workspaceapi.ValidateSessionCredential(sessionID, token); err != nil {
		return "", err
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return "", err
	}
	if _, err := r.guest(ctx, ws.Machine, token, "put-token", sessionID); err != nil {
		return "", err
	}
	return workspaceapi.SessionTokenRoot + "/" + sessionID + "/token", nil
}

// DeleteSessionToken removes a terminal session's credential from the guest.
// A stopped or deleted machine keeps none: /run is not retained.
func (r *Runtime) DeleteSessionToken(ctx context.Context, workspaceID, sessionID string) error {
	if err := workspaceapi.ValidateSessionCredential(sessionID, nil); err != nil {
		return err
	}
	ws, err := r.runningWorkspace(workspaceID)
	if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) || errors.Is(err, workspaceapi.ErrWorkspaceStopped) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = r.guest(ctx, ws.Machine, nil, "delete-token", sessionID)
	return err
}
