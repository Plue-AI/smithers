package microsandbox

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// relayConn is a byte stream to a guest loopback port, carried by an
// `msb exec --stream` running the helper's relay. No guest port is published
// on the host network.
type relayConn struct {
	cmd       *exec.Cmd
	reader    *os.File
	writer    *os.File
	done      chan struct{}
	closeOnce sync.Once
	port      uint16
}

type relayAddr string

func (a relayAddr) Network() string { return "microsandbox" }
func (a relayAddr) String() string  { return string(a) }

func (c *relayConn) Read(buffer []byte) (int, error)  { return c.reader.Read(buffer) }
func (c *relayConn) Write(buffer []byte) (int, error) { return c.writer.Write(buffer) }
func (c *relayConn) CloseWrite() error                { return c.writer.Close() }
func (c *relayConn) LocalAddr() net.Addr              { return relayAddr("backend") }
func (c *relayConn) RemoteAddr() net.Addr             { return relayAddr("guest:" + strconv.Itoa(int(c.port))) }
func (c *relayConn) SetDeadline(t time.Time) error {
	return errors.Join(c.reader.SetReadDeadline(t), c.writer.SetWriteDeadline(t))
}
func (c *relayConn) SetReadDeadline(t time.Time) error  { return c.reader.SetReadDeadline(t) }
func (c *relayConn) SetWriteDeadline(t time.Time) error { return c.writer.SetWriteDeadline(t) }
func (c *relayConn) Close() error {
	c.closeOnce.Do(func() {
		_ = c.writer.Close()
		killGroup(c.cmd)
		<-c.done
		_ = c.reader.Close()
	})
	return nil
}

// DialWorkspacePort opens a private stream to a guest loopback port.
func (r *Runtime) DialWorkspacePort(ctx context.Context, workspaceID string, request workspaceapi.PortRequest) (net.Conn, error) {
	if request.Port == 0 {
		return nil, errors.New("workspace port is required")
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return nil, err
	}
	return r.dial(ctx, ws.Machine, request.Port)
}

func (r *Runtime) dial(ctx context.Context, machine string, port uint16) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	stdinReader, stdinWriter, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
		return nil, err
	}
	cmd := r.cli.command(guestArgs(machine, nil, true, "relay", strconv.Itoa(int(port)))...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinReader, stdoutWriter, io.Discard
	if err := cmd.Start(); err != nil {
		for _, file := range []*os.File{stdinReader, stdinWriter, stdoutReader, stdoutWriter} {
			_ = file.Close()
		}
		return nil, fmt.Errorf("%w: open guest port relay: %v", ErrUnavailable, err)
	}
	_ = stdinReader.Close()
	_ = stdoutWriter.Close()
	conn := &relayConn{cmd: cmd, reader: stdoutReader, writer: stdinWriter, done: make(chan struct{}), port: port}
	go func() {
		_ = cmd.Wait()
		close(conn.done)
	}()
	return conn, nil
}

// httpClient returns a client whose every connection is a relay into one
// workspace's guest port; the URL host is ignored.
func (r *Runtime) httpClient(workspaceID string, port uint16) *http.Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return r.DialWorkspacePort(ctx, workspaceID, workspaceapi.PortRequest{Port: port, Purpose: workspaceapi.PortPurposeFlowRuntime})
		},
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   false,
	}
	return &http.Client{Transport: transport}
}

// startBridges lets the guest reach the backend's own loopback listeners at
// their unchanged 127.0.0.1 URLs. The VM's network policy allows nothing else.
func (r *Runtime) startBridges(ctx context.Context, ws *workspace) error {
	for _, port := range r.config.HostPorts {
		name := "smithers-host-bridge-" + strconv.Itoa(int(port))
		spec := workspaceapi.ServiceSpec{
			Name:         name,
			Command:      workspaceapi.Command{Args: []string{"python3", guestHelperPath, "bridge", strconv.Itoa(int(port)), "host.microsandbox.internal"}},
			ReadyAddress: net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))),
			ReadyTimeout: 30 * time.Second,
		}
		r.mu.Lock()
		if existing := ws.services[name]; existing != nil && existing.command.finished() {
			delete(ws.services, name)
		}
		r.mu.Unlock()
		if _, err := r.startService(ctx, ws, spec, true); err != nil {
			return fmt.Errorf("start backend bridge in %s: %w", ws.Machine, err)
		}
	}
	return nil
}

type previewListener struct {
	listener net.Listener
	once     sync.Once
}

func (p *previewListener) close() { p.once.Do(func() { _ = p.listener.Close() }) }

