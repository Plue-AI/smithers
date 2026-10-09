package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Only the guest session response is simulated. The authenticated transport,
// live session census, PostgreSQL identity and installed Branch subscription
// are production. This does not qualify guest kernel freeze behavior.
func TestRebaseWriterAttributionThroughInstall(t *testing.T) {
	f := presenceInstallWithTodos(t, true)
	ctx := t.Context()
	jobStore, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	f.topics.jobs = jobStore
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	registry := new(machined.Registry)
	var boot [16]byte
	link, guest := presenceTestLink(t, registry, f.row.ID, &boot)
	require.NoError(t, link.Reconciled())
	sessions := machined.NewSessions(link.Connection, f.row.ID, registry.Sessions(f.row.ID)).WithActor([]byte("actor-reference1"), "").WithPresenceVia("terminal")
	respond := func(peer net.Conn, method wire.Method, fields ...[]byte) {
		t.Helper()
		frame, err := wire.Read(peer)
		require.NoError(t, err)
		id, got, _, err := frame.Request()
		require.NoError(t, err)
		require.Equal(t, byte(method), got)
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(method), fields...)))}))
	}
	done := make(chan error, 1)
	go func() {
		_, err := sessions.OpenSession(ctx, machined.SessionUser{Login: "alice", UID: 20001}, machined.SessionPTY, nil, nil)
		done <- err
	}()
	respond(guest, wire.OpenSession, wire.Field(1, wire.U32(7)))
	require.NoError(t, <-done)
	f.p.branches.SetRebaseBlockerReader(f.p.rebaseBlockerReader(registry))
	f.todos.SetRebaseBlockerReader(f.p.rebaseBlockerReader(registry))
	id := uuid.NewString()
	private, err := json.Marshal(map[string]any{"scratch_rebase": map[string]any{"workspace": f.row.ID, "branch": f.row.TargetBookmark, "phase": "requested", "onto": "target", "blocking_boot": hex.EncodeToString(boot[:]), "blocking_session": 7, "authority": map[string]any{"user": f.user.ID}}})
	require.NoError(t, err)
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		if _, err := jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(f.row.RepositoryID), PrincipalID: "branch:" + f.row.ID}, id, "branch.rebase-requested", "requested", []byte(`{}`)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE product_job_requests SET authorization_context=$2::jsonb WHERE id=$1`, id, private)
		return err
	}))
	snapshot := func(viewer presenceInstallFixture) map[string]any {
		t.Helper()
		reader := viewer.dial(t)
		// Keep both viewers subscribed so a shared hub stream cannot leak
		// the first viewer's private projection to the second.
		sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
		frame := readPresenceFrame(t, reader)
		require.Equal(t, "snap", frame.T)
		var value map[string]any
		require.NoError(t, json.Unmarshal(frame.Data, &value))
		return value["rebase"].(map[string]any)
	}
	q := db.New(f.pool)
	observer, err := q.CreateUser(ctx, db.CreateUserParams{Username: "rebase-observer", LowerUsername: "rebase-observer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','observer',20002)`, f.row.RepositoryID, observer.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$3,'read')`, f.row.ID, f.user.ID, observer.ID)
	require.NoError(t, err)
	other := f
	other.user, other.cookie = observer, "observer-cookie"
	hash := sha256.Sum256([]byte(other.cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: observer.ID, Username: observer.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	// The TODO overlay and scratch provider independently enforce viewer privacy.
	checks, err := json.Marshal(map[string]any{"rebase": map[string]any{"onto": "target", "name": "main", "blocking_boot": hex.EncodeToString(boot[:]), "blocking_session": 7, "request": map[string]any{"user": f.user.ID}}})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$2,state='integrating',checks=$3 WHERE repository_id=$1`, f.row.RepositoryID, f.row.ID, checks)
	require.NoError(t, err)
	require.Contains(t, snapshot(f), "waiting_for")
	require.NotContains(t, snapshot(other), "waiting_for")
	// Replay a retained pre-fix fact through the served socket. Its historical
	// writer must not leak to either viewer, even when resuming by cursor.
	item, err := q.GetMythicalItemByNumber(ctx, f.row.RepositoryID, 1)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprint(f.row.RepositoryID), PrincipalID: "todo:" + uuid.UUID(item.ID.Bytes).String()}
	before, err := jobStore.Head(ctx, scope)
	require.NoError(t, err)
	legacy := []byte(`{"card":{"opaque_counter":9007199254740993,"rebase_pending":{"onto":"main","waiting_for":{"actor":{"kind":"person","login":"private-writer"},"terminal":"private-terminal"}}}}`)
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		_, err := jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "todo.run_updated", "working", legacy)
		return err
	}))
	for _, viewer := range []presenceInstallFixture{f, other} {
		reader := viewer.dial(t)
		sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s","cursor":%d}`, f.row.ID, before))
		frame := readPresenceFrame(t, reader)
		require.Equal(t, "delta", frame.T)
		require.Contains(t, string(frame.Data), `"onto":"main"`)
		require.Contains(t, string(frame.Data), `"opaque_counter":9007199254740993`)
		require.NotContains(t, string(frame.Data), "waiting_for")
		require.NotContains(t, string(frame.Data), "private-writer")
	}
	_, err = f.pool.Exec(ctx, `DELETE FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID)
	require.NoError(t, err)
	require.NotContains(t, snapshot(other), "waiting_for")
	actual := snapshot(f)
	require.Equal(t, "presence-owner", actual["waiting_for"].(map[string]any)["actor"].(map[string]any)["login"])
	checkHidden := func() {
		t.Helper()
		require.Eventually(t, func() bool {
			value := snapshot(f)
			_, waiting := value["waiting_for"]
			return !waiting && value["state"] == "pending"
		}, 3*time.Second, 50*time.Millisecond)
	}
	_, err = f.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	checkHidden()
	_, err = f.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	go func() { done <- sessions.CloseSession(ctx, 7) }()
	respond(guest, wire.CloseSession)
	require.NoError(t, <-done)
	checkHidden()
	_, _ = presenceTestLink(t, registry, f.row.ID)
	checkHidden()
}
