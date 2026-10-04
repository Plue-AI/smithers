package main

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestProcessIsolationKeepsOneTrustedRuntime(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "")
	runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	defer runtimes.Close()
	if _, ok := runtimes.workspace.(*process.Runtime); !ok || runtimes.control != runtimes.workspace {
		t.Fatalf("process mode composed %T/%T", runtimes.workspace, runtimes.control)
	}
	if runtimes.workspace.Isolation() != workspaceapi.IsolationTrustedProcess {
		t.Fatal("process mode must not claim isolation")
	}
	if runtimes.relay == nil || !runtimes.workspace.Capabilities().EgressSecrets {
		t.Fatal("process mode must offer the egress secret channel")
	}
}

func TestEgressRelayPortIsStable(t *testing.T) {
	t.Setenv("SMITHERS_EGRESS_RELAY_PORT", "")
	if port, err := egressRelayPort(4000); err != nil || port != 4001 {
		t.Fatalf("default relay port = %d, %v", port, err)
	}
	if _, err := egressRelayPort(65535); err == nil {
		t.Fatal("no default past the last port")
	}
	t.Setenv("SMITHERS_EGRESS_RELAY_PORT", "4100")
	if port, err := egressRelayPort(4000); err != nil || port != 4100 {
		t.Fatalf("configured relay port = %d, %v", port, err)
	}
	for _, invalid := range []string{"0", "4000", "70000", "relay"} {
		t.Setenv("SMITHERS_EGRESS_RELAY_PORT", invalid)
		if _, err := egressRelayPort(4000); err == nil {
			t.Fatalf("relay port %q accepted", invalid)
		}
	}
}

// freeRelayPort points the microVM relay at a free loopback port.
func freeRelayPort(t *testing.T) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	_ = listener.Close()
	t.Setenv("SMITHERS_EGRESS_RELAY_PORT", port)
}

// microvm mode never falls back to host processes: a missing, non-executable
// or unqualified msb refuses startup.
func TestMicroVMIsolationRefusesWithoutMicrosandbox(t *testing.T) {
	notMSB := filepath.Join(t.TempDir(), "msb")
	if err := os.WriteFile(notMSB, []byte("#!/bin/sh\necho 'not msb'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, binary := range map[string]string{
		"unset":        "",
		"missing":      filepath.Join(t.TempDir(), "absent", "msb"),
		"relative":     "msb",
		"wrong binary": notMSB,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
			t.Setenv("SMITHERS_MICROSANDBOX_BIN", binary)
			freeRelayPort(t)
			runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), guestBundle(t), false)
			if err == nil {
				_ = runtimes.Close()
				t.Fatal("microvm mode started without Microsandbox")
			}
			if !errors.Is(err, microsandbox.ErrUnavailable) || !strings.Contains(err.Error(), "refuses to start") {
				t.Fatalf("refusal = %v", err)
			}
		})
	}
}

func TestIsolationModeIsValidated(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "container")
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir(), t.TempDir(), false); err == nil {
		t.Fatal("unknown isolation mode accepted")
	}
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", ":0")
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/sh")
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir(), guestBundle(t), false); err == nil || !strings.Contains(err.Error(), "fixed SMITHERS_SERVER_ADDR port") {
		t.Fatalf("dynamic port accepted: %v", err)
	}
}

// guestBundle is a Flow host bundle holding a Linux arm64 helper header and
// names it as the coding host's workspace helper.
func guestBundle(t *testing.T) string {
	t.Helper()
	bundle := t.TempDir()
	header := make([]byte, 64)
	copy(header, "\x7fELF\x02\x01\x01")
	binary.LittleEndian.PutUint16(header[18:], 183)
	helper := filepath.Join(bundle, "linux-arm64", "smithers-jj-export")
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, header, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", helper)
	return bundle
}

// A coding host in a guest needs the Linux helper planted beside it: a
// helper outside the bundle, absent or built for the Mac refuses startup.
func TestMicroVMIsolationRefusesWithoutGuestHelper(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", "127.0.0.1:4000")
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/sh")
	freeRelayPort(t)
	bundle := guestBundle(t)
	darwin := filepath.Join(bundle, "smithers-jj-export-darwin")
	if err := os.WriteFile(darwin, []byte{0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "smithers-jj-export")
	for name, helper := range map[string]string{
		"unset":   "",
		"outside": outside,
		"missing": filepath.Join(bundle, "absent"),
		"darwin":  darwin,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", helper)
			runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle, false)
			if err == nil {
				_ = runtimes.Close()
				t.Fatal("microvm mode started without a guest workspace helper")
			}
			if !strings.Contains(err.Error(), "refuses to start") || !strings.Contains(err.Error(), "helper") && !strings.Contains(err.Error(), "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY") {
				t.Fatalf("refusal = %v", err)
			}
		})
	}
	// The same bundle with the Linux helper passes the helper check and is
	// refused only by the (fake) Microsandbox qualification.
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", filepath.Join(bundle, "linux-arm64", "smithers-jj-export"))
	_, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle, false)
	if !errors.Is(err, microsandbox.ErrUnavailable) {
		t.Fatalf("a Linux helper was refused: %v", err)
	}
}

