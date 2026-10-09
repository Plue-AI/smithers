package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// WithCaptureWritersExcluded keeps host admission and the installed guest's
// fixed aggregate writer cgroup fenced until capture, stop and publication end.
// No repository pathname, executable, environment or process selector reaches
// the privileged helper.
func (r *Runtime) WithCaptureWritersExcluded(ctx context.Context, id string, visit func(context.Context) error) error {
	return r.CleanupGate.Exclude(ctx, id, func(ctx context.Context) (resultErr error) {
		r.mu.Lock()
		ws, err := r.workspaceLocked(id)
		if err != nil {
			r.mu.Unlock()
			return err
		}
		stopped, machine, reclaimed := ws.State == string(workspaceapi.WorkspaceStopped), ws.Machine, ws.Reclaimed
		if !stopped && ws.State != string(workspaceapi.WorkspaceRunning) {
			r.mu.Unlock()
			return errors.New("capture machine state unavailable")
		}
		internal := make(map[string]*guestCommand)
		for _, service := range ws.services {
			if service.internal {
				internal[service.command.id] = service.command
			}
		}
		for _, command := range ws.commands {
			if internal[command.id] != nil {
				continue
			}
			if !command.finished() {
				r.mu.Unlock()
				return fmt.Errorf("%w: active command", workspaceapi.ErrCaptureWritersActive)
			}
		}
		if r.terminalHold != nil && r.terminalHold("workspace:"+id) {
			r.mu.Unlock()
			return fmt.Errorf("%w: active terminal", workspaceapi.ErrCaptureWritersActive)
		}
		r.mu.Unlock()
		if stopped {
			if r.cli == nil {
				return ErrUnavailable
			}
			status, found, err := r.cli.sandboxStatus(ctx, machine)
			if err != nil {
				return err
			}
			if found && status != "stopped" || !found && !reclaimed {
				return errors.New("current stopped-machine inventory unavailable")
			}
			return visit(ctx)
		}
		if r.cli == nil {
			return ErrUnavailable
		}
		// Loopback bridges are supervised adapter services, not repository
		// writers. Stop them through their existing trusted handles before
		// freezing the aggregate. Machined's private port-970 link is separate
		// and remains available to deliver capture objects and outbox ACKs.
		defer func() {
			r.mu.Lock()
			running := ws.State == string(workspaceapi.WorkspaceRunning)
			r.mu.Unlock()
			if running {
				restore, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
				defer cancel()
				resultErr = errors.Join(resultErr, r.startBridges(restore, ws))
			}
		}()
		for _, command := range internal {
			if err := command.cancel(); err != nil {
				return err
			}
		}
		callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		command := r.cli.command(guestArgs(machine, nil, true, "final-capture-fence")...)
		command.Stdin = nil // cli's ordinary empty input is replaced by control.
		stdin, err := command.StdinPipe()
		if err != nil {
			return err
		}
		stdout, err := command.StdoutPipe()
		if err != nil {
			_ = stdin.Close()
			return err
		}
		stderr := &limitedBuffer{limit: 4096}
		command.Stderr = stderr
		if err := command.Start(); err != nil {
			_ = stdin.Close()
			return err
		}
		ready := make(chan error, 1)
		go func() {
			var marker [7]byte
			_, err := io.ReadFull(stdout, marker[:])
			if err == nil && string(marker[:]) != "FENCED\n" {
				err = errors.New("guest writer fence unconfirmed")
			}
			ready <- err
		}()
		done := make(chan struct{})
		go func() {
			select {
			case <-callCtx.Done():
				killGroup(command)
			case <-done:
			}
		}()
		fenced := false
		defer func() {
			_ = stdin.Close()
			_ = command.Wait()
			close(done)
			// Wait drains stderr before reading it; EOF alone loses the guest's
			// actual refusal. Never report a busy writer as missing isolation.
			if !fenced && resultErr != nil {
				diagnostic, _ := stderr.text()
				diagnostic = strings.Join(strings.Fields(diagnostic), " ")
				if strings.Contains(diagnostic, "active writer blocks final capture") {
					resultErr = fmt.Errorf("%w: %s", workspaceapi.ErrCaptureWritersActive, diagnostic)
				} else if diagnostic != "" {
					resultErr = fmt.Errorf("final capture fence refused: %s: %w", diagnostic, resultErr)
				}
			}
		}()
		select {
		case err := <-ready:
			if err != nil {
				if callCtx.Err() != nil {
					return callCtx.Err()
				}
				return fmt.Errorf("final capture fence unconfirmed: %w", err)
			}
		case <-callCtx.Done():
			return callCtx.Err()
		}
		fenced = true
		err = visit(callCtx)
		// A successful sleep stops the VM while the helper still holds the
		// freeze. Otherwise release explicitly, leaving the original disk.
		_, _ = stdin.Write([]byte("R"))
		return err
	})
}
