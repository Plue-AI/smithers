package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/machinedfake"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Adapted from a73a77de36's Pair transaction/queued-authority tests and
// 5b77095672's desktop-share revocation test. Only committed access and
// transport assertions survive; no retired Pair surface is restored.
func exerciseMemberRevocation(t *testing.T, pool *pgxpool.Pool, origin string, writer db.User, bus *revocation.Bus,
	request func(string, string, string, string) (int, string), session func(db.User, string)) {
	t.Helper()
	ctx := t.Context()
	var repository, ownerID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT c.repository_id,o.user_id FROM collaborators c CROSS JOIN self_host_owners o WHERE c.user_id=$1`, writer.ID).Scan(&repository, &ownerID))
	var workspace string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name) VALUES($1,$2,'revocation-branch') RETURNING id::text`, repository, ownerID).Scan(&workspace))
	other, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "unrelated-share", LowerUsername: "unrelated-share"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1::uuid,$2,$3,'write')`, workspace, ownerID, other.ID)
	require.NoError(t, err)
	grant := func() {
		t.Helper()
		_, err := pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1::uuid,$2,$3,'write') ON CONFLICT(workspace_id,grantee_user_id) DO NOTHING`, workspace, ownerID, writer.ID)
		require.NoError(t, err)
	}
	grant()
	// Guest process termination is represented only by this test fake.
	// Database, DELETE, durable recovery and roster delivery are production code.
	var guestMu sync.Mutex
	var partitioned, guestMember, guestChild bool
	var memberUID uint32
	require.NoError(t, pool.QueryRow(ctx, `SELECT unix_uid FROM collaborators WHERE user_id=$1`, writer.ID).Scan(&memberUID))
	guest := &machinedfake.Client{OnSetRoster: func(ctx context.Context, branch string, members []machined.SessionUser) error {
		guestMu.Lock()
		defer guestMu.Unlock()
		if partitioned {
			return machined.ErrNotReady
		}
		listed := false
		for _, member := range members {
			if member.UID == memberUID {
				listed = true
			}
		}
		guestMember = listed
		if !listed {
			guestChild = false
		}
		return nil
	}}
	roster := &machineRoster{pool: pool, client: guest, branches: func() []string { return []string{workspace} }}
	stopRoster := roster.start(ctx, bus)
	defer stopRoster()
	open := func(cookie string) *websocket.Conn {
		t.Helper()
		require.Eventually(t, func() bool { return !bus.IsUserDisabled(writer.ID) }, 3*time.Second, 10*time.Millisecond)
		dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=" + cookie}}})
		require.NoError(t, err)
		t.Cleanup(func() { conn.CloseNow() })
		return conn
	}
	t.Run("rollback_has_no_state_change_or_fanout", func(t *testing.T) {
		session(writer, "rollback-cookie")
		socket := open("rollback-cookie")
		for _, failure := range []string{"insert", "notify"} {
			var before int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events`).Scan(&before))
			action := `RAISE EXCEPTION 'member event insert failed';`
			if failure == "notify" {
				action = `PERFORM pg_notify('smithers_revocation',repeat('x',8000));`
			}
			_, err := pool.Exec(ctx, `CREATE FUNCTION reject_member_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='collaborator_removed' THEN `+action+` END IF; RETURN NEW; END $$; CREATE TRIGGER reject_member_event BEFORE INSERT ON revocation_events FOR EACH ROW EXECUTE FUNCTION reject_member_event()`)
			require.NoError(t, err)
			status, body := request("DELETE", "/api/members/writer", "", "owner-cookie")
			require.Equal(t, 503, status, body)
			status, body = request("GET", "/api/members", "", "rollback-cookie")
			require.Equal(t, 200, status, body)
			var after int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events`).Scan(&after))
			require.Equal(t, before, after, "all user/session/branch events roll back together")
			var active bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT NOT u.prohibit_login AND c.suspended_at IS NULL FROM users u JOIN collaborators c ON c.user_id=u.id WHERE u.id=$1`, writer.ID).Scan(&active))
			require.True(t, active)
			var grants int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_shares WHERE grantee_user_id=$1`, writer.ID).Scan(&grants))
			require.Equal(t, 1, grants, "rollback preserves branch access")
			pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			// Ping needs a concurrent reader to consume the pong.
			readDone := make(chan struct{})
			go func() { defer close(readDone); socket.Read(pingCtx) }()
			require.NoError(t, socket.Ping(pingCtx))
			cancel()
			<-readDone
			_, err = pool.Exec(ctx, `DROP TRIGGER reject_member_event ON revocation_events; DROP FUNCTION reject_member_event()`)
			require.NoError(t, err)
			socket.CloseNow()
			socket = open("rollback-cookie")
		}
	})
	t.Run("queued_mutation_rechecks_revoked_actor", func(t *testing.T) {
		status, body := request("PATCH", "/api/members/writer", `{"role":"maintainer"}`, "owner-cookie")
		require.Equal(t, 204, status, body)
		session(writer, "queued-maintainer-cookie")
		blocker, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer blocker.Rollback(ctx)
		_, err = blocker.Exec(ctx, `SELECT user_id FROM self_host_owners FOR UPDATE`)
		require.NoError(t, err)
		result := make(chan int, 1)
		go func() {
			status, _ := request("DELETE", "/api/members/admin", "", "queued-maintainer-cookie")
			result <- status
		}()
		require.Eventually(t, func() bool {
			var waiting bool
			err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT user_id FROM self_host_owners FOR UPDATE%')`).Scan(&waiting)
			return err == nil && waiting
		}, 5*time.Second, 10*time.Millisecond, "queued member mutation never reached roster serialization")
		_, err = blocker.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, writer.ID)
		require.NoError(t, err)
		_, err = blocker.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, writer.ID)
		require.NoError(t, err)
		_, err = blocker.Exec(ctx, `DELETE FROM auth_sessions WHERE user_id=$1`, writer.ID)
		require.NoError(t, err)
		require.NoError(t, blocker.Commit(ctx))
		select {
		case status := <-result:
			require.Equal(t, 401, status, "a revoked credential is dead before the queued write, rather than a live policy refusal")
		case <-time.After(5 * time.Second):
			t.Fatal("queued request did not finish")
		}
		var stillListed bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaborators WHERE github_login='admin' AND suspended_at IS NULL)`).Scan(&stillListed))
		require.True(t, stillListed)
		status, _ = request("GET", "/api/members", "", "queued-maintainer-cookie")
		require.Equal(t, 401, status)
		// Restore the fixture's standing, never the revoked session.
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL,permission='write' WHERE user_id=$1`, writer.ID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, writer.ID)
		require.NoError(t, err)
	})
	t.Run("lost_notify_closes_live_in_twenty_runs", func(t *testing.T) {
		committed := make(chan error, 32)
		unsubscribe := bus.Subscribe(func(event revocation.Event) {
			if event.Kind != revocation.KindCollaboratorRemoved || event.UserID != writer.ID {
				return
			}
			var prohibited bool
			var sessions, shares int
			err := pool.QueryRow(ctx, `SELECT prohibit_login,(SELECT count(*) FROM auth_sessions WHERE user_id=$1),(SELECT count(*) FROM workspace_shares WHERE grantee_user_id=$1 OR owner_user_id=$1) FROM users WHERE id=$1`, writer.ID).Scan(&prohibited, &sessions, &shares)
			if err == nil && (!prohibited || sessions != 0 || shares != 0) {
				err = fmt.Errorf("fanout preceded committed access: prohibit=%v sessions=%d shares=%d", prohibited, sessions, shares)
			}
			committed <- err
		})
		defer unsubscribe()
		agent, err := db.New(pool).CreateAgentSession(ctx, db.CreateAgentSessionParams{ID: uuid.NewString(), RepositoryID: repository, UserID: ownerID, Title: "member stream revocation", Status: "active"})
		require.NoError(t, err)
		streamPath := "/api/repos/owner/app/agent/sessions/" + agent.ID + "/stream"
		maxSSEElapsed := time.Duration(0)
		maxElapsed := time.Duration(0)
		for run := 1; run <= 20; run++ {
			if run > 1 {
				status, body := request("POST", "/api/members", `{"login":"writer"}`, "owner-cookie")
				require.Equal(t, 204, status, body)
			}
			require.Eventually(t, func() bool { return !bus.IsUserDisabled(writer.ID) }, 3*time.Second, 10*time.Millisecond)
			grant()
			cookie := fmt.Sprintf("live-revocation-%d", run)
			session(writer, cookie)
			socket := open(cookie)
			streamCtx, cancelStream := context.WithTimeout(ctx, 10*time.Second)
			defer cancelStream()
			mintTicket := func() string {
				status, body := request("POST", "/api/auth/sse-ticket", "", cookie)
				require.Equal(t, http.StatusOK, status, body)
				var issued struct {
					Ticket string `json:"ticket"`
				}
				require.NoError(t, json.Unmarshal([]byte(body), &issued))
				require.NotEmpty(t, issued.Ticket)
				return issued.Ticket
			}
			ticket, unusedTicket := mintTicket(), mintTicket()
			req, err := http.NewRequestWithContext(streamCtx, http.MethodGet, origin+streamPath+"?ticket="+url.QueryEscape(ticket), nil)
			require.NoError(t, err)
			req.Header.Set("Accept", "text/event-stream")
			response, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, http.StatusOK, response.StatusCode)
			require.Contains(t, response.Header.Get("Content-Type"), "text/event-stream")
			type streamResult struct {
				body   string
				err    error
				closed time.Time
			}
			streamDone := make(chan streamResult, 1)
			go func() {
				data, err := io.ReadAll(response.Body)
				streamDone <- streamResult{string(data), err, time.Now()}
			}()
			var currentUID uint32
			require.NoError(t, pool.QueryRow(ctx, `SELECT unix_uid FROM collaborators WHERE user_id=$1`, writer.ID).Scan(&currentUID))
			guestMu.Lock()
			memberUID = currentUID
			guestMu.Unlock()
			require.NoError(t, roster.syncBranch(ctx, workspace))
			guestMu.Lock()
			assert.True(t, guestMember)
			partitioned, guestChild = true, true
			guestMu.Unlock()
			started := time.Now()
			status, body := request("DELETE", "/api/members/writer", "", "owner-cookie")
			require.Equal(t, 204, status, body)
			responseAt := time.Now()
			guestMu.Lock()
			assert.True(t, guestChild, "partitioned guest retains processes until roster reconciliation")
			partitioned = false
			guestMu.Unlock()
			handshakeAt := time.Now()
			if run == 20 {
				require.Eventually(t, func() bool {
					guestMu.Lock()
					defer guestMu.Unlock()
					return !guestMember && !guestChild
				}, 5*time.Second, 10*time.Millisecond, "one-second recovery must reconcile without an explicit reconnect call")
			} else {
				require.NoError(t, roster.syncBranch(ctx, workspace))
			}
			guestMu.Lock()
			assert.False(t, guestMember, "reconnect roster excludes revoked allocation")
			assert.False(t, guestChild, "fake broker must remove unlisted session descendants")
			guestMu.Unlock()
			require.LessOrEqual(t, time.Since(handshakeAt), 5*time.Second)
			t.Logf("run=%d boundary=fake-broker reconnect_to_roster_seconds=%.6f", run, time.Since(handshakeAt).Seconds())
			status, _ = request("GET", "/api/members", "", cookie)
			require.Equal(t, 401, status, "old cookie refused before physical fanout")
			closeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			for {
				_, _, err := socket.Read(closeCtx)
				if err != nil {
					require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
					break
				}
			}
			select {
			case result := <-streamDone:
				require.NoError(t, result.err, "SSE must reach server EOF, not client cancellation")
				require.Contains(t, result.body, "event: revoked")
				require.Contains(t, result.body, fmt.Sprintf(`"user_id":%d`, writer.ID))
				sseElapsed := result.closed.Sub(started)
				require.LessOrEqual(t, sseElapsed, 5*time.Second)
				if sseElapsed > maxSSEElapsed {
					maxSSEElapsed = sseElapsed
				}
				t.Logf("run=%d transport=sse request_to_eof_seconds=%.6f", run, sseElapsed.Seconds())
			case <-time.After(time.Until(started.Add(5 * time.Second))):
				cancelStream()
				response.Body.Close()
				t.Fatal("member removal did not close SSE within five seconds")
			}
			cancelStream()
			response.Body.Close()
			status, body = request("GET", streamPath, "", cookie)
			require.Equal(t, http.StatusUnauthorized, status, body)
			status, body = request("GET", streamPath+"?ticket="+url.QueryEscape(unusedTicket), "", "")
			require.Equal(t, http.StatusUnauthorized, status, body, "an unused ticket cannot outlive its revoked browser session")
			elapsed := time.Since(started)
			cancel()
			socket.CloseNow()
			require.LessOrEqual(t, elapsed, 5*time.Second, "request-to-close conservatively includes commit-to-close")
			if elapsed > maxElapsed {
				maxElapsed = elapsed
			}
			t.Logf("run=%d transport=live request_to_close_seconds=%.6f response_to_close_seconds=%.6f", run, elapsed.Seconds(), time.Since(responseAt).Seconds())
			select {
			case err := <-committed:
				require.NoError(t, err)
			case <-time.After(5 * time.Second):
				t.Fatal("committed event not delivered")
			}
			status, body = request("DELETE", "/api/members/writer", "", "owner-cookie")
			require.Equal(t, 204, status, body)
		}
		var unrelatedGrants int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_shares WHERE grantee_user_id=$1`, other.ID).Scan(&unrelatedGrants))
		require.Equal(t, 1, unrelatedGrants, "another member's branch access survives")
		t.Logf("SSE max over 20 runs: %.6f seconds; NOTIFY delivery disabled", maxSSEElapsed.Seconds())
		t.Logf("live max over 20 runs: %.6f seconds; NOTIFY delivery disabled", maxElapsed.Seconds())
		status, body := request("POST", "/api/members", `{"login":"writer"}`, "owner-cookie")
		require.Equal(t, 204, status, body)
	})
	stopRoster()
	t.Run("restoration_cannot_preserve_revoked_guest_descendants", func(t *testing.T) {
		var eventID int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT max(id) FROM revocation_events WHERE kind='collaborator_removed' AND user_id=$1`, writer.ID).Scan(&eventID))
		var currentUID uint32
		require.NoError(t, pool.QueryRow(ctx, `SELECT unix_uid FROM collaborators WHERE user_id=$1`, writer.ID).Scan(&currentUID))
		guestMu.Lock()
		memberUID = currentUID
		guestChild = true
		guestMu.Unlock()
		restored := &machineRoster{pool: pool, client: guest, removed: map[int64]revocation.Event{
			writer.ID: {ID: eventID, UserID: writer.ID, Kind: revocation.KindCollaboratorRemoved},
		}}
		require.NoError(t, restored.syncBranch(ctx, workspace))
		guestMu.Lock()
		assert.True(t, guestMember, "restoration admits fresh sessions")
		assert.False(t, guestChild, "the original revoked session must first be killed")
		guestMu.Unlock()
		// A successful cleanup receipt prevents repeat revocation of new sessions.
		guestMu.Lock()
		memberUID = currentUID
		guestChild = true
		guestMu.Unlock()
		require.NoError(t, restored.syncBranch(ctx, workspace))
		guestMu.Lock()
		assert.True(t, guestChild)
		guestMu.Unlock()
	})

}
