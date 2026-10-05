package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestProcessIsolationKeepsOneTrustedRuntime(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "")
	runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), nil, "", true)
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

// microvm mode never falls back to host processes: an msb that does not
// qualify refuses startup. msb is only the bundle's bin/msb; no environment
// variable selects another one.
func TestMicroVMIsolationRefusesWithoutMicrosandbox(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	freeRelayPort(t)
	bundle := installedBundleFixture(t)
	bundle.approve(t, bundle.msb, []byte("#!/bin/sh\necho \"$0\" >> "+bundle.ran+"\necho 'not msb'\n"))
	outside := filepath.Join(t.TempDir(), "msb")
	if err := os.WriteFile(outside, []byte("#!/bin/sh\necho \"$0\" >> "+bundle.ran+"\necho 'msb 0.6.16'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", outside)
	runtimes, err := openExecutionRuntimes(context.Background(), bundletest.ProtectedTempDir(t), bundle.pin(t), bundle.codingHost, false)
	if err == nil {
		_ = runtimes.Close()
		t.Fatal("microvm mode started without Microsandbox")
	}
	if !errors.Is(err, microsandbox.ErrUnavailable) || !strings.Contains(err.Error(), "refuses to start") {
		t.Fatalf("refusal = %v", err)
	}
	ran, readErr := os.ReadFile(bundle.ran)
	if readErr != nil || strings.Contains(string(ran), outside) || !strings.Contains(string(ran), bundle.msb) {
		t.Fatalf("msb runs = %q (%v); only the bundle's msb may run", ran, readErr)
	}
}

func TestIsolationModeIsValidated(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "container")
	if _, err := openExecutionRuntimes(context.Background(), t.TempDir(), nil, "", false); err == nil {
		t.Fatal("unknown isolation mode accepted")
	}
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", ":0")
	bundle := installedBundleFixture(t)
	if _, err := openExecutionRuntimes(context.Background(), bundletest.ProtectedTempDir(t), bundle.pin(t), bundle.codingHost, false); err == nil || !strings.Contains(err.Error(), "fixed SMITHERS_SERVER_ADDR port") {
		t.Fatalf("dynamic port accepted: %v", err)
	}
}

// testBundle is an installed server bundle: the backend, msb and the guest
// kernel, the repository engine library, node, the model host, PostgreSQL,
// the Flow host manifest, the coding Flow host and the Linux arm64 workspace
// helper, each declared with its digest and mode in manifest.json the way
// the bundle assembler writes it. Its msb appends its path to ran and
// reports a version no runtime qualifies.
type testBundle struct {
	root, backend, msb, kernel, ffi, node, modelHost, postgres, hostManifest, codingHost, helper, ran string
	git, gitExec, gitTemplates, webRoot                                                               string
}

