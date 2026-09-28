package microsandbox

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// The guest helper ends every command's stderr with this trailer after it has
// reaped the command's cgroup. Its absence means msb or the guest failed, which
// is reported as an error rather than as a command exit.
var exitTrailer = regexp.MustCompile("\x00SMITHERS-EXIT (-?[0-9]+)\x00$")

const outputTailLimit = 64

type limitedBuffer struct {
	mu        sync.Mutex
	bytes     []byte
	limit     int
	discarded int // Saturates above the longest trailer retained in tail.
	tail      []byte
}

func (b *limitedBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	kept := min(len(value), max(0, b.limit-len(b.bytes)))
	b.bytes = append(b.bytes, value[:kept]...)
	b.discarded += min(len(value)-kept, outputTailLimit+1-b.discarded)
	if len(value) >= outputTailLimit {
		b.tail = append(b.tail[:0], value[len(value)-outputTailLimit:]...)
	} else {
		b.tail = append(b.tail, value...)
		if len(b.tail) > outputTailLimit {
			b.tail = b.tail[len(b.tail)-outputTailLimit:]
		}
	}
	return len(value), nil
}

func (b *limitedBuffer) text() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.bytes), b.discarded > 0
}

type stderrSnapshot struct {
	text      string
	truncated bool
	exitCode  int
	hasExit   bool
}

// completedStderr projects the guest protocol out of a completed stream without
// consuming it. The output limit applies to diagnostics, not the exit trailer.
func (b *limitedBuffer) completedStderr() stderrSnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	result := stderrSnapshot{text: string(b.bytes), truncated: b.discarded > 0}
	match := exitTrailer.FindSubmatchIndex(b.tail)
	if match == nil {
		return result
	}
	code, err := strconv.Atoi(string(b.tail[match[2]:match[3]]))
	if err != nil {
		return result
	}
	result.exitCode, result.hasExit = code, true
	trailer := len(b.tail) - match[0]
	// Once more than a tail's worth was discarded, the payload alone exceeds
	// the limit. Otherwise the exact discarded count identifies how much of
	// the trailer remains in the captured prefix, including a partial marker.
	if b.discarded <= trailer {
		result.text = string(b.bytes[:len(b.bytes)-(trailer-b.discarded)])
		result.truncated = false
	}
	return result
}

type execRequest struct {
	ID    string            `json:"id"`
	Argv  []string          `json:"argv"`
	Env   map[string]string `json:"env"`
	Cwd   string            `json:"cwd"`
	Root  string            `json:"root"`
	User  string            `json:"user"`
	Stdin string            `json:"stdin,omitempty"`
}

// guestCommand is one `msb exec` client running the helper's exec in a VM.
type guestCommand struct {
	runtime    *Runtime
	machine    string
	id         string
	cmd        *exec.Cmd
	done       chan struct{}
	waitErr    error
	stdout     *limitedBuffer
	stderr     *limitedBuffer
	cancelOnce sync.Once
	terminal   *os.File
}

func (c *guestCommand) finished() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

// cancel kills the client, which ends the guest exec session, then kills the
// command's cgroup so descendants that left the session die too.
func (c *guestCommand) cancel() {
	c.cancelOnce.Do(func() {
		killGroup(c.cmd)
		select {
		case <-c.done:
		case <-time.After(10 * time.Second):
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = c.runtime.guest(ctx, c.machine, nil, "kill", c.id)
	})
}

// result is the command's evidence after it finished.
func (c *guestCommand) result() (workspaceapi.CommandResult, error) {
	stderr := c.stderr.completedStderr()
	stdout, stdoutTruncated := c.stdout.text()
	result := workspaceapi.CommandResult{ExitCode: stderr.exitCode, Stdout: stdout, Stderr: stderr.text, OutputTruncated: stdoutTruncated || stderr.truncated}
	if !stderr.hasExit {
		message := strings.TrimSpace(stderr.text)
		if len(message) > 600 {
			message = message[len(message)-600:]
		}
		return result, fmt.Errorf("%w: the microVM did not report the command's exit (%v): %s", ErrUnavailable, c.waitErr, message)
	}
	return result, nil
}

func newExecID() string {
	token := make([]byte, 12)
	_, _ = rand.Read(token)
	return "x" + hex.EncodeToString(token)
}

// commandDirectory maps a root-relative directory to its guest path. The
// guest helper additionally resolves symlinks and confines it to the root.
func commandDirectory(directory string) (string, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" || directory == "." {
		return guestRoot, nil
	}
	if strings.HasPrefix(directory, "/") || strings.IndexByte(directory, 0) >= 0 {
		return "", errors.New("command directory must be relative to the workspace root")
	}
	cleaned := path.Clean(directory)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("command directory escapes the workspace root")
	}
	return path.Join(guestRoot, cleaned), nil
}