// PreviewTarget returns a host loopback upstream for the common authenticated
// preview proxy. Each accepted connection is relayed into the guest port.
func (r *Runtime) PreviewTarget(ctx context.Context, workspaceID string, port uint16) (workspaceapi.PreviewTarget, error) {
	if err := ctx.Err(); err != nil {
		return workspaceapi.PreviewTarget{}, err
	}
	if port == 0 {
		return workspaceapi.PreviewTarget{}, errors.New("preview port is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, err := r.workspaceLocked(workspaceID)
	if err != nil {
		return workspaceapi.PreviewTarget{}, err
	}
	if ws.State != string(workspaceapi.WorkspaceRunning) {
		return workspaceapi.PreviewTarget{}, fmt.Errorf("%w: %s", workspaceapi.ErrWorkspaceStopped, workspaceID)
	}
	owned := false
	for _, service := range ws.services {
		servicePort, _, err := guestReadyPort(service.spec.ReadyAddress)
		if err == nil && !service.internal && servicePort == port && !service.command.finished() {
			owned = true
			break
		}
	}
	if !owned {
		return workspaceapi.PreviewTarget{}, fmt.Errorf("workspace preview port %d has no running managed service", port)
	}
	if existing := ws.previews[port]; existing != nil {
		return workspaceapi.PreviewTarget{URL: "http://" + existing.listener.Addr().String()}, nil
	}
	// The same port number on host loopback, as the process adapter serves
	// it: the product preview proxy requires the upstream to carry the
	// requested port. Two workspaces previewing one port contend exactly as
	// two trusted processes would.
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))))
	if err != nil {
		return workspaceapi.PreviewTarget{}, fmt.Errorf("host loopback port %d for the preview is busy: %w", port, err)
	}
	preview := &previewListener{listener: listener}
	ws.previews[port] = preview
	machine := ws.Machine
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer client.Close()
				upstream, err := r.dial(context.Background(), machine, port)
				if err != nil {
					return
				}
				defer upstream.Close()
				done := make(chan struct{})
				go func() {
					_, _ = io.Copy(upstream, client)
					_ = upstream.(*relayConn).CloseWrite()
					close(done)
				}()
				_, _ = io.Copy(client, upstream)
				<-done
			}()
		}
	}()
	return workspaceapi.PreviewTarget{URL: (&url.URL{Scheme: "http", Host: listener.Addr().String()}).String()}, nil
}

const managedHostStateDirectory = "managed-hosts"

// InspectManagedHost returns an authenticated connection to a live managed
// host. A running service alone is not readiness; the probe must match.
func (r *Runtime) InspectManagedHost(ctx context.Context, workspaceID string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	if err := validateManagedHostSpec(spec); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	r.mu.Lock()
	service := ws.services[spec.Name]
	if service == nil || service.command.finished() {
		r.mu.Unlock()
		return workspaceapi.ManagedHostConnection{}, workspaceapi.ErrManagedHostNotRunning
	}
	if service.fingerprint != spec.Identity {
		r.mu.Unlock()
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("%w: live service configuration differs", workspaceapi.ErrManagedHostIdentityConflict)
	}
	port, _, _ := guestReadyPort(service.spec.ReadyAddress)
	r.mu.Unlock()
	return r.probeManagedHost(ctx, workspaceID, spec, port)
}

// StartManagedHost chooses a free guest loopback port, plants the verified
// host artifact in the guest, builds the command with guest paths, and starts
// it as an ordinary service. The returned client reaches it only by relay.
func (r *Runtime) StartManagedHost(ctx context.Context, workspaceID string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	if err := validateManagedHostSpec(spec); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	if connection, err := r.InspectManagedHost(ctx, workspaceID, spec); err == nil {
		return connection, nil
	} else if !errors.Is(err, workspaceapi.ErrManagedHostNotRunning) {
		return workspaceapi.ManagedHostConnection{}, err
	}
	ws, err := r.runningWorkspace(workspaceID)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	stateDir, err := r.ensureManagedHostState(ctx, workspaceID, spec)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	port, err := r.freeGuestPort(ctx, ws.Machine)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port)))
	command, err := spec.Builder.BuildManagedHost(ctx, workspaceapi.ManagedHostPlacement{
		Workspace: describe(ws), StateDir: stateDir, Host: "127.0.0.1", Port: port, Address: address,
	})
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("build managed host command: %w", err)
	}
	if len(command.Args) == 0 {
		return workspaceapi.ManagedHostConnection{}, errors.New("managed host command is required")
	}
	if command.Args[0], err = r.plantArtifact(ctx, ws.Machine, command.Args[0]); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	timeout := spec.ReadyTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	readyCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if _, err := r.startService(readyCtx, ws, workspaceapi.ServiceSpec{Name: spec.Name, Identity: spec.Identity, Command: command,
		ReadyAddress: address, ReadyTimeout: timeout}, false); err != nil {
		return workspaceapi.ManagedHostConnection{}, err
	}
	connection, err := r.probeManagedHost(readyCtx, workspaceID, spec, port)
	if err != nil {
		_ = r.StopService(context.Background(), workspaceID, spec.Name)
		return workspaceapi.ManagedHostConnection{}, err
	}
	return connection, nil
}

func (r *Runtime) probeManagedHost(ctx context.Context, workspaceID string, spec workspaceapi.ManagedHostSpec, port uint16) (workspaceapi.ManagedHostConnection, error) {
	connection := workspaceapi.ManagedHostConnection{
		Endpoint:   "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))),
		HTTPClient: r.httpClient(workspaceID, port),
	}
	timeout := spec.ReadyTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	observed, err := spec.Probe.ProbeManagedHost(probeCtx, connection)
	if err != nil {
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("probe managed host identity: %w", err)
	}
	if observed != spec.Expected {
		return workspaceapi.ManagedHostConnection{}, fmt.Errorf("%w: protocol, artifact, source revision, or owner generation differs", workspaceapi.ErrManagedHostIdentityConflict)
	}
	return connection, nil
}