// The trusted runtime remains available to the packaged model host, but cannot
// bind a coding host that would import repository flows on the install host.
func TestControlRuntimeCannotBindCodingFlowHost(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "process")
	root := t.TempDir()
	runtimes, err := openExecutionRuntimes(context.Background(), root, t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	defer runtimes.Close()
	if runtimes.control.Isolation() != workspaceapi.IsolationTrustedProcess {
		t.Fatal("model host control runtime must remain trusted process")
	}
	launcher, err := flowhost.NewWorkspaceLauncher(runtimes.control)
	if launcher != nil {
		t.Fatal("coding host acquired the control runtime")
	}
	var refusal flowruntime.Failure
	if !errors.As(err, &refusal) || refusal.FlowRuntimeCode() != "isolation_required" || refusal.FlowRuntimeRetryable() {
		t.Fatalf("control runtime refusal = %v", err)
	}
	var classified interface{ FlowRuntimeClass() string }
	if !errors.As(err, &classified) || classified.FlowRuntimeClass() != "infra" {
		t.Fatalf("control runtime refusal lacks infra class: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "workspaces", "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("refused coding host allocated an execution workspace")
	}
}

func TestMicroVMConfigUsesDetectedProfileForMachineAndPrepare(t *testing.T) {
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/qualified/msb")
	t.Setenv("SMITHERS_SERVER_ADDR", "127.0.0.1:4000")
	for _, name := range []string{"SMITHERS_MICROVM_CPUS", "SMITHERS_MICROVM_MEMORY_MIB", "SMITHERS_MICROVM_DISK_MIB", "SMITHERS_MICROVM_MAX_RUNNING", "SMITHERS_MICROVM_LAYER_BUDGET_GIB", "SMITHERS_MICROVM_MIN_FREE_GIB"} {
		t.Setenv(name, "999")
	}
	bundle := guestBundle(t)
	for _, row := range []struct {
		name                             string
		memory, disk                     int64
		cores, cpus, memoryMiB, capacity int
		budget                           int64
	}{
		{"24 GiB", 24, 200, 8, 4, 8192, 2, 48},
		{"32 GiB", 32, 400, 10, 4, 8192, 3, 48},
		{"smaller host", 16, 60, 4, 2, 6144, 0, 15},
	} {
		t.Run(row.name, func(t *testing.T) {
			root := t.TempDir()
			profile := microsandbox.HostProfile{MemoryBytes: row.memory << 30, DiskFreeBytes: row.disk << 30,
				PerfCores: row.cores, PhysicalCores: row.cores + 4, MacOSVersion: "26.0", Hypervisor: true}
			calls := 0
			config, err := microVMConfigWithProfile(root, bundle, func(state string) (microsandbox.HostProfile, error) {
				calls++
				if state != root {
					t.Fatalf("detector measured %q, want state volume %q", state, root)
				}
				return profile, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("detector calls = %d", calls)
			}
			if config.HostProfile == nil || *config.HostProfile != profile {
				t.Fatalf("profile = %#v", config.HostProfile)
			}
			if config.CPUs != row.cpus || config.MemoryMiB != row.memoryMiB || config.MaxRunningVMs != row.capacity || config.DiskMiB != 32768 {
				t.Fatalf("machine limits = cpus %d, memory %d, capacity %d, disk %d", config.CPUs, config.MemoryMiB, config.MaxRunningVMs, config.DiskMiB)
			}
			prepare := config.Environments
			if prepare == nil || prepare.PrepareCPUs != config.CPUs || prepare.PrepareMemoryMiB != config.MemoryMiB || prepare.PrepareDiskMiB != config.DiskMiB {
				t.Fatalf("prepare limits = %#v; must match one machine", prepare)
			}
			if prepare.LayerBudgetBytes != row.budget<<30 || prepare.MinFreeBytes != 40<<30 {
				t.Fatalf("disk limits = budget %d, floor %d", prepare.LayerBudgetBytes, prepare.MinFreeBytes)
			}
		})
	}
}

func TestMicroVMConfigDetectionFailureRefusesStartup(t *testing.T) {
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/qualified/msb")
	t.Setenv("SMITHERS_SERVER_ADDR", "127.0.0.1:4000")
	bundle := guestBundle(t)
	cause := errors.New("hw.memsize failed")
	config, err := microVMConfigWithProfile(t.TempDir(), bundle, func(string) (microsandbox.HostProfile, error) {
		return microsandbox.HostProfile{}, cause
	})
	if err == nil {
		t.Fatal("host detection failure accepted")
	}
	var profileError *microsandbox.HostProfileError
	if !errors.As(err, &profileError) || !strings.Contains(err.Error(), "refuses to start") || !strings.Contains(err.Error(), cause.Error()) {
		t.Fatalf("startup error must retain typed host detection refusal: %v", err)
	}
	if config.CPUs != 0 || config.MemoryMiB != 0 || config.MaxRunningVMs != 0 || config.HostProfile != nil {
		t.Fatalf("detection failure selected fallback limits: %#v", config)
	}
}

func TestMicroVMIsolationRefusesWrongVersion(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "msb")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\necho 'msb 0.6.15'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", binary)
	freeRelayPort(t)
	_, err := openExecutionRuntimes(context.Background(), t.TempDir(), guestBundle(t), false)
	if !errors.Is(err, microsandbox.ErrUnavailable) || !strings.Contains(err.Error(), "qualified with msb 0.6.16") {
		t.Fatalf("version refusal = %v", err)
	}
}
