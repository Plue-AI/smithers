package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/egressrelay"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Workspace isolation modes. `process` is retained for tests only and cannot
// bind an overridable flow without explicit test configuration. `microvm`
// runs every workspace in a local Microsandbox microVM and refuses to start
// when microVMs are unavailable; it never falls back.
const (
	isolationOff     = "off"
	isolationProcess = "process"
	isolationMicroVM = "microvm"
)

type executionRuntimes struct {
	profile *microsandbox.HostProfile
	// workspace executes every workspace, command, service and Flow host.
	workspace workspaceapi.WorkspaceRuntime
	// control is the trusted runtime for the fixed chat model host, which
	// holds owner model credentials and runs no repository code or tools.
	control workspaceapi.WorkspaceRuntime
	// relay is the workspace runtime's egress secret channel.
	relay *egressrelay.Relay
}

func (r executionRuntimes) Close() error {
	err := r.workspace.Close()
	if r.control != nil && r.control != r.workspace {
		err = errors.Join(err, r.control.Close())
	}
	if r.relay != nil {
		err = errors.Join(err, r.relay.Close())
	}
	return err
}

// openEgressRelay starts the workspace runtime's egress secret relay on
// loopback at port (0 picks one). It may dial the backend's own listener, so
// a bound backend credential reaches it through the relay.
func openEgressRelay(port uint16) (*egressrelay.Relay, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))))
	if err != nil {
		return nil, fmt.Errorf("egress relay: %w", err)
	}
	var local []string
	if backend, err := backendPort(); err == nil {
		for _, host := range []string{"127.0.0.1", "localhost"} {
			local = append(local, net.JoinHostPort(host, strconv.Itoa(int(backend))))
		}
	}
	relay, err := egressrelay.New(egressrelay.Config{Listener: listener, Local: local})
	if err != nil {
		return nil, errors.Join(err, listener.Close())
	}
	return relay, nil
}

// egressRelayPort is the relay port microVM guests reach through their
// bridge. Machines keep the route they were built with, so it must not change
// between restarts: SMITHERS_EGRESS_RELAY_PORT, else the backend port + 1.
func egressRelayPort(backend uint16) (uint16, error) {
	raw := strings.TrimSpace(os.Getenv("SMITHERS_EGRESS_RELAY_PORT"))
	if raw == "" {
		if backend == 65535 {
			return 0, errors.New("SMITHERS_EGRESS_RELAY_PORT is required when the backend listens on port 65535")
		}
		return backend + 1, nil
	}
	port, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || port == 0 || uint16(port) == backend {
		return 0, errors.New("SMITHERS_EGRESS_RELAY_PORT must be a free port other than the backend's")
	}
	return uint16(port), nil
}

func workspaceIsolation(allowProcessForTests bool) (string, error) {
	if allowProcessForTests {
		return isolationProcess, nil
	}
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_ISOLATION")))
	switch mode {
	case isolationOff:
		if workspaceapi.PreviewBuild {
			return isolationOff, nil
		}
		fallthrough
	case "":
		return "", fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION must be %q; process isolation is tests-only", isolationMicroVM)
	case isolationMicroVM:
		return isolationMicroVM, nil
	default:
		return "", fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION must be %q; process isolation is tests-only", isolationMicroVM)
	}
}