func validateManagedHostSpec(spec workspaceapi.ManagedHostSpec) error {
	if strings.TrimSpace(spec.ID) == "" || len(spec.ID) > 512 || strings.IndexByte(spec.ID, 0) >= 0 {
		return errors.New("managed host binding id is required")
	}
	if strings.TrimSpace(spec.Name) == "" || strings.IndexByte(spec.Name, 0) >= 0 {
		return errors.New("managed host service name is required")
	}
	if strings.TrimSpace(spec.Identity) == "" || strings.IndexByte(spec.Identity, 0) >= 0 {
		return errors.New("managed host service identity is required")
	}
	if spec.Builder == nil || spec.Probe == nil {
		return errors.New("managed host builder and identity probe are required")
	}
	identity := spec.Expected
	if strings.TrimSpace(identity.Protocol) == "" || !lowerHex(identity.ArtifactDigest, 64) ||
		!lowerHex(identity.SourceRevision, 40) || identity.OwnerGeneration <= 0 {
		return errors.New("managed host expected identity is invalid")
	}
	return nil
}

func lowerHex(value string, length int) bool {
	if len(value) != length || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// ensureManagedHostState keeps one state directory per binding across owner
// generations, exactly like the process adapter, but in the guest.
func (r *Runtime) ensureManagedHostState(ctx context.Context, workspaceID string, spec workspaceapi.ManagedHostSpec) (string, error) {
	relative := path.Join(managedHostStateDirectory, digest(spec.ID))
	type binding struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	existing, err := r.fileOperation(ctx, workspaceID, guestStateDir, nil, "read", relative+"/binding.json", "65536")
	switch {
	case err == nil:
		var stored binding
		if json.Unmarshal(existing, &stored) != nil || stored.ID != spec.ID {
			return "", errors.New("managed host state belongs to another binding")
		}
		if stored.Name == spec.Name {
			return path.Join(guestStateDir, relative), nil
		}
	case !errors.Is(err, fs.ErrNotExist):
		return "", fmt.Errorf("read managed host state identity: %w", err)
	}
	contents, err := json.Marshal(binding{ID: spec.ID, Name: spec.Name})
	if err != nil {
		return "", err
	}
	if _, err := r.fileOperation(ctx, workspaceID, guestStateDir, append(contents, '\n'), "write", relative+"/binding.json", "600"); err != nil {
		return "", fmt.Errorf("write managed host state identity: %w", err)
	}
	return path.Join(guestStateDir, relative), nil
}

func (r *Runtime) freeGuestPort(ctx context.Context, machine string) (uint16, error) {
	for attempt := 0; attempt < 16; attempt++ {
		var buffer [2]byte
		if _, err := rand.Read(buffer[:]); err != nil {
			return 0, err
		}
		port := uint16(20000 + int(binary.BigEndian.Uint16(buffer[:]))%40000)
		if _, err := r.cli.run(ctx, nil, guestArgs(machine, nil, false, "probe", strconv.Itoa(int(port)))...); err != nil {
			return port, nil
		}
	}
	return 0, errors.New("no free guest port for the managed host")
}

// plantArtifact copies a verified host artifact into the guest and returns
// the guest path. Anything else is returned unchanged: it must already be a
// guest program.
func (r *Runtime) plantArtifact(ctx context.Context, machine, program string) (string, error) {
	for hostDir, guestDir := range r.config.Artifacts {
		relative, err := filepath.Rel(hostDir, program)
		if err != nil || relative == "." || strings.HasPrefix(relative, "..") || filepath.IsAbs(relative) {
			continue
		}
		contents, err := os.ReadFile(program)
		if err != nil {
			return "", fmt.Errorf("read managed host artifact: %w", err)
		}
		sum := sha256.Sum256(contents)
		want := hex.EncodeToString(sum[:])
		target := path.Join(guestDir, filepath.ToSlash(relative))
		script := fmt.Sprintf(`set -e; t=%s; if [ "$(sha256sum "$t" 2>/dev/null | cut -d' ' -f1)" != %s ]; then mkdir -p "$(dirname "$t")"; cat > "$t.tmp"; chmod 0755 "$t.tmp"; mv "$t.tmp" "$t"; fi; test "$(sha256sum "$t" | cut -d' ' -f1)" = %s`,
			shellQuote(target), want, want)
		if _, err := r.cli.run(ctx, contents, "exec", machine, "--", "sh", "-c", script); err != nil {
			return "", fmt.Errorf("%w: plant managed host artifact: %v", ErrUnavailable, err)
		}
		return target, nil
	}
	return program, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

var (
	_ workspaceapi.WorkspaceManagedHosts = (*Runtime)(nil)
	_ workspaceapi.PortDialer            = (*Runtime)(nil)
)