func (r *Runtime) request(command workspaceapi.Command) (execRequest, error) {
	if len(command.Args) == 0 || strings.TrimSpace(command.Args[0]) == "" {
		return execRequest{}, errors.New("command argv is required")
	}
	cwd, err := commandDirectory(command.Directory)
	if err != nil {
		return execRequest{}, err
	}
	env := make(map[string]string, len(r.config.Environment)+len(command.Environment)+8)
	for name, value := range r.config.Environment {
		env[name] = value
	}
	for name, value := range command.Environment {
		if name == "" || strings.ContainsAny(name, "=\x00") || strings.IndexByte(value, 0) >= 0 {
			return execRequest{}, fmt.Errorf("invalid environment variable %q", name)
		}
		env[name] = value
	}
	env["HOME"] = guestHome
	env["USER"] = guestUser
	env["XDG_CONFIG_HOME"] = guestHome + "/.config"
	env["XDG_CACHE_HOME"] = guestHome + "/.cache"
	env["XDG_DATA_HOME"] = guestHome + "/.local/share"
	env["TMPDIR"] = guestTempDir
	env["SMITHERS_WORKSPACE_ROOT"] = guestRoot
	env["SMITHERS_WORKSPACE_STATE_DIR"] = guestStateDir
	return execRequest{ID: newExecID(), Argv: append([]string(nil), command.Args...), Env: env, Cwd: cwd, Root: guestRoot, User: guestUser}, nil
}

// start launches one guest command and registers it with the workspace.
func (r *Runtime) start(ws *workspace, request execRequest) (*guestCommand, error) {
	encoded, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	cmd := r.cli.command(guestArgs(ws.Machine, nil, false, "exec")...)
	cmd.Stdin = bytes.NewReader(encoded)
	command := &guestCommand{runtime: r, machine: ws.Machine, id: request.ID, cmd: cmd, done: make(chan struct{}),
		stdout: &limitedBuffer{limit: r.config.OutputLimit}, stderr: &limitedBuffer{limit: r.config.OutputLimit}}
	cmd.Stdout, cmd.Stderr = command.stdout, command.stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start msb exec: %w", err)
	}
	r.track(ws, command)
	return command, nil
}

func (r *Runtime) track(ws *workspace, command *guestCommand) {
	r.mu.Lock()
	ws.commands[command.id] = command
	r.mu.Unlock()
	go func() {
		command.waitErr = command.cmd.Wait()
		if command.terminal != nil {
			_ = command.terminal.Close()
		}
		close(command.done)
		r.mu.Lock()
		delete(ws.commands, command.id)
		r.mu.Unlock()
	}()
}

func (r *Runtime) acquire(ctx context.Context) error {
	select {
	case r.semaphore <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ErrCommandRunaway marks a command stopped by the runaway guard. Reaching it
// is an incident, not an ordinary failure.
var ErrCommandRunaway = errors.New("command exceeded the runaway time guard")

func (r *Runtime) ExecuteCommand(ctx context.Context, workspaceID string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if err := r.acquire(ctx); err != nil {
		return workspaceapi.CommandResult{}, err
	}
	defer func() { <-r.semaphore }()
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return workspaceapi.CommandResult{}, err
	}
	request, err := r.request(command)
	if err != nil {
		return workspaceapi.CommandResult{}, err
	}
	started, err := r.start(ws, request)
	if err != nil {
		return workspaceapi.CommandResult{}, err
	}
	guard := time.NewTimer(r.config.CommandTimeout)
	defer guard.Stop()
	select {
	case <-started.done:
		return started.result()
	case <-ctx.Done():
		started.cancel()
		return workspaceapi.CommandResult{}, ctx.Err()
	case <-guard.C:
		started.cancel()
		return workspaceapi.CommandResult{}, fmt.Errorf("%w (%s)", ErrCommandRunaway, r.config.CommandTimeout)
	}
}

type managedService struct {
	spec        workspaceapi.ServiceSpec
	command     *guestCommand
	fingerprint string
	stopped     bool
	internal    bool
}

func serviceFingerprint(spec workspaceapi.ServiceSpec) string {
	if spec.Identity != "" {
		return spec.Identity
	}
	return fmt.Sprintf("%q|%q|%q|%s", spec.Command.Args, spec.Command.Directory, spec.Command.Environment, spec.ReadyAddress)
}

func guestReadyPort(address string) (uint16, string, error) {
	address = strings.TrimSpace(address)
	if address == "" {
		return 0, "", nil
	}
	host, rawPort, err := net.SplitHostPort(address)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		return 0, "", errors.New("service ready address must be loopback host:port")
	}
	port, err := strconv.ParseUint(rawPort, 10, 16)
	if err != nil || port == 0 {
		return 0, "", errors.New("service ready address has an invalid port")
	}
	return uint16(port), net.JoinHostPort(host, rawPort), nil
}

