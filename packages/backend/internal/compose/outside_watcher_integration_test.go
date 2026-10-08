package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/stretchr/testify/require"
)

// Linux qualification of real outside writes through the installed watcher,
// bundle transfer, transactional host ingest and the composed /api/live door.
// An empty broker census deliberately qualifies only outside attribution.
func TestOutsideWatcherComposedInstallLive(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
	if binary == "" {
		t.Skip("requires installed rehearsal daemon and Linux user namespaces")
	}
	f := presenceInstall(t, true)
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "outside-watcher"}
	repo := cfg.RepoPath("presence-owner", "app")
	_, err = native.InitRepo(repo)
	require.NoError(t, err)
	store := filepath.Join(repo, ".jj", "repo", "store", "git")
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(http.NotFoundHandler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	registry := new(machined.Registry)
	registry.BindObjectImporter(machined.GitBundleImporter(func(_ context.Context, branch string) (string, error) {
		if branch != f.row.ID {
			return "", machined.ErrUnauthorized
		}
		return store, nil
	}))
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	stop, err := bindMachineEvents(ctx, registry, f.pool, client, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	root := t.TempDir()
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	output, err := exec.Command(jj, "git", "init", root).CombinedOutput()
	require.NoError(t, err, string(output))
	require.NoError(t, startRehearsalMachined(t, ctx, registry, f.row.ID, root, t.TempDir(), binary, &machined.ItemBinding{}))
	socket := f.dial(t)
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s:activity"}`, f.row.ID))
	readPresenceFrame(t, socket)
	for i := 0; i < 12; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(root, fmt.Sprintf("outside-%02d.ts", i)), []byte(fmt.Sprintf("outside %02d\n", i)), 0600))
	}
	var entries []struct {
		Actor struct{ Kind string }
		Files []struct {
			Path      string
			AfterBlob string `json:"after_blob"`
		}
		Versions string
	}
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(ctx, `SELECT count(*) FROM burst_files WHERE path LIKE 'outside-%'`).Scan(&n)
		return err == nil && n == 12
	}, 20*time.Second, 100*time.Millisecond)
	// The already-open subscription receives the committed activity delta.
	delta := readPresenceFrame(t, socket)
	require.NoError(t, json.Unmarshal(delta.Data, &entries))
	require.Len(t, entries, 1)
	require.Equal(t, "outside", entries[0].Actor.Kind)
	require.Len(t, entries[0].Files, 12)
	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, registry.Close()) // retained objects require no live machine
	refs, err := exec.Command("/usr/bin/git", "-C", store, "for-each-ref", "--format=%(objectname)", "refs/smithers/branches/"+f.row.ID+"/bursts/").CombinedOutput()
	require.NoError(t, err, string(refs))
	require.Equal(t, entries[0].Versions+"\n", string(refs))
	for i, file := range entries[0].Files {
		require.Equal(t, fmt.Sprintf("outside-%02d.ts", i), file.Path)
		bytes := []byte(fmt.Sprintf("outside %02d\n", i))
		sum := sha256.Sum256(bytes)
		var digest string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT post_digest FROM burst_files WHERE path=$1`, file.Path).Scan(&digest))
		require.Equal(t, hex.EncodeToString(sum[:]), digest)
		got, err := exec.Command("/usr/bin/git", "-C", store, "cat-file", "blob", file.AfterBlob).CombinedOutput()
		require.NoError(t, err, string(got))
		require.Equal(t, bytes, got)
	}
}
