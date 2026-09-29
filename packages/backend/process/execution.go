package process

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type limitedBuffer struct {
	mu        sync.Mutex
	bytes     []byte
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - len(b.bytes)
	if remaining > 0 {
		copyLength := len(value)
		if copyLength > remaining {
			copyLength = remaining
		}
		b.bytes = append(b.bytes, value[:copyLength]...)
	}
	if len(value) > remaining {
		b.truncated = true
	}
	return len(value), nil
}

func (b *limitedBuffer) result() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.bytes), b.truncated
}

type managedProcess struct {
	cmd      *exec.Cmd
	done     chan struct{}
	waitErr  error
	stopOnce sync.Once
}

func startManaged(cmd *exec.Cmd) (*managedProcess, error) {
	prepareProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return reap(cmd), nil
}

func reap(cmd *exec.Cmd) *managedProcess {
	process := &managedProcess{cmd: cmd, done: make(chan struct{})}
	go func() {
		process.waitErr = cmd.Wait()
		// Descendants can outlive the leader, even when they have closed its
		// output pipes. Retire the owned group before callers observe exit.
		_ = killProcessGroup(cmd)
		close(process.done)
	}()
	return process
}

func (p *managedProcess) stop(grace time.Duration) {
	p.stopOnce.Do(func() {
		select {
		case <-p.done:
			return
		default:
		}
		_ = signalProcessGroup(p.cmd)
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case <-p.done:
			return
		case <-timer.C:
			_ = killProcessGroup(p.cmd)
			<-p.done
		}
	})
}

func (r *Runtime) acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case r.semaphore <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Runtime) ExecuteCommand(ctx context.Context, workspaceID string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if err := r.acquire(ctx); err != nil {
		return workspaceapi.CommandResult{}, errors.Join(err, workspaceapi.ErrCommandCancelled)
	}
	defer func() { <-r.semaphore }()
	stdout := &limitedBuffer{limit: r.outputLimit}
	stderr := &limitedBuffer{limit: r.outputLimit}
	r.mu.Lock()
	if err := ctx.Err(); err != nil {
		r.mu.Unlock()
		return workspaceapi.CommandResult{}, errors.Join(err, workspaceapi.ErrCommandCancelled)
	}
	ws, err := r.runningWorkspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.CommandResult{}, err
	}
	cmd, err := r.commandLocked(ws, command)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.CommandResult{}, err
	}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	process, err := startManaged(cmd)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.CommandResult{}, fmt.Errorf("start workspace command: %w", err)
	}
	r.registerLocked(ws, process)
	r.mu.Unlock()
	defer r.unregister(workspaceID, process)

	select {
	case <-process.done:
	case <-ctx.Done():
		select {
		case <-process.done:
			// Preserve a completion that raced cancellation.
		default:
			process.stop(r.grace)
			return workspaceapi.CommandResult{}, errors.Join(ctx.Err(), workspaceapi.ErrCommandCancelled)
		}
	}
	out, outTruncated := stdout.result()
	errout, errTruncated := stderr.result()
	result := workspaceapi.CommandResult{Stdout: out, Stderr: errout, OutputTruncated: outTruncated || errTruncated}
	if process.cmd.ProcessState != nil {
		result.ExitCode = process.cmd.ProcessState.ExitCode()
	}
	var exitError *exec.ExitError
	if process.waitErr != nil && !errors.As(process.waitErr, &exitError) {
		return result, fmt.Errorf("wait for workspace command: %w", process.waitErr)
	}
	return result, nil
}

func serviceFingerprint(spec workspaceapi.ServiceSpec) string {
	if spec.Identity != "" {
		return spec.Identity
	}
	return fmt.Sprintf("%q|%q|%q|%s", spec.Command.Args, spec.Command.Directory, spec.Command.Environment, spec.ReadyAddress)
}

func (r *Runtime) StartService(ctx context.Context, workspaceID string, spec workspaceapi.ServiceSpec) (workspaceapi.Service, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.Service{}, err
	}
	name := strings.TrimSpace(spec.Name)
	if name == "" {
		return workspaceapi.Service{}, errors.New("service name is required")
	}
	if spec.ReadyTimeout <= 0 {
		spec.ReadyTimeout = 15 * time.Second
	}
	readyAddress, err := normalizeReadyAddress(spec.ReadyAddress)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	spec.ReadyAddress = readyAddress
	fingerprint := serviceFingerprint(spec)
	r.mu.Lock()
	if err := ctx.Err(); err != nil {
		r.mu.Unlock()
		return workspaceapi.Service{}, err
	}
	ws, err := r.runningWorkspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.Service{}, err
	}
	if existing := ws.services[name]; existing != nil {
		select {
		case <-existing.process.done:
			delete(ws.services, name)
			delete(ws.processes, existing.process)
		default:
			if existing.fingerprint != fingerprint {
				r.mu.Unlock()
				return workspaceapi.Service{}, fmt.Errorf("service %q is already running with different configuration", name)
			}
			service := workspaceapi.Service{Name: name, PID: existing.process.cmd.Process.Pid, Address: existing.spec.ReadyAddress}
			r.mu.Unlock()
			if err := waitForServiceReady(ctx, existing.spec, existing.process); err != nil {
				return workspaceapi.Service{}, err
			}
			return service, nil
		}
	}
	cmd, err := r.commandLocked(ws, spec.Command)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.Service{}, err
	}
	stdout := &limitedBuffer{limit: r.outputLimit}
	stderr := &limitedBuffer{limit: r.outputLimit}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	process, err := startManaged(cmd)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.Service{}, fmt.Errorf("start workspace service %q: %w", name, err)
	}
	managed := &managedService{spec: spec, process: process, fingerprint: fingerprint, stdout: stdout, stderr: stderr}
	ws.services[name] = managed
	r.registerLocked(ws, process)
	r.mu.Unlock()
	go func() {
		<-process.done
		r.unregister(workspaceID, process)
	}()

	if err := waitForServiceReady(ctx, spec, process); err != nil {
		process.stop(r.grace)
		return workspaceapi.Service{}, err
	}
	return workspaceapi.Service{Name: name, PID: process.cmd.Process.Pid, Address: readyAddress}, nil
}

