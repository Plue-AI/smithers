package services

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceCodingHostPreservesGeneralCLI(t *testing.T) {
	dir := t.TempDir()
	cli := []byte("#!/bin/sh\necho general-cli\n")
	host := []byte("#!/bin/sh\necho coding-host\n")
	for name, data := range map[string][]byte{"cli": cli, "host": host} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), data, 0700))
	}
	t.Setenv(workspaceCLIBinaryEnv, filepath.Join(dir, "cli"))
	t.Setenv(workspaceCodingHostBinaryEnv, filepath.Join(dir, "host"))
	req, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).buildWorkspaceVMRequest(context.Background(), "", nil, 0, "container")
	require.NoError(t, err)
	for path, expected := range map[string][]byte{workspaceSmithersCLIB64Path: cli, workspaceCodingHostB64Path: host} {
		data, err := base64.StdEncoding.DecodeString(req.Files[path].Content)
		require.NoError(t, err)
		decoder, err := gzip.NewReader(bytes.NewReader(data))
		require.NoError(t, err)
		actual, err := io.ReadAll(decoder)
		require.NoError(t, err)
		require.NoError(t, decoder.Close())
		require.Equal(t, expected, actual)
	}
	require.Contains(t, buildWorkspaceClaudeBootstrapScript(), workspaceSmithersCLIPath+`\" init --global --no-skill`)
}

func TestWorkspaceCodingHostStagingExecutesAndRefusesBrokenPayload(t *testing.T) {
	for _, nix := range []bool{false, true} {
		for _, broken := range []bool{false, true} {
			name := "container"
			if nix {
				name = "nixos"
			}
			if broken {
				name += "-broken"
			}
			t.Run(name, func(t *testing.T) {
				dir := t.TempDir()
				path := filepath.Join(dir, "host")
				payload := filepath.Join(dir, "payload")
				bytes := []byte("#!/bin/sh\n[ \"$1\" = --help ]\n")
				if broken {
					bytes = []byte("#!/bin/sh\nexit 9\n")
				}
				require.NoError(t, os.WriteFile(path, bytes, 0700))
				t.Setenv(workspaceCodingHostBinaryEnv, path)
				files := map[string]sandbox.SandboxFile{}
				require.True(t, addWorkspaceCodingHost(files))
				require.NoError(t, os.WriteFile(payload, []byte(files[workspaceCodingHostB64Path].Content), 0600))
				script := buildWorkspaceClaudeBootstrapScript()
				if nix {
					script = buildWorkspaceNixBootstrapScript()
				}
				start := strings.Index(script, "# The configured coding host")
				end := strings.Index(script, "# End configured coding host staging.")
				require.Greater(t, end, start)
				script = "set -euo pipefail\n" + script[start:end]
				require.Contains(t, script, "runuser -u "+defaultWorkspaceUser+" -- env HOME=",
					"the smoke run keeps the inherited environment; env -i drops the NIX_LD vars nix-ld needs")
				// Exercise decoding and execution as the current test user on every
				// platform; assert the guest UID selection before invoking env.
				script = `runuser() { [ "$1" = -u ] && [ "$2" = developer ] && [ "$3" = -- ] || return 1; shift 3; "$@"; }` + "\n" + script

				script = strings.ReplaceAll(script, workspaceCodingHostB64Path, payload)
				script = strings.ReplaceAll(script, workspaceCodingHostPath, path)
				script = strings.ReplaceAll(script, workspaceCodingHostSmokeLog, filepath.Join(dir, "smoke.log"))
				output, err := exec.Command("bash", "-c", script).CombinedOutput()
				require.NoError(t, err, string(output))
				// A failed smoke run is reported, never acted on: the guest keeps
				// the staged binary either way.
				_, err = os.Stat(path)
				require.NoError(t, err, "the bootstrap must never delete a staged coding host")
				if broken {
					require.Contains(t, string(output), "coding host runtime smoke failed; keeping the staged binary")
				}
			})
		}
	}
}

