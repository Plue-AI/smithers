package microsandbox

import (
	"context"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"log/slog"
	"strings"
	"time"
)

const machinedBundlePath = "bin/linux-arm64/smithers-machined"
const sftpBundlePath = "bin/linux-arm64/smithers-sftp"

func (r *Runtime) BindMachinedItem(resolve func(context.Context, string) (machined.ItemBinding, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machinedItem = resolve
}

// BindMachinedHost supplies the composed host's authoritative branch head.
// The registry owns event consumption; neither comes from guest metadata.
func (r *Runtime) BindMachinedHost(head func(context.Context, string) (string, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machinedHead = head
}

// BindMachinedConflict binds only the composed stack's retained native conflict.
func (r *Runtime) BindMachinedConflict(resolve func(context.Context, string) (*machined.RetainedConflict, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machinedConflict = resolve
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
	if err := ctx.Err(); err != nil {
		return err
	}
	ws, err := r.runningWorkspace(id)
	if err != nil {
		return err
	}
	ws.daemonAttemptMu.Lock()
	attempt := ws.daemonAttempt
	if attempt == nil {
		if time.Now().Before(ws.daemonRetryAt) {
			err := ws.daemonFailure
			ws.daemonAttemptMu.Unlock()
			return err
		}
		attempt = &daemonAttempt{done: make(chan struct{})}
		ws.daemonAttempt = attempt
		go func() {
			// The attempt belongs to the machine, not the first waiting caller.
			attemptCtx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			err := r.ensureMachined(attemptCtx, id, ws)
			ws.daemonAttemptMu.Lock()
			attempt.err = err
			ws.daemonFailure = err
			if err != nil {
				ws.daemonBackoff = nextDaemonBackoff(ws.daemonBackoff)
				ws.daemonRetryAt = time.Now().Add(ws.daemonBackoff)
			} else {
				ws.daemonBackoff = 0
				ws.daemonRetryAt = time.Time{}
			}
			ws.daemonAttempt = nil
			close(attempt.done)
			ws.daemonAttemptMu.Unlock()
		}()
	}
	ws.daemonAttemptMu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-attempt.done:
		return attempt.err
	}
}

type daemonAttempt struct {
	done chan struct{}
	err  error
}

func nextDaemonBackoff(previous time.Duration) time.Duration {
	if previous == 0 {
		return time.Second
	}
	return min(previous*2, 30*time.Second)
}

func (r *Runtime) ensureMachined(ctx context.Context, id string, ws *workspace) (result error) {
	step := "providers"
	defer func() {
		if result != nil {
			// Only the shared attempt logs; callers rejected by backoff do not.
			slog.Warn("EnsureMachined failed", "machine", ws.Machine, "step", step, "error", result)
		}
	}()
	ws.daemonMu.Lock()
	defer ws.daemonMu.Unlock()
	if current, err := r.runningWorkspace(id); err != nil || current != ws {
		if err != nil {
			return err
		}
		return ErrUnavailable
	}
	if link, err := r.machined.Current(id); err == nil && link.RequireReady(id) == nil {
		step = "secrets"
		if err := r.syncSecretEnvironment(ctx, ws, link); err != nil {
			return err
		}
		r.watchSecretEnvironment(ws, link)
		return nil
	}
	r.mu.Lock()
	headReader := r.machinedHead
	itemReader := r.machinedItem
	conflictReader := r.machinedConflict
	r.mu.Unlock()
	if r.config.Bundle == nil || headReader == nil || itemReader == nil || !r.machined.EventConsumerReady() {
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
	step = "head"
	head, err := headReader(ctx, id)
	if err != nil {
		return err
	}
	if !lowerHex(head, 40) {
		return fmt.Errorf("%w: authoritative branch head unavailable", ErrUnavailable)
	}
	step = "item"
	item, err := itemReader(ctx, id)
	if err != nil {
		return err
	}
	step = "managed-artifact-check"
	currentSFTP, err := r.guest(ctx, ws.Machine, nil, "managed-artifact-check", sftpBundlePath, sftpDigest)
	if err != nil {
		return err
	}
	switch strings.TrimSpace(string(currentSFTP)) {
	case "current":
	case "replace":
		step = "managed-artifact"
		if _, err = r.guest(ctx, ws.Machine, sftp, "managed-artifact", sftpBundlePath, sftpDigest); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: invalid SFTP artifact receipt", ErrUnavailable)
	}
	step = "machined-check"
	current, err := r.guest(ctx, ws.Machine, nil, "machined-check", digest)
	if err != nil {
		return err
	}
	switch strings.TrimSpace(string(current)) {
	case "current":
	case "replace":
		step = "machined-install"
		if _, err = r.guest(ctx, ws.Machine, data, "machined-install", digest); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: invalid machine artifact check", ErrUnavailable)
	}
	step = "boot-authority"
	if ws.daemonBoot == nil {
		authority, err := r.machined.MintBoot(id, ws.Machine)
		if err != nil {
			return err
		}
		ws.daemonBoot = &authority
	}
	bootFile, err := ws.daemonBoot.FileForItem(0, item)
	if err != nil {
		return err
	}
	step = "machined-start"
	state, err := r.guest(ctx, ws.Machine, bootFile, "machined-start", digest)
	if err != nil {
		return err
	}
	if value := strings.TrimSpace(string(state)); value != "started" && value != "current" {
		return fmt.Errorf("%w: invalid machine startup receipt", ErrUnavailable)
	}
	var link *machined.Link
	step = "dial"
	dialCtx, cancelDial := context.WithTimeout(ctx, 10*time.Second)
	defer cancelDial()
	delay := 250 * time.Millisecond
	for {
		stream, dialErr := r.dial(dialCtx, ws.Machine, 970)
		if dialErr == nil {
			link, err = r.machined.Connect(dialCtx, id, stream)
		} else {
			err = dialErr
		}
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if dialCtx.Err() != nil {
			return err
		}
		timer := time.NewTimer(delay)
		delay = min(delay*2, 2*time.Second)
		select {
		case <-dialCtx.Done():
			timer.Stop()
			return err
		case <-timer.C:
		}
	}
	step = "admission"
	var retained *machined.RetainedConflict
	if conflictReader != nil {
		retained, err = conflictReader(ctx, id)
		if err != nil {
			_ = link.Close()
			return err
		}
	}
	if err = r.machined.AdmitReady(ctx, id, head, nil, retained); err != nil {
		_ = link.Close()
		return err
	}
	step = "secrets"
	if err := r.syncSecretEnvironment(ctx, ws, link); err != nil {
		_ = link.Close()
		return err
	}
	r.watchSecretEnvironment(ws, link)
	r.startDaemonReconnect(id, ws, link)
	return nil
}

// One workspace owns the watcher across every replacement link and failed retry.
func (r *Runtime) startDaemonReconnect(id string, ws *workspace, link *machined.Link) {
	ws.daemonAttemptMu.Lock()
	if ws.daemonReconnect {
		ws.daemonAttemptMu.Unlock()
		return
	}
	ws.daemonReconnect = true
	ws.daemonAttemptMu.Unlock()
	go func() {
		defer func() { ws.daemonAttemptMu.Lock(); ws.daemonReconnect = false; ws.daemonAttemptMu.Unlock() }()
		for {
			select {
			case <-link.Done():
			case <-time.After(time.Second):
				if current, err := r.runningWorkspace(id); err != nil || current != ws {
					return
				}
				continue
			}
			for {
				if current, err := r.runningWorkspace(id); err != nil || current != ws {
					return
				}
				ws.daemonAttemptMu.Lock()
				delay := max(time.Until(ws.daemonRetryAt), time.Second)
				ws.daemonAttemptMu.Unlock()
				time.Sleep(delay)
				retry, cancel := context.WithTimeout(context.Background(), 45*time.Second)
				err := r.EnsureMachined(retry, id)
				cancel()
				if err != nil {
					continue
				}
				link, err = r.machined.Current(id)
				if err == nil {
					break
				}
			}
		}
	}()
}
