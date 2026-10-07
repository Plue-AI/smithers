package compose

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/stretchr/testify/require"
)

// Real one-connection PostgreSQL pool, native host repository and authenticated
// wire consumer. The guest and recovery projection are fixture collaborators;
// this does not claim the unfinished TODO recovery workflow is activated.
func TestMachineCaptureTransactionBinding(t *testing.T) {
	b := newRelayBoxes(t)
	branch := b.box(b.repo, b.machines, "running", b.owner)
	other := b.box(b.other, b.machines, "running", b.owner)
	config, err := pgxpool.ParseConfig(b.pool.Config().ConnString())
	require.NoError(t, err)
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(t.Context(), `CREATE TABLE capture_recovery_probe(head text PRIMARY KEY, applied boolean NOT NULL)`)
	require.NoError(t, err)
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	require.NotEmpty(t, library)
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "capture-test"}
	path := cfg.RepoPath(b.login, "repo")
	_, err = native.InitRepo(path)
	require.NoError(t, err)
	_, err = native.InitRepo(cfg.RepoPath(b.login, "other"))
	require.NoError(t, err)
	store := filepath.Join(path, ".jj", "repo", "store", "git")
	git := func(input string, args ...string) string {
		t.Helper()
		cmd := hostexec.Git(t.Context(), append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", "-C", store}, args...)...)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	baseTree := git("", "mktree")
	base := git("base\n", "commit-tree", baseTree)
	capture := func(text string) wire.Captured {
		blob := git(text, "hash-object", "-w", "--stdin")
		tree := git("100644 blob "+blob+"\tmember.txt\n", "mktree")
		head := git("snapshot\n", "commit-tree", tree, "-p", base)
		return wire.Captured{Head: head, Tree: tree, Base: base}
	}
	first, stale := capture("first member save\n"), capture("concurrent member save\n")
	ref := "refs/smithers/branches/" + branch + "/head"
	git("", "update-ref", ref, base)
	_, err = pool.Exec(t.Context(), `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, branch, base)
	require.NoError(t, err)
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(http.NotFoundHandler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	var fail atomic.Bool
	fail.Store(true)
	recovery := func(ctx context.Context, tx pgx.Tx, b string, c wire.Captured, applied bool) error {
		_, err := tx.Exec(ctx, `INSERT INTO capture_recovery_probe(head,applied) VALUES($1,$2)`, c.Head, applied)
		if err != nil {
			return err
		}
		if fail.Load() {
			return errors.New("injected projection rollback")
		}
		return nil
	}
	registry := new(machined.Registry)
	ingestor := &machined.Ingestor{Pool: pool, Write: machineCaptureWriter(client, recovery)}
	stop, err := registry.ConsumeEvents(t.Context(), func(ctx context.Context, l *machined.Link, b string, e machined.Event) (machined.Acknowledgement, error) {
		return ingestor.Commit(ctx, l.Connection, b, e)
	})
	require.NoError(t, err)
	t.Cleanup(stop)
	event := func(seq uint64, id byte, c wire.Captured) machined.Event {
		decode := func(s string) []byte { v, e := hex.DecodeString(s); require.NoError(t, e); return v }
		return machined.Event{Seq: seq, EventID: [16]byte{id}, Payload: wire.Union(2, wire.Field(1, decode(c.Head)), wire.Field(2, decode(c.Tree)), wire.Field(3, decode(c.Base)))}
	}
	send := func(peer net.Conn, e machined.Event) {
		t.Helper()
		require.NoError(t, peer.SetDeadline(time.Now().Add(5*time.Second)))
		require.NoError(t, wire.Write(peer, transcriptEventFrame(e)))
	}
	ack := func(peer net.Conn, seq uint64, outcome machined.AckOutcome) {
		t.Helper()
		frame, e := wire.Read(peer)
		require.NoError(t, e)
		require.Equal(t, wire.Events, frame.Kind)
		require.Equal(t, byte(3), frame.Payload[0])
		fields, e := wire.Fields("ack", frame.Payload[1:])
		require.NoError(t, e)
		require.Equal(t, seq, binary.BigEndian.Uint64(fields[1]))
		require.Equal(t, []byte{byte(outcome)}, fields[2])
	}
	count := func(table string, want int) {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(t.Context(), "SELECT count(*) FROM "+table).Scan(&n))
		require.Equal(t, want, n, table)
	}
	head := func(want string) {
		t.Helper()
		var got string
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&got))
		require.Equal(t, want, got)
	}
	_, peer := presenceTestLink(t, registry, branch)
	e := event(1, 1, first)
	send(peer, e)
	_, err = wire.Read(peer)
	require.Error(t, err, "failed recovery projection cannot acknowledge capture")
	count("machine_event_receipts", 0)
	count("capture_recovery_probe", 0)
	count("product_job_events", 0)
	head(base)
	require.Equal(t, first.Head, git("", "rev-parse", ref), "native publication survives SQL rollback")
	fail.Store(false)
	_, peer = presenceTestLink(t, registry, branch)
	e.Seq = 8
	send(peer, e)
	ack(peer, 8, machined.AckApplied)
	count("machine_event_receipts", 1)
	count("capture_recovery_probe", 1)
	head(first.Head)
	e.Seq = 9
	send(peer, e)
	ack(peer, 9, machined.AckDuplicate)
	count("capture_recovery_probe", 1)
	send(peer, event(10, 2, stale))
	ack(peer, 10, machined.AckStaleBase)
	count("capture_recovery_probe", 2)
	head(first.Head)
	var applied bool
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT applied FROM capture_recovery_probe WHERE head=$1`, stale.Head).Scan(&applied))
	require.False(t, applied)
	git("", "gc", "--prune=now")
	require.Equal(t, "concurrent member save", git("", "show", "refs/smithers/branches/"+branch+"/captures/"+stale.Head+":member.txt"))
	// The other authenticated branch uses its own repository, which has none
	// of these objects. No receipt/projection can borrow the first branch's store.
	_, foreignPeer := presenceTestLink(t, registry, other)
	send(foreignPeer, event(1, 3, first))
	ack(foreignPeer, 1, machined.AckMissingObjects)
	count("machine_event_receipts", 2)
	count("capture_recovery_probe", 2)
	// Missing recovery is refused before native publication even with a valid
	// store and connection. The single pool connection is the caller's transaction.
	tx, err := pool.Begin(t.Context())
	require.NoError(t, err)
	_, err = machineCaptureWriter(client, nil)(t.Context(), tx, branch, event(11, 4, first))
	require.ErrorIs(t, err, machined.ErrNotReady)
	require.NoError(t, tx.Rollback(t.Context()))
	require.Equal(t, first.Head, git("", "rev-parse", ref))
}
