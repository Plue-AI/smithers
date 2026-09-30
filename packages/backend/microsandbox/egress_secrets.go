package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/egressrelay"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// egressCAFile is the relay CA a bound command trusts, in the guest's state
// directory. It is public material: the key never leaves the backend.
const egressCAFile = "egress-ca.pem"

// relayPort is the loopback port a guest reaches the egress relay on through
// its host bridge, or 0 when no relay is configured.
func relayPort(relay *egressrelay.Relay) uint16 {
	if relay == nil {
		return 0
	}
	_, raw, err := net.SplitHostPort(relay.Address())
	if err != nil {
		return 0
	}
	port, err := strconv.ParseUint(raw, 10, 16)
	if err != nil {
		return 0
	}
	return uint16(port)
}

// BindEgressSecrets binds secrets through the egress relay. The guest
// reaches the relay only over its bridged backend loopback port; a secret
// value never enters the VM.
func (r *Runtime) BindEgressSecrets(ctx context.Context, workspaceID string, secrets []sandbox.EgressProxySecret) (workspaceapi.EgressSecretBinding, error) {
	relay := r.config.EgressRelay
	if relay == nil {
		return workspaceapi.EgressSecretBinding{}, workspaceapi.ErrEgressSecretsUnsupported
	}
	if err := ctx.Err(); err != nil {
		return workspaceapi.EgressSecretBinding{}, err
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return workspaceapi.EgressSecretBinding{}, err
	}
	if port := relayPort(relay); ws.RelayPort != port {
		return workspaceapi.EgressSecretBinding{}, fmt.Errorf("%w: workspace %s machine was built without a route to the egress relay on port %d; reclaim its disk to rebuild it",
			workspaceapi.ErrEgressSecretsUnsupported, ws.ID, port)
	}
	grant, err := relay.Bind(ws.ID, secrets)
	if err != nil || len(secrets) == 0 {
		return workspaceapi.EgressSecretBinding{}, err
	}
	if _, err := r.fileOperation(ctx, ws.ID, guestStateDir, grant.CACertPEM, "write", egressCAFile, "644"); err != nil {
		relay.RevokeGrant(ws.ID, grant)
		return workspaceapi.EgressSecretBinding{}, fmt.Errorf("write egress relay CA: %w", err)
	}
	// A stop that raced the bind must not leave a live binding behind.
	if _, err := r.runningWorkspace(ws.ID); err != nil {
		relay.RevokeGrant(ws.ID, grant)
		return workspaceapi.EgressSecretBinding{}, err
	}
	return workspaceapi.EgressSecretBinding{Environment: egressrelay.GuestEnvironment(grant, grant.ProxyURL, guestStateDir+"/"+egressCAFile)}, nil
}

// RevokeEgressSecrets removes the workspace's binding. It is idempotent.
func (r *Runtime) RevokeEgressSecrets(ctx context.Context, workspaceID string) error {
	if r.config.EgressRelay == nil {
		return workspaceapi.ErrEgressSecretsUnsupported
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	r.config.EgressRelay.Revoke(strings.TrimSpace(workspaceID))
	return nil
}

// withRelayRoute adds the relay's port to the backend ports every new
// machine may reach, so its bridge starts with the others.
func withRelayRoute(config *Config) error {
	port := relayPort(config.EgressRelay)
	if config.EgressRelay == nil {
		return nil
	}
	if port == 0 {
		return errors.New("egress relay has no loopback port")
	}
	for _, existing := range config.HostPorts {
		if existing == port {
			return nil
		}
	}
	config.HostPorts = append(append([]uint16(nil), config.HostPorts...), port)
	return nil
}

var _ workspaceapi.WorkspaceEgressSecrets = (*Runtime)(nil)
