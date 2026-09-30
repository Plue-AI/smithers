package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/smithersai/smithers/packages/backend/egressrelay"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// egressCAFile is the relay CA a bound command trusts, in the workspace's
// state directory.
const egressCAFile = "egress-ca.pem"

// BindEgressSecrets binds secrets through the configured egress relay. The
// values stay out of the child's environment, argv and files; a trusted
// process still runs with the backend's OS authority, so this keeps secrets
// out of repository code's reach by construction, not by isolation.
func (r *Runtime) BindEgressSecrets(ctx context.Context, workspaceID string, secrets []sandbox.EgressProxySecret) (workspaceapi.EgressSecretBinding, error) {
	if r.relay == nil {
		return workspaceapi.EgressSecretBinding{}, workspaceapi.ErrEgressSecretsUnsupported
	}
	if err := ctx.Err(); err != nil {
		return workspaceapi.EgressSecretBinding{}, err
	}
	stateDir, err := r.runningStateDir(workspaceID)
	if err != nil {
		return workspaceapi.EgressSecretBinding{}, err
	}
	grant, err := r.relay.Bind(strings.TrimSpace(workspaceID), secrets)
	if err != nil || len(secrets) == 0 {
		return workspaceapi.EgressSecretBinding{}, err
	}
	caPath := filepath.Join(stateDir, egressCAFile)
	if err := os.WriteFile(caPath, grant.CACertPEM, 0o644); err != nil {
		r.relay.RevokeGrant(workspaceID, grant)
		return workspaceapi.EgressSecretBinding{}, fmt.Errorf("write egress relay CA: %w", err)
	}
	// A stop that raced the bind must not leave a live binding behind.
	if _, err := r.runningStateDir(workspaceID); err != nil {
		r.relay.RevokeGrant(workspaceID, grant)
		return workspaceapi.EgressSecretBinding{}, err
	}
	return workspaceapi.EgressSecretBinding{Environment: egressrelay.GuestEnvironment(grant, grant.ProxyURL, caPath)}, nil
}

// RevokeEgressSecrets removes the workspace's binding. It is idempotent.
func (r *Runtime) RevokeEgressSecrets(ctx context.Context, workspaceID string) error {
	if r.relay == nil {
		return workspaceapi.ErrEgressSecretsUnsupported
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	r.relay.Revoke(strings.TrimSpace(workspaceID))
	return nil
}

func (r *Runtime) revokeEgressSecrets(workspaceID string) {
	if r.relay != nil {
		r.relay.Revoke(strings.TrimSpace(workspaceID))
	}
}

func (r *Runtime) runningStateDir(workspaceID string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		return "", err
	}
	if ws.State != string(workspaceapi.WorkspaceRunning) {
		return "", errors.Join(workspaceapi.ErrWorkspaceStopped, fmt.Errorf("workspace %s is %s", ws.ID, ws.State))
	}
	return describeWorkspace(ws).StateDir, nil
}

var _ workspaceapi.WorkspaceEgressSecrets = (*Runtime)(nil)
