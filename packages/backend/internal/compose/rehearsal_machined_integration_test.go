package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestRehearsalMachinedNativeFilesystem(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
	if binary == "" {
		t.Skip("requires the real rehearsal_daemon binary and Linux user namespaces")
	}
	root := t.TempDir()
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	init := exec.Command(jj, "git", "init", root)
	output, err := init.CombinedOutput()
	require.NoError(t, err, string(output))
	const branch = "731f7b03-e381-4af6-b744-16e26f1f327e"
	hostRepo := t.TempDir()
	hostInit := exec.Command("/usr/bin/git", "init", "--bare", hostRepo)
	output, err = hostInit.CombinedOutput()
	require.NoError(t, err, string(output))
	registry := new(machined.Registry)
	registry.BindObjectImporter(machined.GitBundleImporter(func(_ context.Context, id string) (string, error) {
		if id != branch {
			return "", machined.ErrUnauthorized
		}
		return hostRepo, nil
	}))
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	require.NoError(t, startRehearsalMachined(t, ctx, registry, branch, root, t.TempDir(), binary, &machined.ItemBinding{}))
	require.NoError(t, os.WriteFile(filepath.Join(root, "outside.txt"), []byte("outside\n"), 0600))
	file, err := registry.ReadFile(ctx, branch, "outside.txt", "")
	require.NoError(t, err)
	require.Equal(t, []byte("outside\n"), file.Content)
	_, err = registry.ReadFile(ctx, branch, "../etc/passwd", "")
	require.Error(t, err)
	watchCtx, stopWatch := context.WithTimeout(ctx, 15*time.Second)
	defer stopWatch()
	var event machined.Event
	for event.Seq == 0 {
		event, err = registry.Events(branch).Receive(watchCtx)
		require.NoError(t, err)
	}
	burst, err := wire.DecodeBurst(event.Payload)
	require.NoError(t, err)
	require.Equal(t, byte(4), burst.Actor.Kind, "unregistered host writes are outside changes")
	require.Len(t, burst.Files, 1)
	require.Equal(t, "outside.txt", burst.Files[0].Path)
	require.Equal(t, "added", burst.Files[0].Change)
	sum := sha256.Sum256([]byte("outside\n"))
	require.Equal(t, hex.EncodeToString(sum[:]), burst.Files[0].PostDigest)
	missing, err := (machined.GitBurstObjects{Resolve: func(context.Context, string) (string, error) { return hostRepo, nil }}).VerifyBurst(ctx, branch, burst)
	require.NoError(t, err)
	require.Empty(t, missing, "the real daemon transferred all retained outside-change objects")

}

// The example is never part of an install bundle or run by root. Build from
// this lane, matching the other rehearsal hosts, unless a binary is explicit.
func buildRehearsalMachined(t *testing.T, root string) string {
	t.Helper()
	if binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY"); binary != "" {
		return binary
	}
	target := filepath.Join(root, ".artifacts", "rehearsal-machined")
	build := exec.Command("cargo", "build", "--locked", "-p", "smithers-machined", "--example", "rehearsal_daemon", "--target-dir", target)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	return filepath.Join(target, "debug", "examples", "rehearsal_daemon")
}