func (r *Runtime) StartService(ctx context.Context, workspaceID string, spec workspaceapi.ServiceSpec) (workspaceapi.Service, error) {
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	return r.startService(ctx, ws, spec, false)
}

// startService launches a supervised guest service. Internal services (the
// host bridge) are started while the workspace is still booting and are not
// listed to product code.
func (r *Runtime) startService(ctx context.Context, ws *workspace, spec workspaceapi.ServiceSpec, internal bool) (workspaceapi.Service, error) {
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
	_, address, err := guestReadyPort(spec.ReadyAddress)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	spec.ReadyAddress = address
	fingerprint := serviceFingerprint(spec)
	r.mu.Lock()
	if existing := ws.services[name]; existing != nil {
		if existing.command.finished() {
			delete(ws.services, name)
		} else if existing.fingerprint != fingerprint {
			r.mu.Unlock()
			return workspaceapi.Service{}, fmt.Errorf("service %q is already running with different configuration", name)
		} else {
			r.mu.Unlock()
			if err := r.waitForService(ctx, ws, existing.spec, existing.command); err != nil {
				return workspaceapi.Service{}, err
			}
			return workspaceapi.Service{Name: name, Address: existing.spec.ReadyAddress}, nil
		}
	}
	r.mu.Unlock()
	request, err := r.request(spec.Command)
	if err != nil {
		return workspaceapi.Service{}, err
	}
	started, err := r.start(ws, request)
	if err != nil {
		return workspaceapi.Service{}, fmt.Errorf("start workspace service %q: %w", name, err)
	}
	r.mu.Lock()
	ws.services[name] = &managedService{spec: spec, command: started, fingerprint: fingerprint, internal: internal}
	r.mu.Unlock()
	if err := r.waitForService(ctx, ws, spec, started); err != nil {
		started.cancel()
		return workspaceapi.Service{}, err
	}
	return workspaceapi.Service{Name: name, Address: address}, nil
}

// outputTail is the end of a failed service's output, without the helper's
// exit trailer, for its startup error.
func outputTail(output string) string {
	output = strings.TrimSpace(exitTrailer.ReplaceAllString(output, ""))
	if len(output) > 2048 {
		output = "…" + output[len(output)-2048:]
	}
	return output
}

