package microsandbox

import (
	"context"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"strings"
	"time"
)

const machinedBundlePath = "bin/linux-arm64/smithers-machined"

// BindMachinedHost supplies the composed host's authoritative branch head and
// durable event dispatcher. Neither is sourced from guest metadata or argv.
func (r *Runtime) BindMachinedHost(head func(context.Context, string) (string, error), dispatch func(context.Context, *machined.Link, string) error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machinedHead, r.machinedDispatch = head, dispatch
}

// EnsureMachined plants only the pinned install artifact, then authenticates
// and reconciles through the same private byte transport as other guest ports.
// It is lazy: the source checkout must exist before the native daemon opens it.
func (r *Runtime) EnsureMachined(ctx context.Context, id string) error {
	ws, err := r.runningWorkspace(id)
	if err != nil {
		return err
	}
	ws.daemonMu.Lock()
	defer ws.daemonMu.Unlock()
	if link, err := r.machined.Current(id); err == nil && link.RequireReady(id) == nil {
		return nil
	}
	r.mu.Lock()
	headReader, dispatch := r.machinedHead, r.machinedDispatch
	r.mu.Unlock()
	if r.config.Bundle == nil || headReader == nil || dispatch == nil {
		return fmt.Errorf("%w: installed machine host providers unavailable", ErrUnavailable)
	}
	data, digest, err := linuxArm64From(r.config.Bundle, machinedBundlePath, "packaged machine broker")
	if err != nil {
		return err
	}
	head, err := headReader(ctx, id)
	if err != nil {
		return err
	}
	if !lowerHex(head, 40) {
		return fmt.Errorf("%w: authoritative branch head unavailable", ErrUnavailable)
	}
	current, err := r.guest(ctx, ws.Machine, nil, "machined-check", digest)
	if err != nil {
		return err
	}
	switch strings.TrimSpace(string(current)) {
	case "current":
	case "replace":
		if _, err = r.guest(ctx, ws.Machine, data, "machined-install", digest); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: invalid machine artifact check", ErrUnavailable)
	}
	if ws.daemonBoot == nil {
		authority, err := r.machined.MintBoot(id, ws.Machine)
		if err != nil {
			return err
		}
		ws.daemonBoot = &authority
	}
	state, err := r.guest(ctx, ws.Machine, ws.daemonBoot.File(0), "machined-start", digest)
	if err != nil {
		return err
	}
	if value := strings.TrimSpace(string(state)); value != "started" && value != "current" {
		return fmt.Errorf("%w: invalid machine startup receipt", ErrUnavailable)
	}
	var link *machined.Link
	deadline := time.Now().Add(10 * time.Second)
	for {
		stream, dialErr := r.dial(ctx, ws.Machine, 970)
		if dialErr == nil {
			link, err = r.machined.Connect(ctx, id, stream)
		} else {
			err = dialErr
		}
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Now().After(deadline) {
			return err
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	// The dispatcher drains replay while reconciliation may await durable acks.
	// This link is shared by all people; closing a terminal cannot cancel it.
	go func() { defer link.Close(); _ = dispatch(context.Background(), link, id) }()
	if err = r.machined.AdmitReady(ctx, id, head, nil); err != nil {
		_ = link.Close()
		return err
	}
	return nil
}
