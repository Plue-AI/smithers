package compose

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/stretchr/testify/require"
)

// Real PostgreSQL, native repository engine/maintenance exclusion and mutually
// authenticated host link. Only the guest is a scripted wire peer; this does
// not certify capture/event ACKs, real-machine confinement or sleep.
func TestMachineObjectsProductionBinding(t *testing.T) {
	b := newRelayBoxes(t)
	branch := b.box(b.repo, b.machines, "running", b.owner)
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	require.NotEmpty(t, library, "native repository library required")
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "machine-objects-test"}
	repoPath := cfg.RepoPath(b.login, "repo")
	_, err := native.InitRepo(repoPath)
	require.NoError(t, err)
	store := filepath.Join(repoPath, ".jj", "repo", "store", "git")
	git := func(args ...string) string {
		t.Helper()
		out, err := hostexec.Git(t.Context(), append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null"}, args...)...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	source := filepath.Join(t.TempDir(), "source")
	git("init", "--initial-branch=main", source)
	require.NoError(t, os.WriteFile(filepath.Join(source, "task.txt"), []byte("original\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "base")
	base := git("-C", source, "rev-parse", "HEAD")
	git("-C", store, "fetch", source, "main:refs/heads/main")
	require.NoError(t, native.ImportGitRefs(repoPath))
	require.NoError(t, os.WriteFile(filepath.Join(source, "task.txt"), []byte("captured member work\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "capture")
	head := git("-C", source, "rev-parse", "HEAD")
	git("-C", source, "update-ref", "refs/heads/guest-chosen", head)
	bundle := filepath.Join(t.TempDir(), "snapshot.bundle")
	git("-C", source, "bundle", "create", bundle, "--all")
	data, err := os.ReadFile(bundle)
	require.NoError(t, err)
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(http.NotFoundHandler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	registry := new(machined.Registry)
	stop := bindMachineObjects(t.Context(), registry, b.pool, client)
	t.Cleanup(stop)
	_, peer := presenceTestLink(t, registry, branch)
	require.NoError(t, peer.SetDeadline(time.Now().Add(10*time.Second)))
	send := func(peer net.Conn, stream uint32) {
		t.Helper()
		for offset := 0; offset < len(data); {
			n := min(65536, len(data)-offset)
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: append([]byte{1, 0}, data[offset:offset+n]...)}))
			window, err := wire.Read(peer)
			require.NoError(t, err)
			require.Equal(t, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: append([]byte{6}, wire.U32(uint32(n))...)}, window)
			offset += n
		}
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: []byte{2, 0}}))
	}
	send(peer, 8)
	closed, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, wire.Frame{Kind: wire.Objects, Stream: 8, Payload: []byte{7}}, closed)
	require.Equal(t, head, git("-C", store, "rev-parse", "refs/smithers/branches/"+branch+"/incoming/"+head))
	require.Equal(t, base, git("-C", store, "rev-parse", "refs/heads/main"))
	require.Empty(t, git("-C", store, "for-each-ref", "--format=%(refname)", "refs/heads/guest-chosen"))
	git("-C", store, "gc", "--prune=now")
	require.Equal(t, "captured member work", git("-C", store, "show", head+":task.txt"))
	var count int
	require.NoError(t, b.pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts WHERE workspace_id=$1`, branch).Scan(&count))
	require.Zero(t, count, "object stream close does not acknowledge a captured event")
	row, err := b.GetWorkspace(t.Context(), branch)
	require.NoError(t, err)
	require.Empty(t, row.HeadCommitID, "capture publication is a separate verified transaction")
	file, err := os.Open(bundle)
	require.NoError(t, err)
	defer file.Close()
	importer := machineObjectImporter(t.Context(), b.pool, client)
	for _, id := range []string{"not-a-uuid", strings.ToUpper(branch), "11111111-1111-4111-8111-111111111111"} {
		require.ErrorIs(t, importer(t.Context(), id, file), machined.ErrUnauthorized)
	}
	for _, change := range []struct {
		sql     string
		restore string
	}{
		{`UPDATE workspaces SET vm_id='' WHERE id=$1`, `UPDATE workspaces SET vm_id='restored-machine' WHERE id=$1`},
		{`UPDATE workspaces SET status='failed' WHERE id=$1`, `UPDATE workspaces SET status='running' WHERE id=$1`},
	} {
		b.exec(change.sql, branch)
		require.ErrorIs(t, importer(t.Context(), branch, file), machined.ErrUnauthorized)
		b.exec(change.restore, branch)
	}
	require.Error(t, machineObjectImporter(t.Context(), b.pool, &repohost.Client{})(t.Context(), branch, file), "an unbound repository port cannot certify an import")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, importer(ctx, branch, file), context.Canceled)
	// A new process may reconnect the same branch before ready. Stopping this
	// composition also disables the importer retained by an existing link.
	_, peer2 := presenceTestLink(t, registry, branch)
	require.NoError(t, peer2.SetDeadline(time.Now().Add(10*time.Second)))
	stop()
	send(peer2, 9)
	_, err = wire.Read(peer2)
	require.Error(t, err, "shutdown must not certify stored bytes on an old link")
	require.Equal(t, base, git("-C", store, "rev-parse", "refs/heads/main"))
}
