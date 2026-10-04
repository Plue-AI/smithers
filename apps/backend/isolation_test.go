package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
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
	runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), "", "", true)
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
			bundle := installedBundleFixture(t)
			runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle.backend, bundle.codingHost, false)
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
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir(), "", "", false); err == nil {
		t.Fatal("unknown isolation mode accepted")
	}
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", ":0")
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/sh")
	bundle := installedBundleFixture(t)
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle.backend, bundle.codingHost, false); err == nil || !strings.Contains(err.Error(), "fixed SMITHERS_SERVER_ADDR port") {
		t.Fatalf("dynamic port accepted: %v", err)
	}
}

// testBundle is an installed server bundle: the backend, the coding Flow
// host and the Linux arm64 workspace helper, each declared with its digest
// and mode in manifest.json the way the bundle assembler writes it.
type testBundle struct {
	root, backend, codingHost, helper string
}

func installedBundleFixture(t *testing.T) testBundle {
	t.Helper()
	temporary, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(temporary, "libexec")
	header := make([]byte, 64)
	copy(header, "\x7fELF\x02\x01\x01")
	binary.LittleEndian.PutUint16(header[18:], 183)
	bundle := testBundle{root: root, backend: filepath.Join(root, "bin", "smithers-backend"),
		codingHost: filepath.Join(root, "bin", "smithers-coding-host"), helper: filepath.Join(root, "bin", "linux-arm64", "smithers-jj-export")}
	for path, body := range map[string][]byte{bundle.backend: []byte("backend"), bundle.codingHost: []byte("#!/usr/bin/env node\n"), bundle.helper: header} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	bundle.writeManifest(t)
	return bundle
}

// writeManifest declares every regular file now in the bundle as it is.
func (b testBundle) writeManifest(t *testing.T) {
	t.Helper()
	var files []map[string]any
	err := filepath.WalkDir(b.root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Name() == "manifest.json" {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(b.root, path)
		sum := sha256.Sum256(body)
		files = append(files, map[string]any{"path": filepath.ToSlash(relative), "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": int(info.Mode().Perm())})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(map[string]any{"version": 1, "platform": "darwin-arm64", "revision": strings.Repeat("a", 40), "files": files})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.root, "manifest.json"), manifest, 0o644); err != nil {
		t.Fatal(err)
	}
}

// microVM isolation plants only from the installed bundle the backend runs
// from. A development build, a missing or altered manifest entry, a Mac
// helper or a coding host outside the bundle refuses startup before
// Microsandbox is asked; the workspace helper variable is never read.
func TestMicroVMIsolationRefusesOutsideTheInstalledBundle(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", "127.0.0.1:4000")
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/sh")
	freeRelayPort(t)
	for name, prepare := range map[string]func(t *testing.T, b *testBundle){
		"development build": func(t *testing.T, b *testBundle) {
			b.backend = filepath.Join(t.TempDir(), "smithers-backend")
			if err := os.WriteFile(b.backend, []byte("backend"), 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"renamed backend": func(t *testing.T, b *testBundle) {
			renamed := filepath.Join(b.root, "bin", "backend-dev")
			if err := os.Rename(b.backend, renamed); err != nil {
				t.Fatal(err)
			}
			b.backend = renamed
			b.writeManifest(t)
		},
		"no manifest": func(t *testing.T, b *testBundle) {
			if err := os.Remove(filepath.Join(b.root, "manifest.json")); err != nil {
				t.Fatal(err)
			}
		},
		"helper absent": func(t *testing.T, b *testBundle) {
			if err := os.Remove(b.helper); err != nil {
				t.Fatal(err)
			}
			b.writeManifest(t)
		},
		"helper built for the Mac": func(t *testing.T, b *testBundle) {
			if err := os.WriteFile(b.helper, append([]byte{0xcf, 0xfa, 0xed, 0xfe}, make([]byte, 60)...), 0o755); err != nil {
				t.Fatal(err)
			}
			b.writeManifest(t)
		},
		"helper changed after the install": func(t *testing.T, b *testBundle) {
			body, err := os.ReadFile(b.helper)
			if err != nil {
				t.Fatal(err)
			}
			body[63] = 1
			if err := os.WriteFile(b.helper, body, 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"coding host outside the bundle": func(t *testing.T, b *testBundle) {
			b.codingHost = filepath.Join(t.TempDir(), "smithers-coding-host")
			if err := os.WriteFile(b.codingHost, []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"coding host changed after the install": func(t *testing.T, b *testBundle) {
			if err := os.WriteFile(b.codingHost, []byte("#!/usr/bin/env node\n// branch\n"), 0o755); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			bundle := installedBundleFixture(t)
			prepare(t, &bundle)
			runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle.backend, bundle.codingHost, false)
			if err == nil {
				_ = runtimes.Close()
				t.Fatal("microvm mode started outside the installed bundle")
			}
			if !strings.Contains(err.Error(), "refuses to start") || errors.Is(err, microsandbox.ErrUnavailable) {
				t.Fatalf("refusal = %v; it must come before Microsandbox is asked", err)
			}
		})
	}
	// The intact bundle passes every bundle check, whatever the retired helper
	// variable names, and is refused only by the (fake) Microsandbox.
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", filepath.Join(t.TempDir(), "smithers-jj-export"))
	bundle := installedBundleFixture(t)
	_, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle.backend, bundle.codingHost, false)
	if !errors.Is(err, microsandbox.ErrUnavailable) || errors.Is(err, microsandbox.ErrUnapprovedArtifact) {
		t.Fatalf("the installed bundle was refused: %v", err)
	}
}

// The trusted runtime remains available to the packaged model host, but cannot
// bind a coding host that would import repository flows on the install host.
func TestControlRuntimeCannotBindCodingFlowHost(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "process")
	root := t.TempDir()
	runtimes, err := openExecutionRuntimes(context.Background(), root, "", "", true)
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
	bundle := installedBundleFixture(t)
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
			config, err := microVMConfigWithProfile(root, bundle.backend, bundle.codingHost, func(state string) (microsandbox.HostProfile, error) {
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
			if config.Bundle != bundle.root || len(config.BundlePrograms) != 1 || config.BundlePrograms[0] != bundle.codingHost {
				t.Fatalf("bundle = %q, programs = %q", config.Bundle, config.BundlePrograms)
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
	bundle := installedBundleFixture(t)
	cause := errors.New("hw.memsize failed")
	config, err := microVMConfigWithProfile(t.TempDir(), bundle.backend, bundle.codingHost, func(string) (microsandbox.HostProfile, error) {
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
	bundle := installedBundleFixture(t)
	_, err := openExecutionRuntimes(context.Background(), t.TempDir(), bundle.backend, bundle.codingHost, false)
	if !errors.Is(err, microsandbox.ErrUnavailable) || !strings.Contains(err.Error(), "qualified with msb 0.6.16") {
		t.Fatalf("version refusal = %v", err)
	}
}