func waitForServiceReady(ctx context.Context, spec workspaceapi.ServiceSpec, process *managedProcess) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if spec.ReadyAddress != "" {
		readyCtx, cancel := context.WithTimeout(ctx, spec.ReadyTimeout)
		defer cancel()
		if err := waitForTCP(readyCtx, spec.ReadyAddress, process); err != nil {
			return fmt.Errorf("workspace service %q readiness: %w", spec.Name, err)
		}
		return nil
	}
	select {
	case <-process.done:
		if process.waitErr != nil {
			return fmt.Errorf("workspace service %q exited during startup: %w", spec.Name, process.waitErr)
		}
		return fmt.Errorf("workspace service %q exited during startup", spec.Name)
	default:
		return nil
	}
}

func normalizeReadyAddress(address string) (string, error) {
	address = strings.TrimSpace(address)
	if address == "" {
		return "", nil
	}
	host, rawPort, err := net.SplitHostPort(address)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		return "", errors.New("service ready address must be loopback host:port")
	}
	parsedPort, err := strconv.ParseUint(rawPort, 10, 16)
	if err != nil || parsedPort == 0 {
		return "", errors.New("service ready address has an invalid port")
	}
	return net.JoinHostPort(host, strconv.FormatUint(parsedPort, 10)), nil
}

func (r *Runtime) InspectService(ctx context.Context, workspaceID, name string) (workspaceapi.ServiceObservation, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.ServiceObservation{}, err
	}
	r.mu.Lock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.ServiceObservation{}, err
	}
	service := ws.services[strings.TrimSpace(name)]
	if service == nil {
		r.mu.Unlock()
		return workspaceapi.ServiceObservation{}, fmt.Errorf("service %q is not found", name)
	}
	process := service.process
	result := workspaceapi.ServiceObservation{Service: workspaceapi.Service{Name: service.spec.Name, PID: process.cmd.Process.Pid, Address: service.spec.ReadyAddress}, State: workspaceapi.ServiceRunning}
	select {
	case <-process.done:
		switch {
		case service.stopped:
			result.State = workspaceapi.ServiceStopped
		case process.cmd.ProcessState != nil && process.cmd.ProcessState.ExitCode() != 0:
			result.State = workspaceapi.ServiceFailed
		default:
			result.State = workspaceapi.ServiceExited
		}
		if process.cmd.ProcessState != nil {
			result.ExitCode = process.cmd.ProcessState.ExitCode()
		}
	default:
	}
	r.mu.Unlock()
	stdout, stdoutTruncated := service.stdout.result()
	stderr, stderrTruncated := service.stderr.result()
	result.Stdout, result.Stderr, result.OutputTruncated = stdout, stderr, stdoutTruncated || stderrTruncated
	return result, nil
}

// ListServices returns bounded observations for processes owned by one
// workspace. It does not inspect unrelated host processes.
func (r *Runtime) ListServices(ctx context.Context, workspaceID string) ([]workspaceapi.ServiceObservation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r.mu.Lock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return nil, err
	}
	names := make([]string, 0, len(ws.services))
	for name := range ws.services {
		names = append(names, name)
	}
	r.mu.Unlock()
	sort.Strings(names)
	result := make([]workspaceapi.ServiceObservation, 0, len(names))
	for _, name := range names {
		observed, inspectErr := r.InspectService(ctx, workspaceID, name)
		if inspectErr != nil {
			return nil, inspectErr
		}
		result = append(result, observed)
	}
	return result, nil
}

func (r *Runtime) StopService(ctx context.Context, workspaceID, name string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	trimmedName := strings.TrimSpace(name)
	service := ws.services[trimmedName]
	if service == nil {
		r.mu.Unlock()
		return nil
	}
	service.stopped = true
	r.mu.Unlock()
	service.process.stop(r.grace)
	r.unregister(workspaceID, service.process)
	return nil
}

