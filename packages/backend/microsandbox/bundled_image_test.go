package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// These startup tests drive New through a recording CLI without virtualization.
// It reports an empty machine inventory; it never executes guest/root code.
func TestInstalledRuntimeLoadsOnlyVerifiedBundledImage(t *testing.T) {
	for _, fault := range []string{"", "missing", "changed", "load-failed"} {
		t.Run(fault, func(t *testing.T) {
			bundle, files := approvedBundleFixture(t)
			archive := "share/microsandbox/base-image.oci.tar"
			files[archive] = []byte("approved OCI fixture")
			log := filepath.Join(filepath.Dir(bundle), "image-argv")
			files["bin/msb"] = []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + log + "'\ncase \"$1\" in\nimage) " + map[bool]string{true: "exit 1", false: "exit 0"}[fault == "load-failed"] + ";;\ncreate) exit 2;;\n*) printf '[]\\n';;\nesac\n")
			for name, data := range files {
				target := filepath.Join(bundle, name)
				require.NoError(t, os.MkdirAll(filepath.Dir(target), 0755))
				require.NoError(t, os.WriteFile(target, data, 0755))
				require.NoError(t, os.Chmod(target, 0755))
			}
			var entries []map[string]any
			for name, data := range files {
				sum := sha256.Sum256(data)
				entries = append(entries, map[string]any{"path": name, "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": 0755})
			}
			writeBundleManifest(t, bundle, entries)
			pinnedBundle := pinned(t, bundle)
			if fault == "missing" {
				require.NoError(t, os.Remove(filepath.Join(bundle, archive)))
			}
			if fault == "changed" {
				require.NoError(t, os.WriteFile(filepath.Join(bundle, archive), []byte("branch bytes"), 0755))
			}
			runtime, err := New(context.Background(), Config{Bundle: pinnedBundle, Root: filepath.Join(bundletest.ProtectedTempDir(t), "state"), SkipQualification: true, CPUs: 1, MemoryMiB: 512, DiskMiB: 2048, MaxRunningVMs: 1})
			if fault != "" {
				require.ErrorIs(t, err, ErrUnavailable)
				require.Nil(t, runtime)
			} else {
				require.NoError(t, err)
				_, bootErr := runtime.CreateWorkspace(operation("offline-boot"), workspaceapi.WorkspaceSpec{ID: "offline-boot"})
				require.ErrorIs(t, bootErr, ErrUnavailable)
				require.NoError(t, runtime.Close())
			}
			data, readErr := os.ReadFile(log)
			if fault == "missing" || fault == "changed" {
				require.ErrorIs(t, readErr, os.ErrNotExist, "unverified bytes never reach msb")
			} else {
				require.NoError(t, readErr)
				if fault == "" {
					require.Contains(t, string(data), "create node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b --pull never --root-disk 2048M")
				} else {
					require.NotContains(t, string(data), "create ")
				}
				require.True(t, strings.HasPrefix(string(data), "image load --input "+filepath.Join(bundle, archive)+" --tag node@sha256:71fed097c6e5bae40e1aff698793dda483e2380cc2530d7367a72a9d037c798b\n"), string(data))
			}
		})
	}
}
