package microsandbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const (
	// secretEnvironmentLimit bounds the team environment file the session
	// loaders read (crates/smithers-machined session_environment.rs).
	secretEnvironmentLimit = 256 * 1024
	// secretDeliveryLimit bounds one put-env request (SECRET_ENV_LIMIT in the
	// guest helper).
	secretDeliveryLimit = 1 << 20
)

// MachineSecrets is one branch machine's secrets (spec §8.8.0–§8.8.1b): the
// team environment's literal values, the host-bound secrets only the egress
// relay holds, and the declared files.
type MachineSecrets struct {
	// Env holds variables and the values of secrets bound to no host.
	Env map[string]string
	// Bound are secrets bound to hosts. Their values reach only the egress
	// relay; the machine holds each one's placeholder.
	Bound []sandbox.EgressProxySecret
	// Files maps each declared path to an unbound secret's value or a bound
	// secret's placeholder.
	Files map[string]string
}

// The source is the host's existing secret splitter. No value enters metadata,
// CreateRequest, an actor envelope, or a root process environment.
func (r *Runtime) BindSecretEnvironment(source func(context.Context, string) (MachineSecrets, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.secretEnvironment = source
}
func (r *Runtime) SecretEnvironmentAvailable() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.config.Bundle != nil && r.secretEnvironment != nil && r.memberRoster != nil && r.machinedHead != nil && r.machined.EventConsumerReady()
}

// Called with daemonMu held, after actual authenticated wake settlement.
func (r *Runtime) syncSecretEnvironment(ctx context.Context, ws *workspace, link *machined.Link) error {
	r.mu.Lock()
	source := r.secretEnvironment
	r.mu.Unlock()
	if source == nil {
		return nil
	}
	if !r.SecretEnvironmentAvailable() {
		return fmt.Errorf("%w: secret environment providers unavailable", ErrUnavailable)
	}
	if err := link.RequireReady(ws.ID); err != nil {
		return err
	}
	secrets, err := source(ctx, ws.ID)
	if err != nil {
		return err
	}
	environment, err := r.machineEnvironment(ctx, ws, secrets)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(environment)
	if err != nil {
		return err
	}
	if len(encoded) > secretEnvironmentLimit {
		return fmt.Errorf("%w: secret environment exceeds limit", ErrUnavailable)
	}
	files := secrets.Files
	if files == nil {
		files = map[string]string{}
	}
	body, err := json.Marshal(struct {
		Env   map[string]string `json:"env"`
		Files map[string]string `json:"files"`
	}{environment, files})
	if err != nil {
		return err
	}
	if len(body) > secretDeliveryLimit {
		return fmt.Errorf("%w: secret delivery exceeds limit", ErrUnavailable)
	}
	hash := sha256.Sum256(body)
	if ws.secretEnvironmentDigest != nil && *ws.secretEnvironmentDigest == hash {
		return nil
	}
	output, err := r.guest(ctx, ws.Machine, body, "put-env")
	if err != nil {
		return err
	}
	if err = link.RequireReady(ws.ID); err != nil {
		return err
	}
	// The guest reports declared paths it refused (a symlink, a foreign
	// directory), never values; the others were written.
	if refused := bytes.TrimSpace(output); len(refused) != 0 {
		slog.Warn("machine secret files refused", "branch", ws.ID, "report", string(refused))
	}
	ws.secretEnvironmentDigest = &hash
	return nil
}

// machineEnvironment is the team environment a machine's sessions load: the
// literal values, each bound secret's placeholder, and, while any secret is
// bound, the egress relay route that swaps the placeholders toward their
// hosts (spec §8.8.0, §8.8.1b). The relay is rebound only when the bound set
// changes, so the route's credential is stable between changes. Called with
// daemonMu held.
func (r *Runtime) machineEnvironment(ctx context.Context, ws *workspace, secrets MachineSecrets) (map[string]string, error) {
	environment := maps.Clone(secrets.Env)
	if environment == nil {
		environment = map[string]string{}
	}
	var digest *[32]byte
	if len(secrets.Bound) != 0 {
		encoded, err := json.Marshal(secrets.Bound)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(encoded)
		digest = &sum
	}
	switch {
	case digest == nil && ws.relayDigest != nil:
		if err := r.RevokeEgressSecrets(ctx, ws.ID); err != nil {
			return nil, err
		}
		ws.relayDigest, ws.relayEnvironment = nil, nil
	case digest != nil && (ws.relayDigest == nil || *ws.relayDigest != *digest):
		binding, err := r.BindEgressSecrets(ctx, ws.ID, secrets.Bound)
		if err != nil {
			return nil, err
		}
		ws.relayDigest, ws.relayEnvironment = digest, binding.Environment
	}
	for _, secret := range secrets.Bound {
		environment[secret.Name] = sandbox.EgressProxyPlaceholder(secret.Name)
	}
	for name, value := range ws.relayEnvironment {
		environment[name] = value
	}
	return environment, nil
}

// forgetSecretDelivery makes the next sync deliver again, as when a home is
// created after the last delivery. Takes daemonMu.
func (ws *workspace) forgetSecretDelivery() {
	ws.daemonMu.Lock()
	ws.secretEnvironmentDigest = nil
	ws.daemonMu.Unlock()
}

func (r *Runtime) watchSecretEnvironment(ws *workspace, link *machined.Link) {
	r.mu.Lock()
	source := r.secretEnvironment
	r.mu.Unlock()
	if source == nil || ws.secretEnvironmentLink == link {
		return
	}
	ws.secretEnvironmentLink = link
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if _, err := r.runningWorkspace(ws.ID); err != nil {
				return
			}
			ws.daemonMu.Lock()
			current, err := r.machined.Current(ws.ID)
			if err == nil && current == link {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				err = r.syncSecretEnvironment(ctx, ws, link)
				cancel()
			}
			ws.daemonMu.Unlock()
			if current != link {
				return
			}
			if err != nil {
				slog.Warn("machine secret environment refresh failed", "branch", ws.ID)
			}
		}
	}()
}
