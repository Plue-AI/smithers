package compose

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
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
	id := uuid.NewString()
	private, err := json.Marshal(map[string]any{"scratch_rebase": map[string]any{"workspace": f.row.ID, "branch": f.row.TargetBookmark, "phase": "requested", "onto": "target", "blocking_boot": hex.EncodeToString(boot[:]), "blocking_session": 7}})
	require.NoError(t, err)
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		if _, err := jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(f.row.RepositoryID), PrincipalID: "branch:" + f.row.ID}, id, "branch.rebase-requested", "requested", []byte(`{}`)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE product_job_requests SET authorization_context=$2::jsonb WHERE id=$1`, id, private)
		return err
	}))
	snapshot := func() map[string]any {
		t.Helper()
		reader := f.dial(t)
		defer reader.CloseNow()
		sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
		frame := readPresenceFrame(t, reader)
		require.Equal(t, "snap", frame.T)
		var value map[string]any
		require.NoError(t, json.Unmarshal(frame.Data, &value))
		return value["rebase"].(map[string]any)
	}
	_, err = f.pool.Exec(ctx, `DELETE FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID)
	require.NoError(t, err)
	actual := snapshot()
	require.Equal(t, "presence-owner", actual["waiting_for"].(map[string]any)["actor"].(map[string]any)["login"])
	checkHidden := func() {
		t.Helper()
		value := snapshot()
		require.NotContains(t, value, "waiting_for")
		require.Equal(t, "pending", value["state"])
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
