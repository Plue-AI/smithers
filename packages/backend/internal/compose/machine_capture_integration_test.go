package compose

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Real one-connection PostgreSQL pool, native host repository and authenticated
// wire consumer and real capture projection. Only the guest is a fixture;
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
	_, err = pool.Exec(t.Context(), `ALTER TABLE product_job_events ADD CONSTRAINT reject_capture CHECK (event_type <> 'branch.captured')`)
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
	registry := new(machined.Registry)
	ingestor := &machined.Ingestor{Pool: pool, Prepare: prepareMachineCaptureWriter(client)}
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
	pending := func(want *services.MachineCapturePending) {
		t.Helper()
		var raw []byte
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT capture_pending FROM workspaces WHERE id=$1`, branch).Scan(&raw))
		if want == nil {
			require.Empty(t, raw)
			return
		}
		var got services.MachineCapturePending
		require.NoError(t, json.Unmarshal(raw, &got))
		require.Equal(t, *want, got)
	}
	_, peer := presenceTestLink(t, registry, branch)
	e := event(1, 1, first)
	send(peer, e)
	_, err = wire.Read(peer)
	require.Error(t, err, "failed recovery projection cannot acknowledge capture")
	count("machine_event_receipts", 0)
	pending(nil)
	count("product_job_events", 0)
	head(base)
	require.Equal(t, first.Head, git("", "rev-parse", ref), "native publication survives SQL rollback")
	_, err = pool.Exec(t.Context(), `ALTER TABLE product_job_events DROP CONSTRAINT reject_capture`)
	require.NoError(t, err)
	_, peer = presenceTestLink(t, registry, branch)
	e.Seq = 8
	send(peer, e)
	ack(peer, 8, machined.AckApplied)
	count("machine_event_receipts", 1)
	pending(nil)
	head(first.Head)
	e.Seq = 9
	send(peer, e)
	ack(peer, 9, machined.AckDuplicate)
	pending(nil)
	send(peer, event(10, 2, stale))
	ack(peer, 10, machined.AckStaleBase)
	pending(&services.MachineCapturePending{Head: stale.Head, Tree: stale.Tree, Base: stale.Base, Onto: first.Head, Stale: true})
	head(first.Head)
	git("", "gc", "--prune=now")
	require.Equal(t, "concurrent member save", git("", "show", "refs/smithers/branches/"+branch+"/captures/"+stale.Head+":member.txt"))
	// The other authenticated branch uses its own repository, which has none
	// of these objects. No receipt/projection can borrow the first branch's store.
	_, foreignPeer := presenceTestLink(t, registry, other)
	send(foreignPeer, event(1, 3, first))
	ack(foreignPeer, 1, machined.AckMissingObjects)
	count("machine_event_receipts", 2)
	pending(&services.MachineCapturePending{Head: stale.Head, Tree: stale.Tree, Base: stale.Base, Onto: first.Head, Stale: true})
	// Missing repository capability is refused before native publication with a valid
	// store and connection. The single pool connection is the caller's transaction.
	tx, err := pool.Begin(t.Context())
	require.NoError(t, err)
	_, err = prepareMachineCaptureWriter(nil)(t.Context(), tx, branch, event(11, 4, first))
	require.ErrorIs(t, err, machined.ErrNotReady)
	require.NoError(t, tx.Rollback(t.Context()))
	require.Equal(t, first.Head, git("", "rev-parse", ref))
	// A successful later capture cannot discharge an earlier stale snapshot.
	send(peer, event(12, 5, first))
	ack(peer, 12, machined.AckApplied)
	pending(&services.MachineCapturePending{Head: stale.Head, Tree: stale.Tree, Base: stale.Base, Onto: first.Head, Stale: true})

	t.Run("TODO verification follows captured bytes", func(t *testing.T) {
		todoBranch := b.box(b.repo, b.machines, "running", b.owner)
		todoRef := "refs/smithers/branches/" + todoBranch + "/head"
		git("", "update-ref", todoRef, base)
		_, err := pool.Exec(t.Context(), `INSERT INTO mythical_stacks(repository_id,state,landed_main) VALUES($1,'active',$2)`, b.repo.ID, base)
		require.NoError(t, err)
		var id string
		require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO mythical_items(repository_id,source,state,workspace_id,candidate_base,candidate_head,candidate_verified,attempt,generation,request_run_id,checks)
   VALUES($1,'todo','proposed',$2,$3,$4,true,3,9,'retained-run','{"todo":true,"land":{"head":"approved"},"attempts":[]}') RETURNING id::text`, b.repo.ID, todoBranch, base, first.Head).Scan(&id))
		read := func() db.MythicalItem {
			var itemID pgtype.UUID
			require.NoError(t, itemID.Scan(id))
			item, err := db.New(pool).GetMythicalItem(t.Context(), itemID)
			require.NoError(t, err)
			return item
		}
		checks := func(item db.MythicalItem) map[string]json.RawMessage {
			var v map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(item.Checks, &v))
			return v
		}
		generation := func() int64 {
			var n int64
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT requested_generation FROM mythical_stacks WHERE repository_id=$1`, b.repo.ID).Scan(&n))
			return n
		}
		initial, beforeGeneration := read(), generation()
		_, todoPeer := presenceTestLink(t, registry, todoBranch)
		// Hold the stack as a concurrent publication does. Ingestion must
		// not take the receipt FK's workspace KEY SHARE lock before waiting
		// here, or publication's workspace FOR UPDATE deadlocks with capture.
		publication, err := b.pool.Begin(t.Context())
		require.NoError(t, err)
		defer publication.Rollback(context.Background())
		_, err = publication.Exec(t.Context(), `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, b.repo.ID)
		require.NoError(t, err)
		var backendPID int
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT pg_backend_pid()`).Scan(&backendPID))
		send(todoPeer, event(1, 21, first))
		require.Eventually(t, func() bool {
			var waiting bool
			err := b.pool.QueryRow(t.Context(), `SELECT wait_event_type='Lock' AND query LIKE '%mythical_stacks%' FROM pg_stat_activity WHERE pid=$1`, backendPID).Scan(&waiting)
			return err == nil && waiting
		}, 2*time.Second, 10*time.Millisecond)
		lockCtx, cancelLock := context.WithTimeout(t.Context(), 500*time.Millisecond)
		_, err = publication.Exec(lockCtx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, todoBranch)
		cancelLock()
		require.NoError(t, err, "capture took the receipt FK lock before the stack lock")
		require.NoError(t, publication.Commit(t.Context()))
		ack(todoPeer, 1, machined.AckApplied)
		equal := read()
		require.True(t, equal.CandidateVerified, "equal trees preserve existing verification")
		require.Equal(t, initial.Version, equal.Version)
		require.Equal(t, beforeGeneration, generation())
		require.NotEmpty(t, checks(equal)["land"])
		changed := wire.Captured{Head: git("changed\n", "commit-tree", stale.Tree, "-p", first.Head), Tree: stale.Tree, Base: first.Head}
		_, err = pool.Exec(t.Context(), `ALTER TABLE product_job_events ADD CONSTRAINT reject_capture CHECK (event_type <> 'branch.captured') NOT VALID`)
		require.NoError(t, err)
		send(todoPeer, event(2, 22, changed))
		_, err = wire.Read(todoPeer)
		require.Error(t, err)
		require.Equal(t, changed.Head, git("", "rev-parse", todoRef))
		require.Equal(t, initial.Version, read().Version, "SQL rollback restores verification and pending work")
		require.True(t, read().CandidateVerified)
		require.Equal(t, beforeGeneration, generation())
		_, err = pool.Exec(t.Context(), `ALTER TABLE product_job_events DROP CONSTRAINT reject_capture`)
		require.NoError(t, err)
		_, todoPeer = presenceTestLink(t, registry, todoBranch)
		send(todoPeer, event(8, 22, changed))
		ack(todoPeer, 8, machined.AckApplied)
		updated := read()
		require.False(t, updated.CandidateVerified)
		require.Empty(t, checks(updated)["land"])
		var work services.MachineCapturePending
		require.NoError(t, json.Unmarshal(checks(updated)["capture"], &work))
		require.Equal(t, services.MachineCapturePending{Head: changed.Head, Tree: changed.Tree, Base: first.Head, Onto: changed.Head}, work)
		require.Equal(t, beforeGeneration+1, generation())
		require.Equal(t, initial.CandidateHead, updated.CandidateHead)
		require.Equal(t, initial.CandidateBase, updated.CandidateBase)
		require.Equal(t, initial.Attempt, updated.Attempt)
		require.Equal(t, initial.Generation, updated.Generation)
		require.Equal(t, initial.RequestRunID, updated.RequestRunID)
		require.Equal(t, initial.State, updated.State)
		send(todoPeer, event(9, 22, changed))
		ack(todoPeer, 9, machined.AckDuplicate)
		require.Equal(t, updated.Version, read().Version)
		require.Equal(t, beforeGeneration+1, generation())
		// Equal bytes later still need fresh verification after invalidation.
		equalAgain := wire.Captured{Head: git("restored\n", "commit-tree", first.Tree, "-p", changed.Head), Tree: first.Tree, Base: changed.Head}
		send(todoPeer, event(10, 23, equalAgain))
		ack(todoPeer, 10, machined.AckApplied)
		require.False(t, read().CandidateVerified)
		require.NotEmpty(t, checks(read())["capture"])
		// A capture also fences a verification run that has not reported yet.
		_, err = pool.Exec(t.Context(), `UPDATE mythical_items SET state='verifying',checks='{"todo":true}',candidate_verified=false WHERE id=$1`, id)
		require.NoError(t, err)
		_, err = pool.Exec(t.Context(), `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, todoBranch)
		require.NoError(t, err)
		late := wire.Captured{Head: git("late\n", "commit-tree", stale.Tree, "-p", equalAgain.Head), Tree: stale.Tree, Base: equalAgain.Head}
		send(todoPeer, event(11, 24, late))
		ack(todoPeer, 11, machined.AckApplied)
		require.NotEmpty(t, checks(read())["capture"], "late passed result must not bless changed bytes")
		// Refuse before touching any native ref when a merge may be in flight.
		_, err = pool.Exec(t.Context(), `UPDATE mythical_items SET pending_op='{"kind":"merge","target":"1","desired":"approved","state":"unknown"}' WHERE id=$1`, id)
		require.NoError(t, err)
		send(todoPeer, event(12, 24, late))
		ack(todoPeer, 12, machined.AckDuplicate)
		blocked := wire.Captured{Head: git("blocked\n", "commit-tree", first.Tree, "-p", late.Head), Tree: first.Tree, Base: late.Head}
		send(todoPeer, event(13, 25, blocked))
		_, err = wire.Read(todoPeer)
		require.Error(t, err)
		require.Equal(t, late.Head, git("", "rev-parse", todoRef))
	})

}