// waitForService accepts a service once its ready port accepts a connection
// inside the guest, or at once when it declares no port and is still running.
func (r *Runtime) waitForService(ctx context.Context, ws *workspace, spec workspaceapi.ServiceSpec, command *guestCommand) error {
	port, _, err := guestReadyPort(spec.ReadyAddress)
	if err != nil {
		return err
	}
	if port == 0 {
		if command.finished() {
			return fmt.Errorf("workspace service %q exited during startup", spec.Name)
		}
		return nil
	}
	readyCtx, cancel := context.WithTimeout(ctx, spec.ReadyTimeout)
	defer cancel()
	for {
		if command.finished() {
			stdout, _ := command.stdout.text()
			stderr, _ := command.stderr.text()
			return fmt.Errorf("workspace service %q exited before accepting connections: %s", spec.Name, outputTail(stdout+"\n"+stderr))
		}
		if _, err := r.cli.run(readyCtx, nil, guestArgs(ws.Machine, nil, false, "probe", strconv.Itoa(int(port)))...); err == nil {
			return nil
		}
		select {
		case <-readyCtx.Done():
			return fmt.Errorf("workspace service %q readiness: %w", spec.Name, readyCtx.Err())
		case <-command.done:
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func observe(service *managedService) workspaceapi.ServiceObservation {
	result := workspaceapi.ServiceObservation{Service: workspaceapi.Service{Name: service.spec.Name, Address: service.spec.ReadyAddress}, State: workspaceapi.ServiceRunning}
	var stderr string
	var stderrTruncated bool
	if service.command.finished() {
		snapshot := service.command.stderr.completedStderr()
		stderr, stderrTruncated = snapshot.text, snapshot.truncated
		switch {
		case service.stopped:
			result.State = workspaceapi.ServiceStopped
		case !snapshot.hasExit || snapshot.exitCode != 0:
			result.State = workspaceapi.ServiceFailed
		default:
			result.State = workspaceapi.ServiceExited
		}
		result.ExitCode = snapshot.exitCode
	} else {
		stderr, stderrTruncated = service.command.stderr.text()
	}
	stdout, stdoutTruncated := service.command.stdout.text()
	result.Stdout, result.Stderr, result.OutputTruncated = stdout, stderr, stdoutTruncated || stderrTruncated
	return result
}

func (r *Runtime) InspectService(ctx context.Context, workspaceID, name string) (workspaceapi.ServiceObservation, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.ServiceObservation{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		return workspaceapi.ServiceObservation{}, err
	}
	service := ws.services[strings.TrimSpace(name)]
	if service == nil || service.internal {
		return workspaceapi.ServiceObservation{}, fmt.Errorf("service %q is not found", name)
	}
	return observe(service), nil
}

// ListServices returns bounded observations of the workspace's services.
func (r *Runtime) ListServices(ctx context.Context, workspaceID string) ([]workspaceapi.ServiceObservation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(ws.services))
	for name, service := range ws.services {
		if !service.internal {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	result := make([]workspaceapi.ServiceObservation, 0, len(names))
	for _, name := range names {
		result = append(result, observe(ws.services[name]))
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
	service := ws.services[strings.TrimSpace(name)]
	if service == nil {
		r.mu.Unlock()
		return nil
	}
	service.stopped = true
	r.mu.Unlock()
	service.command.cancel()
	return nil
}

// ManageService preserves start/stop/restart semantics for the common service.
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
	if managed == nil || managed.internal {
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
		if observed, err := r.InspectService(ctx, workspaceID, name); err == nil && observed.State == workspaceapi.ServiceRunning {
			return observed, nil
		}
	}
	if _, err := r.StartService(ctx, workspaceID, spec); err != nil {
		return workspaceapi.ServiceObservation{}, err
	}
	return r.InspectService(ctx, workspaceID, name)
}

type terminal struct {
	command   *guestCommand
	file      *os.File
	closeOnce sync.Once
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
	t.closeOnce.Do(func() { t.command.cancel() })
	return nil
}

// OpenWorkspaceTerminal opens a guest PTY: `msb exec -t` under a host PTY.
func (r *Runtime) OpenWorkspaceTerminal(ctx context.Context, workspaceID string, command workspaceapi.Command) (workspaceapi.Terminal, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(command.Args) == 0 {
		command.Args = []string{"/bin/bash", "-l"}
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return nil, err
	}
	request, err := r.request(command)
	if err != nil {
		return nil, err
	}
	request.Stdin = "inherit"
	request.Env["TERM"] = "xterm-256color"
	encoded, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if _, err := r.guest(ctx, ws.Machine, encoded, "put-request", request.ID); err != nil {
		return nil, err
	}
	args := []string{"exec", "-t", ws.Machine, "--", "python3", guestHelperPath, "exec", "--request", request.ID}
	cmd := r.cli.command(args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
	file, err := pty.StartWithAttrs(cmd, &pty.Winsize{Cols: 80, Rows: 24}, cmd.SysProcAttr)
	if err != nil {
		return nil, fmt.Errorf("start workspace terminal: %w", err)
	}
	started := &guestCommand{runtime: r, machine: ws.Machine, id: request.ID, cmd: cmd, done: make(chan struct{}),
		stdout: &limitedBuffer{limit: 0}, stderr: &limitedBuffer{limit: 0}, terminal: file}
	r.track(ws, started)
	result := &terminal{command: started, file: file}
	go func() {
		select {
		case <-ctx.Done():
			_ = result.Close()
		case <-started.done:
		}
	}()
	return result, nil
}
