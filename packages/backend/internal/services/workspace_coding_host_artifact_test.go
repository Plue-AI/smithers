package services

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceCodingHostAndNpmCLI(t *testing.T) {
	dir := t.TempDir()
	host := []byte("#!/bin/sh\necho coding-host\n")
	for name, data := range map[string][]byte{"host": host, "cli.tar": []byte("npm package archive")} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), data, 0700))
	}
	t.Setenv(workspaceCodingHostBinaryEnv, filepath.Join(dir, "host"))
	t.Setenv(workspaceCLIPackageEnv, filepath.Join(dir, "cli.tar"))
	req, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).buildWorkspaceVMRequest(context.Background(), "", nil, 0, "", "container")
	require.NoError(t, err)
	require.Contains(t, buildWorkspaceClaudeBootstrapScript(), "/usr/local/lib/smithers-cli/node_modules/@smthrs/cli/bin/smithers.mjs")
	require.NotContains(t, buildWorkspaceClaudeBootstrapScript(), "init --global")
	for path, expected := range map[string][]byte{workspaceCodingHostB64Path: host, workspaceCLIPackageB64Path + ".part0000": []byte("npm package archive")} {
		data, err := base64.StdEncoding.DecodeString(req.Files[path].Content)
		require.NoError(t, err)
		decoder, err := gzip.NewReader(bytes.NewReader(data))
		require.NoError(t, err)
		actual, err := io.ReadAll(decoder)
		require.NoError(t, err)
		require.NoError(t, decoder.Close())
		require.Equal(t, expected, actual)
	}
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
	host := []byte("#!/bin/sh\necho coding-host\n")
	export := []byte("#!/bin/sh\necho jj-export\n")
	for name, data := range map[string][]byte{"host": host, "export": export} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), data, 0700))
	}
	t.Setenv(workspaceCodingHostBinaryEnv, filepath.Join(dir, "host"))
	t.Setenv(workspaceJJExportBinaryEnv, filepath.Join(dir, "export"))
	req, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).buildWorkspaceVMRequest(context.Background(), "", nil, 0, "", "container")
	require.NoError(t, err)
	for path, expected := range map[string][]byte{
		workspaceCodingHostB64Path: host,
		workspaceJJExportB64Path:   export,
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

func TestWorkspaceNpmCLIPackageSplitsGuestFrames(t *testing.T) {
	raw := make([]byte, 13<<20)
	_, err := rand.Read(raw)
	require.NoError(t, err)
	archive := filepath.Join(t.TempDir(), "cli.tar")
	require.NoError(t, os.WriteFile(archive, raw, 0600))
	t.Setenv(workspaceCLIPackageEnv, archive)
	files := map[string]sandbox.SandboxFile{}
	require.True(t, addWorkspaceCLI(files))
	require.NotContains(t, files, workspaceCLIPackageB64Path)
	require.Greater(t, len(files), 1)
	names := make([]string, 0, len(files))
	for name, file := range files {
		require.LessOrEqual(t, len(file.Content), 16<<20)
		require.Less(t, base64.StdEncoding.EncodedLen(len(file.Content)), 64<<20)
		names = append(names, name)
	}
	sort.Strings(names)
	var encoded strings.Builder
	for _, name := range names {
		encoded.WriteString(files[name].Content)
	}
	compressed, err := base64.StdEncoding.DecodeString(encoded.String())
	require.NoError(t, err)
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	require.NoError(t, err)
	actual, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	require.Equal(t, raw, actual)
}

func TestWorkspaceNpmCLIStagingExecutes(t *testing.T) {
	for _, nix := range []bool{false, true} {
		t.Run(fmt.Sprintf("nix=%t", nix), func(t *testing.T) {
			dir := t.TempDir()
			var archive bytes.Buffer
			writer := tar.NewWriter(&archive)
			script := []byte("#!/bin/sh\n[ \"$1\" = --help ]\n")
			require.NoError(t, writer.WriteHeader(&tar.Header{Name: "node_modules/@smthrs/cli/bin/smithers.mjs", Mode: 0755, Size: int64(len(script))}))
			_, err := writer.Write(script)
			require.NoError(t, err)
			require.NoError(t, writer.Close())
			source := filepath.Join(dir, "cli.tar")
			require.NoError(t, os.WriteFile(source, archive.Bytes(), 0600))
			t.Setenv(workspaceCLIPackageEnv, source)
			files := map[string]sandbox.SandboxFile{}
			require.True(t, addWorkspaceCLI(files))
			payload := filepath.Join(dir, "payload")
			for name, file := range files {
				require.NoError(t, os.WriteFile(strings.ReplaceAll(name, workspaceCLIPackageB64Path, payload), []byte(file.Content), 0600))
			}
			bootstrap := buildWorkspaceClaudeBootstrapScript()
			if nix {
				bootstrap = buildWorkspaceNixBootstrapScript()
			}
			start := strings.Index(bootstrap, "# Install the deployed npm package")
			end := strings.Index(bootstrap[start:], "if [ -x") + start
			require.Greater(t, end, start)
			bootstrap = "set -euo pipefail\n" + bootstrap[start:end]
			bin := filepath.Join(dir, "bin")
			require.NoError(t, os.Mkdir(bin, 0755))
			bootstrap = strings.ReplaceAll(bootstrap, workspaceCLIPackageB64Path, payload)
			bootstrap = strings.ReplaceAll(bootstrap, workspaceCLIPackageDir, filepath.Join(dir, "installed"))
			bootstrap = strings.ReplaceAll(bootstrap, workspaceLocalBinDir, bin)
			bootstrap = strings.ReplaceAll(bootstrap, "/tmp/smithers-workspace-cli-help.log", filepath.Join(dir, "help.log"))
			output, err := exec.Command("bash", "-c", bootstrap).CombinedOutput()
			require.NoError(t, err, string(output))
			require.NotContains(t, string(output), "failed")
			target, err := os.Readlink(filepath.Join(bin, "smithers"))
			require.NoError(t, err)
			require.Equal(t, filepath.Join(dir, "installed/node_modules/@smthrs/cli/bin/smithers.mjs"), target)
			output, err = exec.Command(filepath.Join(bin, "smthrs"), "--help").CombinedOutput()
			require.NoError(t, err, string(output))
		})
	}
}