func installedBundleFixture(t *testing.T) testBundle {
	t.Helper()
	temporary := bundletest.ProtectedTempDir(t)
	root := filepath.Join(temporary, "libexec")
	header := make([]byte, 64)
	copy(header, "\x7fELF\x02\x01\x01")
	binary.LittleEndian.PutUint16(header[18:], 183)
	bundle := testBundle{root: root, backend: filepath.Join(root, "bin", "smithers-backend"), msb: filepath.Join(root, "bin", "msb"),
		kernel: filepath.Join(root, "lib", "libkrunfw.5.dylib"), ffi: filepath.Join(root, "bin", "libsmithers_ffi.dylib"),
		node: filepath.Join(root, "bin", "node"), modelHost: filepath.Join(root, "bin", "smithers-model-host"),
		postgres:     filepath.Join(root, "postgres", "root", "bin"),
		hostManifest: filepath.Join(root, "bin", "flow-hosts.json"), codingHost: filepath.Join(root, "bin", "smithers-coding-host"),
		helper: filepath.Join(root, "bin", "linux-arm64", "smithers-jj-export"), ran: filepath.Join(temporary, "msb-ran"),
		git: filepath.Join(root, "bin", "git"), gitExec: filepath.Join(root, "libexec", "git-core"),
		gitTemplates: filepath.Join(root, "share", "git-core", "templates"), webRoot: filepath.Join(root, "views", "mainview")}
	codingHost := []byte("#!/usr/bin/env node\n")
	files := map[string][]byte{bundle.backend: []byte("backend"), bundle.codingHost: codingHost, bundle.helper: header,
		bundle.msb: []byte("#!/bin/sh\necho \"$0\" >> " + bundle.ran + "\necho 'msb 0.0.0'\n"),
		bundle.ffi: []byte("ffi"), bundle.node: []byte("node"), bundle.modelHost: []byte("model host"), bundle.git: []byte("git"),
		filepath.Join(root, "bin", "jj"):                  []byte("jj"),
		filepath.Join(root, "bin", "linux-arm64", "jj"):   append(append([]byte(nil), header...), "jj"...),
		filepath.Join(bundle.gitExec, "git-remote-http"):  []byte("git-remote-http"),
		filepath.Join(bundle.gitTemplates, "description"): []byte("template"),
		filepath.Join(bundle.webRoot, "index.html"):       []byte("<!doctype html>")}
	for _, program := range postgresPrograms {
		files[filepath.Join(bundle.postgres, program)] = []byte(program)
	}
	for path, body := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(bundle.kernel), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bundle.kernel, []byte("guest kernel"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest := func(body []byte) string {
		sum := sha256.Sum256(body)
		return hex.EncodeToString(sum[:])
	}
	hosts, err := json.Marshal(map[string]any{"version": 1, "hosts": map[string]any{
		"coding":   map[string]any{"executable": "smithers-coding-host", "sha256": digest(codingHost), "flows": []string{"coding/dispatch"}},
		"jjExport": map[string]any{"executable": "linux-arm64/smithers-jj-export", "sha256": digest(header), "flows": []string{}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bundle.hostManifest, hosts, 0o644); err != nil {
		t.Fatal(err)
	}
	bundle.writeManifest(t)
	return bundle
}

// pin opens the bundle the way production startup does.
func (b testBundle) pin(t *testing.T) *installbundle.Bundle {
	t.Helper()
	pinned, err := installbundle.OpenRunning(b.backend)
	if err != nil {
		t.Fatal(err)
	}
	return pinned
}

// installedEnvironment is the environment the launcher gives a backend
// started from b, with a private data root.
func (b testBundle) installedEnvironment(t *testing.T) map[string]string {
	t.Helper()
	parent := bundletest.ProtectedTempDir(t)
	return map[string]string{
		"SMITHERS_DATA_ROOT": filepath.Join(parent, "data"), "SMITHERS_FLOW_HOST_MANIFEST": b.hostManifest,
		"SMITHERS_FFI_LIBRARY_PATH": b.ffi, "SMITHERS_NODE_BINARY": b.node, "SMITHERS_MODEL_HOST_BUNDLE": b.modelHost,
		"SMITHERS_NATIVE_POSTGRES_BIN": b.postgres,
		"GIT_EXEC_PATH":                b.gitExec, "GIT_TEMPLATE_DIR": b.gitTemplates, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.DevNull,
		"SMITHERS_WEB_ROOT": b.webRoot,
	}
}

// startInstalled runs production microVM startup from b with environment:
// verify the handed inputs against the pinned bundle, then open the
// execution runtimes with the verified data root and coding host.
func startInstalled(b testBundle, environment map[string]string) (executionRuntimes, error) {
	inputs, err := installedInputs(b.backend, func(name string) string { return environment[name] })
	if err != nil {
		return executionRuntimes{}, fmt.Errorf("SMITHERS_WORKSPACE_ISOLATION=microvm refuses to start: %w", err)
	}
	return openExecutionRuntimes(context.Background(), inputs.dataRoot, inputs.bundle, inputs.registry.Coding.Executable, false)
}

// approve writes one bundle file and declares it, as a differently assembled
// bundle would.
func (b testBundle) approve(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.WriteFile(path, body, 0o755); err != nil {
		t.Fatal(err)
	}
	b.writeManifest(t)
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
		declared := map[string]any{"path": filepath.ToSlash(relative), "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": int(info.Mode().Perm())}
		// The assembler signs the backend with the hardened runtime and
		// records it.
		if filepath.ToSlash(relative) == "bin/smithers-backend" {
			declared["codeSignature"] = "adhoc,runtime"
		}
		files = append(files, declared)
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

// Production microVM startup runs, loads and plants only from the installed
// bundle the backend runs from, and keeps state only in protected
// directories (spec §17.3 ruling item 3). Every hostile alternate a path
// variable can name (a file outside the bundle, a relative path, another
// member, changed bytes) and every unprotected state directory refuses
// startup, naming the variable, before Microsandbox is asked; the retired
// helper and msb variables are never read.
func TestMicroVMIsolationRefusesOutsideTheInstalledBundle(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	t.Setenv("SMITHERS_SERVER_ADDR", "127.0.0.1:4000")
	freeRelayPort(t)
	outsideFile := func(t *testing.T, name string, body []byte) string {
		path := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(path, body, 0o755); err != nil {
			t.Fatal(err)
		}
		return path
	}
	for name, test := range map[string]struct {
		names   string
		prepare func(t *testing.T, b *testBundle, env map[string]string)
	}{
		"development build": {"does not run from an installed bundle", func(t *testing.T, b *testBundle, _ map[string]string) {
			b.backend = outsideFile(t, "smithers-backend", []byte("backend"))
		}},
		"renamed backend": {"does not run from an installed bundle", func(t *testing.T, b *testBundle, _ map[string]string) {
			renamed := filepath.Join(b.root, "bin", "backend-dev")
			if err := os.Rename(b.backend, renamed); err != nil {
				t.Fatal(err)
			}
			b.backend = renamed
			b.writeManifest(t)
		}},
		"backend changed after the install": {"bin/smithers-backend differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(b.backend, []byte("branch-built backend"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"msb changed after the install": {"bin/msb differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(b.msb, []byte("#!/bin/sh\necho 'msb 0.6.16'\n"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"guest kernel changed after the install": {"lib/libkrunfw.5.dylib differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(b.kernel, []byte("branch-built kernel"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		"no manifest": {"read the bundle manifest", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.Remove(filepath.Join(b.root, "manifest.json")); err != nil {
				t.Fatal(err)
			}
		}},
		"group-writable bundle": {"libexec is not owned", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.Chmod(b.root, 0o775); err != nil {
				t.Fatal(err)
			}
		}},
		"Flow host manifest outside the bundle": {"SMITHERS_FLOW_HOST_MANIFEST=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_FLOW_HOST_MANIFEST"] = outsideFile(t, "flow-hosts.json", []byte("{}\n"))
		}},
		"Flow host manifest elsewhere in the bundle": {"SMITHERS_FLOW_HOST_MANIFEST=", func(t *testing.T, b *testBundle, env map[string]string) {
			other := filepath.Join(b.root, "share", "flow-hosts.json")
			if err := os.MkdirAll(filepath.Dir(other), 0o755); err != nil {
				t.Fatal(err)
			}
			body, err := os.ReadFile(b.hostManifest)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(other, body, 0o644); err != nil {
				t.Fatal(err)
			}
			b.writeManifest(t)
			env["SMITHERS_FLOW_HOST_MANIFEST"] = other
		}},
		"Flow host manifest changed after the install": {"bin/flow-hosts.json differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(b.hostManifest, []byte(`{"version":1,"hosts":{}}`), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		"repository engine library outside the bundle": {"SMITHERS_FFI_LIBRARY_PATH=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_FFI_LIBRARY_PATH"] = outsideFile(t, "libsmithers_ffi.dylib", []byte("ffi"))
		}},
		"repository engine library relative": {"SMITHERS_FFI_LIBRARY_PATH=bin/libsmithers_ffi.dylib", func(_ *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_FFI_LIBRARY_PATH"] = "bin/libsmithers_ffi.dylib"
		}},
		"repository engine library changed": {"bin/libsmithers_ffi.dylib differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(b.ffi, []byte("branch ffi"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"node outside the bundle": {"SMITHERS_NODE_BINARY=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_NODE_BINARY"] = outsideFile(t, "node", []byte("node"))
		}},
		"node named as another member": {"is not the installed bundle's bin/node", func(_ *testing.T, b *testBundle, env map[string]string) {
			env["SMITHERS_NODE_BINARY"] = b.msb
		}},
		"model host outside the bundle": {"SMITHERS_MODEL_HOST_BUNDLE=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_MODEL_HOST_BUNDLE"] = outsideFile(t, "smithers-model-host", []byte("model host"))
		}},
		"model host relative": {"SMITHERS_MODEL_HOST_BUNDLE=bin/smithers-model-host", func(_ *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_MODEL_HOST_BUNDLE"] = "bin/smithers-model-host"
		}},
		"PostgreSQL outside the bundle": {"SMITHERS_NATIVE_POSTGRES_BIN=", func(t *testing.T, _ *testBundle, env map[string]string) {
			directory := t.TempDir()
			for _, program := range postgresPrograms {
				if err := os.WriteFile(filepath.Join(directory, program), []byte(program), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			env["SMITHERS_NATIVE_POSTGRES_BIN"] = directory
		}},
		"PostgreSQL binary changed": {"postgres/root/bin/initdb differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(filepath.Join(b.postgres, "initdb"), []byte("branch initdb"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"data root unset": {"SMITHERS_DATA_ROOT is required", func(_ *testing.T, _ *testBundle, env map[string]string) {
			delete(env, "SMITHERS_DATA_ROOT")
		}},
		"data root relative": {"SMITHERS_DATA_ROOT=data is not an absolute path", func(_ *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_DATA_ROOT"] = "data"
		}},
		"group-writable data root": {"is not owned by root or this user", func(t *testing.T, _ *testBundle, env map[string]string) {
			if err := os.MkdirAll(env["SMITHERS_DATA_ROOT"], 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(env["SMITHERS_DATA_ROOT"], 0o770); err != nil {
				t.Fatal(err)
			}
		}},
		"data root under a world-writable directory": {"is not owned by root or this user", func(t *testing.T, _ *testBundle, env map[string]string) {
			shared := filepath.Join(filepath.Dir(env["SMITHERS_DATA_ROOT"]), "shared")
			if err := os.MkdirAll(shared, 0o777); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(shared, 0o777); err != nil {
				t.Fatal(err)
			}
			env["SMITHERS_DATA_ROOT"] = filepath.Join(shared, "data")
		}},
		"group-writable PostgreSQL state": {"SMITHERS_NATIVE_STATE_DIR=", func(t *testing.T, _ *testBundle, env map[string]string) {
			state := filepath.Join(filepath.Dir(env["SMITHERS_DATA_ROOT"]), "state")
			if err := os.MkdirAll(state, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(state, 0o775); err != nil {
				t.Fatal(err)
			}
			env["SMITHERS_NATIVE_STATE_DIR"] = state
		}},
		"repository store elsewhere and writable": {"SMITHERS_REPO_STORAGE_PATH=", func(t *testing.T, _ *testBundle, env map[string]string) {
			store := filepath.Join(filepath.Dir(env["SMITHERS_DATA_ROOT"]), "repositories")
			if err := os.MkdirAll(store, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(store, 0o777); err != nil {
				t.Fatal(err)
			}
			env["SMITHERS_REPO_STORAGE_PATH"] = store
		}},
		"blob store relative": {"SMITHERS_BLOB_DATA_DIR=blobs is not an absolute path", func(_ *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_BLOB_DATA_DIR"] = "blobs"
		}},
		"SSH host keys in a writable directory": {"SMITHERS_SSH_HOST_KEY_DIR=", func(t *testing.T, _ *testBundle, env map[string]string) {
			keys := filepath.Join(filepath.Dir(env["SMITHERS_DATA_ROOT"]), "ssh")
			if err := os.MkdirAll(keys, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(keys, 0o777); err != nil {
				t.Fatal(err)
			}
			env["SMITHERS_SSH_HOST_KEY_DIR"] = keys
		}},
		"install state relative": {"SMITHERS_INSTALL_STATE_DIR=state is not an absolute path", func(_ *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_INSTALL_STATE_DIR"] = "state"
		}},
		"pack cache relative": {"SMITHERS_REPO_HOST_PACK_CACHE_DIR=cache is not an absolute path", func(_ *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_REPO_HOST_PACK_CACHE_DIR"] = "cache"
		}},
		"repository host pack cache in a writable directory": {"SMITHERS_REPO_HOST_PACK_CACHE_DIR=", func(t *testing.T, _ *testBundle, env map[string]string) {
			cache := filepath.Join(filepath.Dir(env["SMITHERS_DATA_ROOT"]), "packs")
			if err := os.MkdirAll(cache, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(cache, 0o770); err != nil {
				t.Fatal(err)
			}
			env["SMITHERS_REPO_HOST_PACK_CACHE_DIR"] = cache
		}},
		"alternate layer records": {"layers is not owned by root or this user", func(t *testing.T, _ *testBundle, env map[string]string) {
			layers := filepath.Join(env["SMITHERS_DATA_ROOT"], "microvm", "layers")
			if err := os.MkdirAll(layers, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(layers, 0o777); err != nil {
				t.Fatal(err)
			}
		}},
		"jj changed after the install": {"bin/jj differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(filepath.Join(b.root, "bin", "jj"), []byte("branch jj"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"PostgreSQL unset": {"SMITHERS_NATIVE_POSTGRES_BIN is required", func(_ *testing.T, _ *testBundle, env map[string]string) {
			delete(env, "SMITHERS_NATIVE_POSTGRES_BIN")
		}},
		"git reads a system configuration": {"GIT_CONFIG_NOSYSTEM=0", func(_ *testing.T, _ *testBundle, env map[string]string) {
			env["GIT_CONFIG_NOSYSTEM"] = "0"
		}},
		"TMPDIR world-writable": {"TMPDIR=", func(t *testing.T, _ *testBundle, env map[string]string) {
			shared := filepath.Join(bundletest.ProtectedTempDir(t), "tmp")
			if err := os.MkdirAll(shared, 0o777); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(shared, 0o777); err != nil {
				t.Fatal(err)
			}
			env["TMPDIR"] = shared
		}},
		"certificate bundle writable": {"SSL_CERT_FILE=", func(t *testing.T, _ *testBundle, env map[string]string) {
			file := filepath.Join(bundletest.ProtectedTempDir(t), "roots.pem")
			if err := os.WriteFile(file, []byte("roots"), 0o666); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(file, 0o666); err != nil {
				t.Fatal(err)
			}
			env["SSL_CERT_FILE"] = file
		}},
		"data root created under an unprotected parent": {"is not owned by root or this user", func(t *testing.T, _ *testBundle, env map[string]string) {
			shared := filepath.Join(bundletest.ProtectedTempDir(t), "shared")
			if err := os.MkdirAll(shared, 0o777); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(shared, 0o777); err != nil {
				t.Fatal(err)
			}
			env["SMITHERS_DATA_ROOT"] = filepath.Join(shared, "a", "data")
			t.Cleanup(func() {
				if _, err := os.Stat(filepath.Join(shared, "a")); !errors.Is(err, fs.ErrNotExist) {
					t.Errorf("a refused data root was created: %v", err)
				}
			})
		}},
		"git changed after the install": {"bin/git differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(b.git, []byte("branch git"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"git helpers outside the bundle": {"GIT_EXEC_PATH=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["GIT_EXEC_PATH"] = filepath.Dir(outsideFile(t, "git-remote-http", []byte("git-remote-http")))
		}},
		"git helper changed after the install": {"libexec/git-core/git-remote-http differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(filepath.Join(b.gitExec, "git-remote-http"), []byte("branch helper"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"git templates outside the bundle": {"GIT_TEMPLATE_DIR=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["GIT_TEMPLATE_DIR"] = t.TempDir()
		}},
		"git user configuration": {"GIT_CONFIG_GLOBAL=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["GIT_CONFIG_GLOBAL"] = outsideFile(t, "gitconfig", []byte("[core]\n\tfsmonitor = /tmp/hostile\n"))
		}},
		"git system configuration": {"GIT_CONFIG_SYSTEM=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["GIT_CONFIG_SYSTEM"] = outsideFile(t, "gitconfig", []byte("[core]\n\tfsmonitor = /tmp/hostile\n"))
		}},
		"web app outside the bundle": {"SMITHERS_WEB_ROOT=", func(t *testing.T, _ *testBundle, env map[string]string) {
			env["SMITHERS_WEB_ROOT"] = t.TempDir()
		}},
		"web app changed after the install": {"views/mainview/index.html differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(filepath.Join(b.webRoot, "index.html"), []byte("<script>branch</script>"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"helper absent": {"smithers-jj-export", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.Remove(b.helper); err != nil {
				t.Fatal(err)
			}
			b.writeManifest(t)
		}},
		"helper changed after the install": {"jjExport Flow host checksum differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			body, err := os.ReadFile(b.helper)
			if err != nil {
				t.Fatal(err)
			}
			body[63] = 1
			if err := os.WriteFile(b.helper, body, 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"coding host changed after the install": {"coding Flow host checksum differs", func(t *testing.T, b *testBundle, _ map[string]string) {
			if err := os.WriteFile(b.codingHost, []byte("#!/usr/bin/env node\n// branch\n"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			bundle := installedBundleFixture(t)
			env := bundle.installedEnvironment(t)
			test.prepare(t, &bundle, env)
			runtimes, err := startInstalled(bundle, env)
			if err == nil {
				_ = runtimes.Close()
				t.Fatal("microvm mode started outside the installed bundle")
			}
			if !strings.Contains(err.Error(), "refuses to start") || errors.Is(err, microsandbox.ErrUnavailable) || !strings.Contains(err.Error(), test.names) {
				t.Fatalf("refusal = %v; it must name %q and come before Microsandbox is asked", err, test.names)
			}
			if _, statErr := os.Stat(bundle.ran); !errors.Is(statErr, fs.ErrNotExist) {
				t.Fatalf("msb ran before the refusal: %v", statErr)
			}
		})
	}
	// The intact bundle passes every check, whatever the retired helper and
	// msb variables name, and is refused only by its (fixture) msb.
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", filepath.Join(t.TempDir(), "smithers-jj-export"))
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", "/bin/sh")
	bundle := installedBundleFixture(t)
	env := bundle.installedEnvironment(t)
	env["SMITHERS_REPO_HOST_PACK_CACHE_DIR"] = "off"
	_, err := startInstalled(bundle, env)
	if !errors.Is(err, microsandbox.ErrUnavailable) || errors.Is(err, microsandbox.ErrUnapprovedArtifact) {
		t.Fatalf("the installed bundle was refused: %v", err)
	}
	if ran, readErr := os.ReadFile(bundle.ran); readErr != nil || strings.TrimSpace(string(ran)) == "" {
		t.Fatalf("the bundle's msb did not run: %v", readErr)
	}
}

// Ruling item 3: every git the backend starts runs the bundle's own helpers
// and templates, named or not, and reads no configuration file; the backend
// and every program it starts run the bundle's git and jj, first on the PATH
// the backend sets.
func TestInstalledGitEnvironmentIsTheBundles(t *testing.T) {
	bundle := installedBundleFixture(t)
	env := bundle.installedEnvironment(t)
	for _, name := range []string{"GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"} {
		delete(env, name)
	}
	inputs, err := installedInputs(bundle.backend, func(name string) string { return env[name] })
	if err != nil {
		t.Fatal(err)
	}
	root := inputs.bundle.Root()
	for name, want := range map[string]string{
		"GIT_EXEC_PATH": filepath.Join(root, "libexec", "git-core"), "GIT_TEMPLATE_DIR": filepath.Join(root, "share", "git-core", "templates"),
		"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.DevNull, "GIT_CONFIG_SYSTEM": os.DevNull,
		"PATH": filepath.Join(root, "bin") + ":/usr/bin:/bin:/usr/sbin:/sbin",
	} {
		if inputs.environment[name] != want {
			t.Errorf("%s = %q; want %q", name, inputs.environment[name], want)
		}
	}
	if inputs.host.Git != filepath.Join(root, "bin", "git") || inputs.host.GitExecPath != filepath.Join(root, "libexec", "git-core") ||
		inputs.host.GitTemplateDir != filepath.Join(root, "share", "git-core", "templates") {
		t.Fatalf("host git = %+v", inputs.host)
	}
}

// The trusted runtime remains available to the packaged model host, but cannot
// bind a coding host that would import repository flows on the install host.
func TestControlRuntimeCannotBindCodingFlowHost(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "process")
	root := t.TempDir()
	runtimes, err := openExecutionRuntimes(context.Background(), root, nil, "", true)
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
	pinned := bundle.pin(t)
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
			config, err := microVMConfigWithProfile(root, pinned, bundle.codingHost, func(state string) (microsandbox.HostProfile, error) {
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
			if config.Bundle != pinned || len(config.BundlePrograms) != 1 || config.BundlePrograms[0] != bundle.codingHost {
				t.Fatalf("bundle = %v, programs = %q", config.Bundle, config.BundlePrograms)
			}
			if config.Binary != "" {
				t.Fatalf("msb %q was selected outside the bundle", config.Binary)
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
	t.Setenv("SMITHERS_SERVER_ADDR", "127.0.0.1:4000")
	bundle := installedBundleFixture(t)
	cause := errors.New("hw.memsize failed")
	config, err := microVMConfigWithProfile(t.TempDir(), bundle.pin(t), bundle.codingHost, func(string) (microsandbox.HostProfile, error) {
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
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "microvm")
	freeRelayPort(t)
	bundle := installedBundleFixture(t)
	bundle.approve(t, bundle.msb, []byte("#!/bin/sh\necho 'msb 0.6.15'\n"))
	_, err := openExecutionRuntimes(context.Background(), bundletest.ProtectedTempDir(t), bundle.pin(t), bundle.codingHost, false)
	if !errors.Is(err, microsandbox.ErrUnavailable) || !strings.Contains(err.Error(), "qualified with msb 0.6.16") {
		t.Fatalf("version refusal = %v", err)
	}
}
