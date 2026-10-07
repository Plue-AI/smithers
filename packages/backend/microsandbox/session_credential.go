package microsandbox

import (
	"context"
	"errors"
	"fmt"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

var _ workspaceapi.SessionCredentialWriter = (*Runtime)(nil)

// PutSessionToken writes a signed-in terminal's credential in the guest
// through the digest-checked helper (put-token): /run/smithers/sessions/<id>/
// token, owned by the guest's single user, mode 0600, replaced by rename in a
// root-owned directory. The token travels on the helper's stdin, never in
// argv or the environment.
func (r *Runtime) PutSessionToken(ctx context.Context, workspaceID, sessionID string, token []byte, expectedIdentity string) (string, error) {
	if err := workspaceapi.ValidateSessionCredential(sessionID, token); err != nil {
		return "", err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(expectedIdentity, true); err != nil {
		return "", err
	}
	if token == nil {
		return "", errors.New("session credential: missing token")
	}
	if len(r.config.HostPorts) == 0 || r.config.HostPorts[0] == 0 {
		return "", errors.New("session credential: backend bridge issuer is unavailable")
	}
	issuer := fmt.Sprintf("http://127.0.0.1:%d", r.config.HostPorts[0])
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return "", err
	}
	if _, err := r.guest(ctx, ws.Machine, token, "put-token", sessionID, tokenIdentityArgument(expectedIdentity), issuer); err != nil {
		return "", err
	}
	return workspaceapi.SessionTokenRoot + "/" + sessionID + "/token", nil
}

// DeleteSessionToken removes a terminal session's credential from the guest.
// A stopped or deleted machine keeps none: /run is not retained.
func (r *Runtime) DeleteSessionToken(ctx context.Context, workspaceID, sessionID, expectedIdentity string) error {
	if err := workspaceapi.ValidateSessionCredential(sessionID, nil); err != nil {
		return err
	}
	if err := workspaceapi.ValidateSessionCredentialIdentity(expectedIdentity, false); err != nil {
		return err
	}
	ws, err := r.runningWorkspace(workspaceID)
	if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) || errors.Is(err, workspaceapi.ErrWorkspaceStopped) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = r.guest(ctx, ws.Machine, nil, "delete-token", sessionID, expectedIdentity)
	return err
}

func tokenIdentityArgument(identity string) string {
	if identity == "" {
		return "absent"
	}
	return identity
}
