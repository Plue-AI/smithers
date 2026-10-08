package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	client := repohost.NewLocalClient(server.Handler(), cfg.AuthToken)
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
		ID    string `json:"id"`
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
	// A later actor-independent burst changes/deletes the same paths. The
	// first selection must keep its own end state rather than the new disk.
	require.NoError(t, os.WriteFile(filepath.Join(root, "outside-00.ts"), []byte("later\n"), 0600))
	require.NoError(t, os.Remove(filepath.Join(root, "outside-01.ts")))
	require.NoError(t, os.WriteFile(filepath.Join(root, "outside-02.ts"), []byte{0, 'b', 'i', 'n'}, 0600))
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&n)
		return err == nil && n == 2
	}, 20*time.Second, 100*time.Millisecond)
	var laterEntry string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT data->>'id' FROM product_job_events WHERE event_type='branch.burst' ORDER BY sequence DESC LIMIT 1`).Scan(&laterEntry))
	require.NotEqual(t, entries[0].ID, laterEntry)
	require.NoError(t, registry.Close()) // retained objects require no live machine
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	q := db.New(f.pool)
	workspace := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceInstallAuthorization(q), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)), services.WithWorkspaceBurstVersions(f.pool, client))
	install := testConfigAllFlagsOn()
	install.Auth.Mode = "selfhost"
	install.Auth.SessionCookieName = "session"
	install.Server.PublicURL = f.origin
	install.Server.AllowedOrigins = []string{f.origin}
	router := githubAppSetupComposeRouter(install, f.pool, nil, &routes.WorkspaceHandler{Service: workspace})
	readDiff := func(branch, selector, cookie string, status int) services.BranchDiff {
		t.Helper()
		req := httptest.NewRequest("GET", f.origin+"/api/branches/"+branch+"/diff"+selector, nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		req.RemoteAddr = "127.0.0.1:61000"
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, status, rec.Code, rec.Body.String())
		var diff services.BranchDiff
		if status == 200 {
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &diff))
		}
		return diff
	}
	diff := readDiff(f.row.ID, "?entry="+entries[0].ID, f.cookie, 200)
	require.Len(t, diff.Files, 12)
	for i, file := range diff.Files {
		require.Equal(t, fmt.Sprintf("outside-%02d.ts", i), file.Path)
		require.Equal(t, "burst", file.Against.Kind)
		require.JSONEq(t, `{"kind":"outside","color_index":7}`, string(file.Against.Actor))
		require.Equal(t, entries[0].Versions, file.Version)
		require.Equal(t, []services.BranchDiffHunk{{OldStart: 0, NewStart: 1, Lines: []services.BranchDiffLine{{Op: "+", Text: fmt.Sprintf("outside %02d", i)}}}}, file.Hunks)
	}
	laterDiff := readDiff(f.row.ID, "?entry="+laterEntry, f.cookie, 200)
	require.Len(t, laterDiff.Files, 3)
	require.Equal(t, "modified", laterDiff.Files[0].Change)
	require.Equal(t, []services.BranchDiffLine{{Op: "-", Text: "outside 00"}, {Op: "+", Text: "later"}}, laterDiff.Files[0].Hunks[0].Lines)
	require.Equal(t, "deleted", laterDiff.Files[1].Change)
	require.Equal(t, "absent", laterDiff.Files[1].PostDigest)
	require.Equal(t, []services.BranchDiffLine{{Op: "-", Text: "outside 01"}}, laterDiff.Files[1].Hunks[0].Lines)
	require.Equal(t, &services.BranchDiffBinary{BeforeBytes: 11, AfterBytes: 4}, laterDiff.Files[2].Binary)
	require.Empty(t, laterDiff.Files[2].Hunks)
	readDiff(f.row.ID, "?entry="+entries[0].ID, "", 401)
	readDiff(f.row.ID, "?entry="+entries[0].ID+"&at="+strings.Repeat("a", 40), f.cookie, 400)
	readDiff(f.row.ID, "?entry=invalid", f.cookie, 400)
	readDiff(f.row.ID, "?entry=00000000-0000-0000-0000-000000000001", f.cookie, 404)
	readDiff("00000000-0000-0000-0000-000000000001", "?entry="+entries[0].ID, f.cookie, 404)

	refs, err := exec.Command("/usr/bin/git", "-C", store, "for-each-ref", "--format=%(objectname)", "refs/smithers/branches/"+f.row.ID+"/bursts/").CombinedOutput()
	require.NoError(t, err, string(refs))
	require.Contains(t, string(refs), entries[0].Versions+"\n")
	require.Len(t, strings.Fields(string(refs)), 2)
	for i, file := range entries[0].Files {
		require.Equal(t, fmt.Sprintf("outside-%02d.ts", i), file.Path)
		bytes := []byte(fmt.Sprintf("outside %02d\n", i))
		sum := sha256.Sum256(bytes)
		var digest string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT post_digest FROM burst_files WHERE path=$1 AND post_digest=$2`, file.Path, hex.EncodeToString(sum[:])).Scan(&digest))
		require.Equal(t, hex.EncodeToString(sum[:]), digest)
		got, err := exec.Command("/usr/bin/git", "-C", store, "cat-file", "blob", file.AfterBlob).CombinedOutput()
		require.NoError(t, err, string(got))
		require.Equal(t, bytes, got)
	}
}
