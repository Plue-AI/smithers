package microsandbox

import (
	"context"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"strings"
	"time"
)

const machinedBundlePath = "bin/linux-arm64/smithers-machined"
const sftpBundlePath = "bin/linux-arm64/smithers-sftp"

// BindMachinedHost supplies the composed host's authoritative branch head.
// The registry owns event consumption; neither comes from guest metadata.
func (r *Runtime) BindMachinedHost(head func(context.Context, string) (string, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machinedHead = head
}

// BindMachineAgentAdmission keeps the actual host owner authorization locked
// across native spawn and run registration. It is never supplied by a guest.
func (r *Runtime) BindMachineAgentAdmission(admit func(context.Context, string, string, func(context.Context) error) error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machinedAgentAdmission = admit
}

// BindMachineAgentActor commits host-selected immutable run attribution before spawn admission.
func (r *Runtime) BindMachineAgentActor(commit func(context.Context, string, string, string) ([]byte, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machinedAgentActor = commit
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
	if current, err := r.runningWorkspace(id); err != nil || current != ws {
		if err != nil {
			return err
		}
		return ErrUnavailable
	}
	if link, err := r.machined.Current(id); err == nil && link.RequireReady(id) == nil {
		if err := r.syncSecretEnvironment(ctx, ws, link); err != nil {
			return err
		}
		r.watchSecretEnvironment(ws, link)
		return nil
	}
	r.mu.Lock()
	headReader := r.machinedHead
	r.mu.Unlock()
	if r.config.Bundle == nil || headReader == nil || !r.machined.EventConsumerReady() {
		return fmt.Errorf("%w: installed machine host providers unavailable", ErrUnavailable)
	}
	data, digest, err := linuxArm64From(r.config.Bundle, machinedBundlePath, "packaged machine broker")
	if err != nil {
		return err
	}
	sftp, sftpDigest, err := linuxArm64From(r.config.Bundle, sftpBundlePath, "packaged SFTP subsystem")
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
	currentSFTP, err := r.guest(ctx, ws.Machine, nil, "managed-artifact-check", sftpBundlePath, sftpDigest)
	if err != nil {
		return err
	}
	switch strings.TrimSpace(string(currentSFTP)) {
	case "current":
	case "replace":
		if _, err = r.guest(ctx, ws.Machine, sftp, "managed-artifact", sftpBundlePath, sftpDigest); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: invalid SFTP artifact receipt", ErrUnavailable)
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
	// The registry drains replay while reconciliation may await durable acks.
	// This link is shared by all people; closing a terminal cannot cancel it.
	go func() {
		<-link.Done()
		// A broken private link does not terminate its member processes or boot.
		// The next authenticated connection replays outbox and stream receipts.
		delay := time.Second
		for {
			if current, err := r.runningWorkspace(id); err != nil || current != ws {
				return
			}
			time.Sleep(delay)
			if current, err := r.runningWorkspace(id); err != nil || current != ws {
				return
			}
			retry, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			err := r.EnsureMachined(retry, id)
			cancel()
			if err == nil {
				return
			}
			if delay < 30*time.Second {
				delay *= 2
				if delay > 30*time.Second {
					delay = 30 * time.Second
				}
			}
		}
	}()
	if err = r.machined.AdmitReady(ctx, id, head, nil); err != nil {
		_ = link.Close()
		return err
	}
	if err := r.syncSecretEnvironment(ctx, ws, link); err != nil {
		return err
	}
	r.watchSecretEnvironment(ws, link)
	return nil
}