// openExecutionRuntimes composes the workspace runtime. hostBundle is the
// directory of the packaged Flow hosts; in microvm mode its files are planted
// in a guest when a host or the helper it names runs there.
func openExecutionRuntimes(ctx context.Context, dataRoot, hostBundle string, allowProcessForTests bool) (executionRuntimes, error) {
	mode, err := workspaceIsolation(allowProcessForTests)
	if err != nil {
		return executionRuntimes{}, err
	}
	if mode == isolationOff {
		return executionRuntimes{workspace: workspaceapi.NewDisabled()}, nil
	}
	if mode == isolationProcess {
		relay, err := openEgressRelay(0)
		if err != nil {
			return executionRuntimes{}, err
		}
		runtime, err := process.New(process.Config{Root: filepath.Join(dataRoot, "workspaces"), EgressRelay: relay})
		if err != nil {
			return executionRuntimes{}, errors.Join(fmt.Errorf("start local workspace runtime: %w", err), relay.Close())
		}
		return executionRuntimes{workspace: runtime, control: runtime, relay: relay}, nil
	}
	config, err := microVMConfig(dataRoot, hostBundle)
	if err != nil {
		return executionRuntimes{}, err
	}
	relayPort, err := egressRelayPort(config.HostPorts[0])
	if err != nil {
		return executionRuntimes{}, err
	}
	relay, err := openEgressRelay(relayPort)
	if err != nil {
		return executionRuntimes{}, err
	}
	config.EgressRelay = relay
	isolated, err := microsandbox.New(ctx, config)
	if err != nil {
		return executionRuntimes{}, errors.Join(fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: %w", err), relay.Close())
	}
	control, err := process.New(process.Config{Root: filepath.Join(dataRoot, "control")})
	if err != nil {
		return executionRuntimes{}, errors.Join(fmt.Errorf("start control runtime: %w", err), isolated.Close(), relay.Close())
	}
	return executionRuntimes{workspace: isolated, control: control, relay: relay, profile: config.HostProfile}, nil
}

// guestHostBundle is where a guest receives the packaged Flow host files.
const guestHostBundle = "/opt/smithers/hosts"

func microVMConfig(dataRoot, hostBundle string) (microsandbox.Config, error) {
	return microVMConfigWithProfile(dataRoot, hostBundle, microsandbox.Detect)
}

func microVMConfigWithProfile(dataRoot, hostBundle string, detect func(string) (microsandbox.HostProfile, error)) (microsandbox.Config, error) {
	port, err := backendPort()
	if err != nil {
		return microsandbox.Config{}, err
	}
	config := microsandbox.Config{
		CodingHelper: strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY")),
		Binary:       strings.TrimSpace(os.Getenv("SMITHERS_MICROSANDBOX_BIN")),
		Root:         filepath.Join(dataRoot, "microvm"),
		HostPorts:    []uint16{port},
		Environments: &microsandbox.EnvironmentConfig{},
		Artifacts:    map[string]string{hostBundle: guestHostBundle},
	}
	if config.Binary == "" {
		return config, fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: %w: set SMITHERS_MICROSANDBOX_BIN to the msb %s binary",
			microsandbox.ErrUnavailable, microsandbox.RequiredVersion)
	}
	if err := requireGuestHelper(hostBundle); err != nil {
		return config, fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: %w", err)
	}
	profile, err := detect(dataRoot)
	if err != nil {
		var typed *microsandbox.HostProfileError
		if !errors.As(err, &typed) {
			err = &microsandbox.HostProfileError{Field: "detection", Cause: err}
		}
		return config, fmt.Errorf("microVM refuses to start: %w", err)
	}
	if !profile.Hypervisor {
		return config, fmt.Errorf("%w: Hypervisor.framework unavailable", microsandbox.ErrUnavailable)
	}
	sizing := microsandbox.ComputeSizing(profile)
	config.HostProfile = &profile
	config.CPUs, config.MemoryMiB, config.DiskMiB, config.MaxRunningVMs = sizing.CPUs, sizing.MemoryMiB, int(microsandbox.MachineDiskBytes>>20), sizing.Capacity
	config.Environments = &microsandbox.EnvironmentConfig{PrepareCPUs: config.CPUs, PrepareMemoryMiB: config.MemoryMiB, PrepareDiskMiB: config.DiskMiB, LayerBudgetBytes: sizing.LayerBudgetBytes, MinFreeBytes: microsandbox.MinFreeDiskBytes}
	return config, nil
}

// requireGuestHelper refuses a coding host that could not run in a guest:
// the workspace helper it uses must be a Linux executable in the host bundle,
// which is planted beside the host.
func requireGuestHelper(hostBundle string) error {
	helper := strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"))
	if hostBundle == "" || !filepath.IsAbs(hostBundle) {
		return errors.New("the Flow host bundle directory is required")
	}
	relative, err := filepath.Rel(hostBundle, helper)
	if helper == "" || !filepath.IsAbs(helper) || err != nil || relative == "." || strings.HasPrefix(relative, "..") {
		return fmt.Errorf("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY must name the Linux smithers-jj-export in %s", hostBundle)
	}
	file, err := os.Open(helper)
	if err != nil {
		return fmt.Errorf("guest workspace helper: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	header := make([]byte, 20)
	if err == nil {
		_, err = io.ReadFull(file, header)
	}
	// ELF, 64-bit, little-endian, e_machine EM_AARCH64 (183).
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 ||
		string(header[:4]) != "\x7fELF" || header[4] != 2 || header[5] != 1 || binary.LittleEndian.Uint16(header[18:20]) != 183 {
		return fmt.Errorf("guest workspace helper %s is not a Linux arm64 executable", helper)
	}
	return nil
}

// backendPort is the port guests reach at 127.0.0.1 through the bridge: the
// product API, Git origin and model proxy the local Flow composition uses.
func backendPort() (uint16, error) {
	address := strings.TrimSpace(os.Getenv("SMITHERS_SERVER_ADDR"))
	if address == "" {
		address = ":4000"
	}
	_, raw, err := net.SplitHostPort(address)
	if err != nil {
		return 0, fmt.Errorf("SMITHERS_SERVER_ADDR: %w", err)
	}
	port, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || port == 0 {
		return 0, errors.New("SMITHERS_WORKSPACE_ISOLATION=microvm needs a fixed SMITHERS_SERVER_ADDR port")
	}
	return uint16(port), nil
}

// runMicroVM serves `smithers-backend microvm doctor`: read-only checks of
// Microsandbox, this installation's machines and layers, and the disk floor.
func runMicroVM(ctx context.Context, args []string) error {
	if len(args) != 1 || args[0] != "doctor" {
		return errors.New("usage: smithers-backend microvm doctor")
	}
	dataRoot := strings.TrimSpace(os.Getenv("SMITHERS_DATA_ROOT"))
	if dataRoot == "" {
		return errors.New("SMITHERS_DATA_ROOT is required")
	}
	config := microsandbox.Config{Binary: strings.TrimSpace(os.Getenv("SMITHERS_MICROSANDBOX_BIN")), Root: filepath.Join(dataRoot, "microvm"),
		Environments: &microsandbox.EnvironmentConfig{}}
	config.Environments.MinFreeBytes = microsandbox.MinFreeDiskBytes
	failed := false
	for _, line := range microsandbox.Doctor(ctx, config) {
		status := "ok  "
		if !line.OK {
			status, failed = "FAIL", true
		}
		fmt.Printf("%s %-9s %s\n", status, line.Name, line.Detail)
	}
	if failed {
		return errors.New("microVM isolation is not ready")
	}
	return nil
}