// The coding host's flows exec the native jj helper, so every workspace kind
// must receive it next to the host, from the same image-path-or-env source.
func TestWorkspaceJJExportStagedAlongsideCodingHost(t *testing.T) {
	dir := t.TempDir()
	cli := []byte("#!/bin/sh\necho general-cli\n")
	host := []byte("#!/bin/sh\necho coding-host\n")
	export := []byte("#!/bin/sh\necho jj-export\n")
	for name, data := range map[string][]byte{"cli": cli, "host": host, "export": export} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), data, 0700))
	}
	t.Setenv(workspaceCLIBinaryEnv, filepath.Join(dir, "cli"))
	t.Setenv(workspaceCodingHostBinaryEnv, filepath.Join(dir, "host"))
	t.Setenv(workspaceJJExportBinaryEnv, filepath.Join(dir, "export"))
	req, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).buildWorkspaceVMRequest(context.Background(), "", nil, 0, "container")
	require.NoError(t, err)
	for path, expected := range map[string][]byte{
		workspaceSmithersCLIB64Path: cli,
		workspaceCodingHostB64Path:  host,
		workspaceJJExportB64Path:    export,
	} {
		data, err := base64.StdEncoding.DecodeString(req.Files[path].Content)
		require.NoError(t, err)
		decoder, err := gzip.NewReader(bytes.NewReader(data))
		require.NoError(t, err)
		actual, err := io.ReadAll(decoder)
		require.NoError(t, err)
		require.NoError(t, decoder.Close())
		require.Equal(t, expected, actual)
	}
	// Both bootstrap variants install the helper at the path coding.py's
	// JJ_HELPER and the flows' exporterPath default name.
	for _, script := range []string{buildWorkspaceClaudeBootstrapScript(), buildWorkspaceNixBootstrapScript()} {
		require.Contains(t, script, `install -m 0755 "`+workspaceJJExportPath+`".tmp "`+workspaceJJExportPath+`"`)
	}
}

// The staging knob defaults to the API image path, and an unreadable payload
// degrades to a warning instead of failing the provision.
func TestWorkspaceJJExportMissingPayloadDegrades(t *testing.T) {
	t.Setenv(workspaceJJExportBinaryEnv, filepath.Join(t.TempDir(), "absent"))
	files := map[string]sandbox.SandboxFile{}
	require.False(t, addWorkspaceJJExport(files))
	require.NotContains(t, files, workspaceJJExportB64Path)

	t.Setenv(workspaceJJExportBinaryEnv, "")
	require.Equal(t, "/usr/local/lib/smithers/smithers-jj-export", workspaceDefaultJJExportPath)
	require.False(t, addWorkspaceJJExport(map[string]sandbox.SandboxFile{}), "no such file in the test environment")
}

func TestWorkspaceJJExportStagingExecutesAndRefusesBrokenPayload(t *testing.T) {
	for _, nix := range []bool{false, true} {
		for _, broken := range []bool{false, true} {
			name := "container"
			if nix {
				name = "nixos"
			}
			if broken {
				name += "-broken"
			}
			t.Run(name, func(t *testing.T) {
				dir := t.TempDir()
				path := filepath.Join(dir, "smithers-jj-export")
				payload := filepath.Join(dir, "payload")
				helper := []byte("#!/bin/sh\n[ \"$1\" = --version ]\n")
				if broken {
					// Stands in for a guest whose loader cannot run the binary.
					helper = []byte("#!/bin/sh\necho 'no such file or directory' >&2\nexit 9\n")
				}
				require.NoError(t, os.WriteFile(path, helper, 0700))
				t.Setenv(workspaceJJExportBinaryEnv, path)
				files := map[string]sandbox.SandboxFile{}
				require.True(t, addWorkspaceJJExport(files))
				require.NoError(t, os.WriteFile(payload, []byte(files[workspaceJJExportB64Path].Content), 0600))
				script := buildWorkspaceClaudeBootstrapScript()
				if nix {
					script = buildWorkspaceNixBootstrapScript()
				}
				start := strings.Index(script, "# The native jj helper")
				end := strings.Index(script, "# End configured jj export staging.")
				require.Greater(t, end, start)
				script = "set -euo pipefail\n" + script[start:end]
				require.Contains(t, script, "runuser -u "+defaultWorkspaceUser+" -- env HOME=",
					"the smoke run keeps the inherited environment; env -i drops the NIX_LD vars nix-ld needs")
				script = `runuser() { [ "$1" = -u ] && [ "$2" = developer ] && [ "$3" = -- ] || return 1; shift 3; "$@"; }` + "\n" + script

				script = strings.ReplaceAll(script, workspaceJJExportB64Path, payload)
				script = strings.ReplaceAll(script, workspaceJJExportPath, path)
				script = strings.ReplaceAll(script, workspaceJJExportSmokeLog, filepath.Join(dir, "smoke.log"))
				output, err := exec.Command("bash", "-c", script).CombinedOutput()
				require.NoError(t, err, string(output))
				// Prod 2026-09-15: the NixOS bootstrap runs before activation links
				// /lib64/ld-linux-x86-64.so.2, so the smoke run of the dynamic
				// helper failed and the old script deleted it, leaving the guest
				// with no exporter at all. A helper that is merely unverified is
				// always better than a missing one.
				info, err := os.Stat(path)
				require.NoError(t, err, "the bootstrap must never delete a staged jj export helper")
				require.Equal(t, os.FileMode(0755), info.Mode().Perm())
				if broken {
					require.Contains(t, string(output), "jj export helper runtime smoke failed; keeping the staged binary")
					require.Contains(t, string(output), "jj export smoke: no such file or directory",
						"the real smoke output is echoed, not discarded")
				}
			})
		}
	}
}