func (r *Runtime) ManageService(ctx context.Context, workspaceID, name, action string) (workspaceapi.ServiceObservation, error) {
	name = strings.TrimSpace(name)
	action = strings.ToLower(strings.TrimSpace(action))
	if action != "start" && action != "stop" && action != "restart" {
		return workspaceapi.ServiceObservation{}, errors.New("service action must be start, stop, or restart")
	}
	r.mu.Lock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return workspaceapi.ServiceObservation{}, err
	}
	managed := ws.services[name]
	if managed == nil {
		r.mu.Unlock()
		return workspaceapi.ServiceObservation{}, fmt.Errorf("service %q is not found", name)
	}
	spec := managed.spec
	r.mu.Unlock()

	if action == "stop" || action == "restart" {
		if err := r.StopService(ctx, workspaceID, name); err != nil {
			return workspaceapi.ServiceObservation{}, err
		}
		if action == "stop" {
			return r.InspectService(ctx, workspaceID, name)
		}
	}
	if action == "start" {
		observed, inspectErr := r.InspectService(ctx, workspaceID, name)
		if inspectErr == nil && observed.State == workspaceapi.ServiceRunning {
			return observed, nil
		}
	}
	if _, err := r.StartService(ctx, workspaceID, spec); err != nil {
		return workspaceapi.ServiceObservation{}, err
	}
	return r.InspectService(ctx, workspaceID, name)
}

func waitForTCP(ctx context.Context, address string, process *managedProcess) error {
	dialer := net.Dialer{Timeout: 100 * time.Millisecond}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		connection, err := dialer.DialContext(ctx, "tcp", address)
		if err == nil {
			_ = connection.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-process.done:
			// The exit status names the cause for an operator; stderr stays in
			// InspectService, never in this error.
			if process.waitErr != nil {
				return fmt.Errorf("process exited before accepting connections: %w", process.waitErr)
			}
			return errors.New("process exited before accepting connections")
		case <-ticker.C:
		}
	}
}

type terminal struct {
	file      *os.File
	process   *managedProcess
	grace     time.Duration
	closeOnce sync.Once
	onClose   func()
}

func (t *terminal) Read(buffer []byte) (int, error)  { return t.file.Read(buffer) }
func (t *terminal) Write(buffer []byte) (int, error) { return t.file.Write(buffer) }
func (t *terminal) Resize(ctx context.Context, columns, rows uint16) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return pty.Setsize(t.file, &pty.Winsize{Cols: columns, Rows: rows})
}
func (t *terminal) Close() error {
	var closeErr error
	t.closeOnce.Do(func() {
		closeErr = t.file.Close()
		t.process.stop(t.grace)
		if t.onClose != nil {
			t.onClose()
		}
	})
	return closeErr
}

func (r *Runtime) OpenWorkspaceTerminal(ctx context.Context, workspaceID string, command workspaceapi.Command) (workspaceapi.Terminal, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(command.Args) == 0 {
		command.Args = []string{"/bin/sh"}
	}
	r.mu.Lock()
	if err := ctx.Err(); err != nil {
		r.mu.Unlock()
		return nil, err
	}
	ws, err := r.runningWorkspaceLocked(workspaceID)
	if err != nil {
		r.mu.Unlock()
		return nil, err
	}
	cmd, err := r.commandLocked(ws, command)
	if err != nil {
		r.mu.Unlock()
		return nil, err
	}
	file, err := startPTY(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		r.mu.Unlock()
		return nil, fmt.Errorf("start workspace terminal: %w", err)
	}
	process := reap(cmd)
	r.registerLocked(ws, process)
	r.mu.Unlock()
	result := &terminal{file: file, process: process, grace: r.grace,
		onClose: func() { r.unregister(workspaceID, process) }}
	go func() {
		<-process.done
		r.unregister(workspaceID, process)
	}()
	if ctx.Done() != nil {
		go func() {
			select {
			case <-ctx.Done():
				_ = result.Close()
			case <-process.done:
			}
		}()
	}
	return result, nil
}

func (r *Runtime) PreviewTarget(ctx context.Context, workspaceID string, port uint16) (workspaceapi.PreviewTarget, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.PreviewTarget{}, err
	}
	if port == 0 {
		return workspaceapi.PreviewTarget{}, errors.New("preview port is required")
	}
	r.mu.Lock()
	ws, err := r.runningWorkspaceLocked(workspaceID)
	if err == nil {
		owned := false
		for _, service := range ws.services {
			_, rawPort, splitErr := net.SplitHostPort(service.spec.ReadyAddress)
			servicePort, portErr := strconv.ParseUint(rawPort, 10, 16)
			if splitErr != nil || portErr != nil || uint16(servicePort) != port {
				continue
			}
			select {
			case <-service.process.done:
			default:
				owned = true
			}
			if owned {
				break
			}
		}
		if !owned {
			err = fmt.Errorf("workspace preview port %d has no running managed service", port)
		}
	}
	r.mu.Unlock()
	if err != nil {
		return workspaceapi.PreviewTarget{}, err
	}
	return workspaceapi.PreviewTarget{URL: (&url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", fmt.Sprint(port))}).String()}, nil
}
