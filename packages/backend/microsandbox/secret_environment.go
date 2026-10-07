package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"log/slog"
	"time"
)

// The source is the host's existing secret splitter. No value enters metadata,
// CreateRequest, an actor envelope, or a root process environment.
func (r *Runtime) BindSecretEnvironment(source func(context.Context, string) (map[string]string, error)) {
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
	environment, err := source(ctx, ws.ID)
	if err != nil {
		return err
	}
	if environment == nil {
		environment = map[string]string{}
	}
	body, err := json.Marshal(environment)
	if err != nil {
		return err
	}
	if len(body) > 256*1024 {
		return fmt.Errorf("%w: secret environment exceeds limit", ErrUnavailable)
	}
	hash := sha256.Sum256(body)
	if ws.secretEnvironmentDigest != nil && *ws.secretEnvironmentDigest == hash {
		return nil
	}
	if _, err = r.guest(ctx, ws.Machine, body, "put-env"); err != nil {
		return err
	}
	if err = link.RequireReady(ws.ID); err != nil {
		return err
	}
	ws.secretEnvironmentDigest = &hash
	return nil
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
