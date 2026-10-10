package microsandbox

import (
	"context"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
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
			err := daemonBackoffRefusal{cause: ws.daemonFailure}
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

// daemonBackoffRefusal is the failed attempt's error, repeated to a caller
// inside the backoff without a new attempt. It reads as that failure, and
// errors.Is finds both the failure and workspaceapi.ErrMachineBackoff, so a
// caller that bounds failed attempts does not count it again (#3773).
type daemonBackoffRefusal struct{ cause error }

func (refusal daemonBackoffRefusal) Error() string { return refusal.cause.Error() }
func (refusal daemonBackoffRefusal) Unwrap() []error {
	return []error{workspaceapi.ErrMachineBackoff, refusal.cause}
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
			if step == "dial" || step == "admission" {
				go r.logDaemonReport(ws)
			}
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
	// Dependency linking is machine preparation, not a person's edit. The
	// repository receipt is written only after linking succeeds; do not start
	// the watcher (or attribute changes to a run) before that boundary.
	r.mu.Lock()
	needsEnvironmentReceipt := len(ws.Link) > 0
	r.mu.Unlock()
	if needsEnvironmentReceipt {
		step = "environment-receipt"
		if _, err := r.ReadRepositoryReceipt(ctx, id); err != nil {
			return fmt.Errorf("%w: workspace environment is not prepared: %v", ErrUnavailable, err)
		}
	}
	step = "providers"
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
			// The link also ends when its daemon exits: log the broker's record.
			if current, err := r.runningWorkspace(id); err == nil && current == ws {
				r.logDaemonReport(ws)
			}
			lost := time.Now()
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
					if time.Since(lost) >= r.config.DaemonLossLimit && r.stopDaemonLost(id, ws, time.Since(lost), err) {
						return
					}
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

// stopDaemonLost stops a running machine whose daemon stayed unreachable past
// DaemonLossLimit, so it no longer holds an admission slot (#3385). The stop
// retains the disk and every unverified write on it, as an idle stop does;
// the next start recovers them through a new daemon. It reports whether the
// machine stopped.
func (r *Runtime) stopDaemonLost(id string, ws *workspace, lost time.Duration, cause error) bool {
	r.logDaemonReport(ws)
	slog.Warn("machine daemon lost; stopping the machine to release its slot",
		"machine", ws.Machine, "for", lost.Round(time.Second).String(), "error", cause)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := r.StopWorkspace(ctx, id); err != nil {
		slog.Warn("stopping a machine without a daemon failed", "machine", ws.Machine, "error", err)
		return false
	}
	return true
}

// logDaemonReport logs the newest lines of the guest's daemon.log: the
// broker's record of each daemon exit and the daemon's last stderr. A failed
// dial or admission usually means the daemon is gone, and its stderr reaches
// no host log otherwise (#3385). Each distinct report is logged once.
func (r *Runtime) logDaemonReport(ws *workspace) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := r.guest(ctx, ws.Machine, nil, "daemon-log")
	report := daemonReportTail(string(output), 12)
	if err != nil || report == "" {
		return
	}
	ws.daemonAttemptMu.Lock()
	changed := ws.daemonReport != report
	ws.daemonReport = report
	ws.daemonAttemptMu.Unlock()
	if changed {
		slog.Warn("machine daemon report", "machine", ws.Machine, "report", report)
	}
}

// daemonReportTail is the last n complete lines of a daemon.log tail.
func daemonReportTail(text string, n int) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	// A full 8 KiB tail can start inside a line.
	if len(text) >= 8192 && len(lines) > 1 {
		lines = lines[1:]
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}
