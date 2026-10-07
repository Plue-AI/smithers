package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/stretchr/testify/require"
)

// Actual install composition, authentication and PostgreSQL; view state is
// never selected by a caller-supplied author or exposed to another member.
func TestBranchConversationMemberViewStateInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice := user("owner"), user("ben"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	for _, u := range []db.User{owner, ben, alice} {
		permission := "admin"
		if u.ID == alice.ID {
			permission = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, permission)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		key := u.Username + "-view-cookie"
		hash := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	benCookie, aliceCookie := session(ben), session(alice)
	rawToken := "smithers_" + strings.Repeat("d", 40)
	tokenHash := sha256.Sum256([]byte(rawToken))
	tokenDigest := hex.EncodeToString(tokenHash[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: ben.ID, Name: "private-view-delegation",
		TokenHash: tokenDigest, TokenLastEight: tokenDigest[len(tokenDigest)-8:], SystemIssued: true,
		Scopes:    "write:user,read:user," + strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "smithers", Session: liveAppTurnCredentialFixture(t, pool, ben.ID) + "/1"}), ","),
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)
	feature, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: ben.ID, Name: "feature", TargetBookmark: "feature", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + strings.Replace(server.Listener.Addr().String(), "127.0.0.1:", "localhost:", 1)
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", origin)
	server.Config.Handler = startSplitProcess(t, Options{ChatHost: unusedChatHost{}, Workspace: runtime, BranchMachines: &providers, FlowHostProductAPIURL: origin, FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}})
	server.Start()
	defer server.Close()
	call := func(method, path, body, cookie string, expected int) string {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, expected, res.StatusCode, string(raw))
		return string(raw)
	}
	listener, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer listener.Release()
	_, err = listener.Exec(ctx, fmt.Sprintf("LISTEN view_%d_%d", repo.ID, ben.ID))
	require.NoError(t, err)
	hint := func() {
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		message, err := listener.Conn().WaitForNotification(readCtx)
		require.NoError(t, err)
		require.Equal(t, `{"type":"view_state"}`, message.Payload)
	}
	const path = "/api/conversations/main/view-state"
	const benState = `{"scroll_anchor":"entry-8","card_view":{"todo-2":"maximized"},"last_seen_seq":8,"toasts_hidden":true}`
	require.JSONEq(t, benState, call("PUT", path, benState, benCookie, 200))
	hint()
	require.JSONEq(t, `{"toasts_hidden":false}`, call("GET", path, "", aliceCookie, 200))
	require.JSONEq(t, `{"scroll_anchor":"entry-2","toasts_hidden":false}`, call("PUT", path, `{"scroll_anchor":"entry-2"}`, aliceCookie, 200))
	require.JSONEq(t, benState, call("GET", path, "", benCookie, 200))
	for _, method := range []string{"GET", "PUT"} {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(`{}`))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+rawToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		privateBody, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, http.StatusForbidden, response.StatusCode, string(privateBody))
		require.NotContains(t, string(privateBody), "entry-8")
	}
	require.JSONEq(t, benState, call("GET", path, "", benCookie, 200))
	require.JSONEq(t, `{"scroll_anchor":"entry-2","toasts_hidden":false}`, call("GET", path, "", aliceCookie, 200))
	// The preference crosses conversations, never members. A write without
	// the preference preserves it; malformed values do not change it.
	const otherPath = "/api/conversations/feature/view-state"
	require.JSONEq(t, `{"scroll_anchor":"named-entry","toasts_hidden":true}`, call("PUT", otherPath, `{"scroll_anchor":"named-entry"}`, benCookie, 200))
	hint()
	require.JSONEq(t, `{"scroll_anchor":"named-entry","toasts_hidden":true}`, call("GET", "/api/conversations/"+feature.ID+"/view-state", "", benCookie, 200))
	call("GET", "/api/conversations/missing/view-state", "", benCookie, 404)
	require.JSONEq(t, `{"scroll_anchor":"named-entry","toasts_hidden":true}`, call("GET", otherPath, "", benCookie, 200))
	require.JSONEq(t, `{"scroll_anchor":"feature-entry","toasts_hidden":true}`, call("PUT", otherPath, `{"scroll_anchor":"feature-entry"}`, benCookie, 200))
	hint()
	call("PUT", otherPath, `{"toasts_hidden":"false"}`, benCookie, 400)
	quietCtx, quietCancel := context.WithTimeout(ctx, 100*time.Millisecond)
	_, err = listener.Conn().WaitForNotification(quietCtx)
	quietCancel()
	require.ErrorIs(t, err, context.DeadlineExceeded, "a refused write emits no hint")
	require.JSONEq(t, `{"toasts_hidden":false}`, call("PUT", otherPath, `{"toasts_hidden":false}`, benCookie, 200))
	require.JSONEq(t, `{"scroll_anchor":"entry-8","card_view":{"todo-2":"maximized"},"last_seen_seq":8,"toasts_hidden":false}`, call("GET", path, "", benCookie, 200))
	require.JSONEq(t, benState, call("PUT", path, benState, benCookie, 200))
	require.JSONEq(t, benState, call("GET", path, "", benCookie, 200))
	call("PUT", path, `[]`, benCookie, 400)
	// Member identity is never a view-state path parameter; the foreign route is absent.
	call("GET", path+"/ben", "", aliceCookie, 404)
	call("PUT", path, `{"user_id":2,"scroll_anchor":"own"}`, aliceCookie, 200)
	require.JSONEq(t, benState, call("GET", path, "", benCookie, 200))
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, alice.ID)
	require.NoError(t, err)
	call("PUT", path, `{}`, aliceCookie, 403)
}

// The model seam deliberately holds Alice's turn; admission, membership
// removal, producer fencing and recovery use the real install composition.
type revokedAuthorHost struct {
	started chan ports.ChatTurnGrant
	stopped chan string
}

func (h revokedAuthorHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	h.started <- grant
	if strings.HasPrefix(grant.RunID, "ben-") {
		return ports.ErrModelCredentialMissing
	}
	<-ctx.Done()
	h.stopped <- grant.RunID
	return ctx.Err()
}

func TestBranchConversationAuthorRevocationInstall(t *testing.T) {
	for _, mode := range []string{"removed", "suspended"} {
		t.Run(mode, func(t *testing.T) {
			_, _, pool := splitProcessDatabase(t)
			q, ctx := db.New(pool), t.Context()
			user := func(login string) db.User {
				u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
				require.NoError(t, err)
				return u
			}
			owner, ben, alice := user("owner"), user("ben"), user("alice")
			_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
			require.NoError(t, err)
			repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
			require.NoError(t, err)
			binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
			for _, key := range []string{"github.repository", "owner.access"} {
				require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
			}
			for _, u := range []db.User{owner, ben, alice} {
				permission := "admin"
				if u.ID == alice.ID {
					permission = "write"
				}
				_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, permission)
				require.NoError(t, err)
			}
			session := func(u db.User) string {
				key := u.Username + "-view-cookie"
				hash := sha256.Sum256([]byte(key))
				_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
				require.NoError(t, err)
				return key
			}
			benCookie, aliceCookie := session(ben), session(alice)

			ownerCookie := session(owner)
			host := revokedAuthorHost{started: make(chan ports.ChatTurnGrant, 8), stopped: make(chan string, 8)}
			runtime, err := process.New(process.Config{Root: t.TempDir()})
			require.NoError(t, err)
			providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)
			server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: host, Workspace: runtime, BranchMachines: &providers, FlowHostProductAPIURL: "http://127.0.0.1:4000", FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}}))
			defer server.Close()
			request := func(method, path, body, cookie string) *http.Response {
				req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
				require.NoError(t, err)
				req.Host = "127.0.0.1:4000"
				req.Header.Set("Origin", "http://127.0.0.1:4000")
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-CSRF-Token", "csrf-fixture")
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
				res, err := server.Client().Do(req)
				require.NoError(t, err)
				return res
			}
			admit := func(name, cookie string) string {
				payload, err := json.Marshal(map[string]string{"prompt": "SLOW", "idempotencyKey": name + "-" + uuid.NewString()})
				require.NoError(t, err)
				res := request("POST", "/api/conversations/main/prompt", string(payload), cookie)
				defer res.Body.Close()
				raw, err := io.ReadAll(res.Body)
				require.NoError(t, err)
				require.Equal(t, 202, res.StatusCode, string(raw))
				var admitted struct {
					RunID string `json:"runId"`
				}
				require.NoError(t, json.Unmarshal(raw, &admitted))
				require.NotEmpty(t, admitted.RunID)
				return admitted.RunID
			}

			first := admit("alice", aliceCookie)
			var grant ports.ChatTurnGrant
			select {
			case grant = <-host.started:
				require.Equal(t, first, grant.RunID)
			case <-time.After(5 * time.Second):
				t.Fatal("author's host did not start")
			}
			second := admit("alice", aliceCookie)
			next := admit("ben", benCookie)
			var repository int64
			require.NoError(t, pool.QueryRow(ctx, `SELECT repository_id FROM chat_turns WHERE run_id=$1`, first).Scan(&repository))
			require.Equal(t, repo.ID, repository, "public chat admission must bind the installed repository")
			select {
			case started := <-host.started:
				t.Fatalf("overlapping turn: %s", started.RunID)
			case <-time.After(100 * time.Millisecond):
			}
			began := time.Now()
			if mode == "removed" {
				res := request("DELETE", "/api/members/alice", "", ownerCookie)
				body, _ := io.ReadAll(res.Body)
				res.Body.Close()
				require.Equal(t, 204, res.StatusCode, string(body))
			} else {
				_, err := pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo.ID, alice.ID)
				require.NoError(t, err)
			}
			select {
			case stopped := <-host.stopped:
				require.Equal(t, first, stopped)
			case <-time.After(5 * time.Second):
				t.Fatal("revoked host did not stop within five seconds")
			}
			require.Less(t, time.Since(began), 5*time.Second)
			select {
			case started := <-host.started:
				require.Equal(t, next, started.RunID)
			case <-time.After(5 * time.Second):
				t.Fatal("remaining member's queued turn did not start")
			}
			for _, run := range []string{first, second} {
				var state string
				var leased bool
				var frames []byte
				require.NoError(t, pool.QueryRow(ctx, `SELECT state,producer_token_hash IS NOT NULL OR producer_lease_expires_at IS NOT NULL FROM chat_turns WHERE run_id=$1`, run).Scan(&state, &leased))
				require.Equal(t, "cancelled", state)
				require.False(t, leased)
				require.NoError(t, pool.QueryRow(ctx, `SELECT b.frames FROM chat_turn_batches b JOIN chat_turns t ON t.id=b.turn_id WHERE t.run_id=$1 ORDER BY b.batch_number DESC LIMIT 1`, run).Scan(&frames))
				require.Contains(t, string(frames), `"code": "author_revoked"`)
			}
			// The old producer capability must refuse even if its request arrives late.
			raw, err := json.Marshal(map[string]any{"turnId": grant.TurnID, "generation": grant.Generation, "expected": grant.Cursor, "frames": []any{map[string]string{"runId": first, "type": "done", "reason": "stop"}}})
			require.NoError(t, err)
			req, err := http.NewRequest("POST", grant.ProducerBaseURL+chat.CommitPath, strings.NewReader(string(raw)))
			require.NoError(t, err)
			req.Host = "127.0.0.1:4000"
			req.Header.Set("Origin", "http://127.0.0.1:4000")
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+grant.Token)
			res, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			res.Body.Close()
			require.Equal(t, 401, res.StatusCode)
		})
	}
}

// Browser-session sockets consume exactly the private state served by HTTP,
// and never another member's state, even when they request that topic directly.
func TestBranchConversationPrivateViewLiveInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice := user("owner"), user("ben"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	for _, u := range []db.User{owner, ben, alice} {
		permission := "admin"
		if u.ID == alice.ID {
			permission = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, permission)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		key := u.Username + "-view-cookie"
		hash := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	benCookie, aliceCookie := session(ben), session(alice)

	ownerCookie := session(owner)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	host := revokedAuthorHost{started: make(chan ports.ChatTurnGrant, 8), stopped: make(chan string, 8)}
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)
	feature, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: ben.ID, Name: "feature", TargetBookmark: "feature", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	server.Config.Handler = startSplitProcess(t, Options{ChatHost: host, Workspace: runtime, BranchMachines: &providers, FlowHostProductAPIURL: "http://127.0.0.1:4000", FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}})
	server.Start()
	defer server.Close()
	call := func(method, path, body, cookie string, expected int) string {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		raw, err := io.ReadAll(res.Body)
		res.Body.Close()
		require.NoError(t, err)
		require.Equal(t, expected, res.StatusCode, string(raw))
		return string(raw)
	}
	open := func(cookie string) *websocket.Conn {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		conn, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"smithers_session=" + cookie}}})
		if err != nil && res != nil {
			t.Logf("live status=%d", res.StatusCode)
		}
		require.NoError(t, err)
		t.Cleanup(func() { conn.CloseNow() })
		return conn
	}
	send := func(conn *websocket.Conn, id uint32, topic string) {
		raw, err := json.Marshal(map[string]any{"t": "sub", "id": id, "topic": topic})
		require.NoError(t, err)
		require.NoError(t, conn.Write(ctx, websocket.MessageText, raw))
	}
	receive := func(conn *websocket.Conn, id uint32, kind string) liveFrame {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		for {
			_, raw, err := conn.Read(ctx)
			require.NoError(t, err)
			var frame liveFrame
			require.NoError(t, json.Unmarshal(raw, &frame))
			if frame.ID == id && frame.T == kind {
				return frame
			}
		}
	}
	benSocket, aliceSocket := open(benCookie), open(aliceCookie)
	const aliasState = `{"scroll_anchor":"alias-private-entry","toasts_hidden":false}`
	call("PUT", "/api/conversations/feature/view-state", aliasState, benCookie, 200)
	send(benSocket, 4, fmt.Sprintf("view:%d:feature", ben.ID))
	require.JSONEq(t, aliasState, string(receive(benSocket, 4, "snap").Data))
	restoredAlias := open(benCookie)
	send(restoredAlias, 5, fmt.Sprintf("view:%d:%s", ben.ID, feature.ID))
	require.JSONEq(t, aliasState, string(receive(restoredAlias, 5, "snap").Data))
	restoredAlias.CloseNow()
	benTopic, aliceTopic := fmt.Sprintf("view:%d:main", ben.ID), fmt.Sprintf("view:%d:main", alice.ID)
	send(benSocket, 1, benTopic)
	require.JSONEq(t, `{"toasts_hidden":false}`, string(receive(benSocket, 1, "snap").Data))
	send(aliceSocket, 1, aliceTopic)
	require.JSONEq(t, `{"toasts_hidden":false}`, string(receive(aliceSocket, 1, "snap").Data))
	const state = `{"scroll_anchor":"ben-private-entry","card_view":{"todo-2":"maximized"},"last_seen_seq":8,"toasts_hidden":false}`
	call("PUT", "/api/conversations/main/view-state", state, benCookie, 200)
	require.JSONEq(t, state, string(receive(benSocket, 1, "snap").Data))
	send(aliceSocket, 2, benTopic)
	refusal := receive(aliceSocket, 2, "err")
	require.Equal(t, "forbidden", refusal.Code)
	require.Empty(t, refusal.Data)
	send(aliceSocket, 3, aliceTopic)
	require.JSONEq(t, `{"toasts_hidden":false}`, string(receive(aliceSocket, 3, "snap").Data))
	// Queued prompts reconnect through the same private projection. They
	// never enter another member's view, even on the same branch.
	var held struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal([]byte(call("POST", "/api/conversations/main/prompt", `{"prompt":"held","idempotencyKey":"held"}`, benCookie, 202)), &held))
	select {
	case <-host.started:
	case <-time.After(5 * time.Second):
		t.Fatal("host did not start")
	}
	var queued struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal([]byte(call("POST", "/api/conversations/main/prompt", `{"prompt":"Ben queue canary","idempotencyKey":"private-queue"}`, benCookie, 202)), &queued))
	until := func(conn *websocket.Conn, id uint32, contains string) string {
		for range 10 {
			data := string(receive(conn, id, "snap").Data)
			if strings.Contains(data, contains) {
				return data
			}
		}
		t.Fatal("private queue snapshot did not arrive")
		return ""
	}
	// Imported journals cross the actual install's HTTP/live composition, not
	// a separately mounted test topic. Transcript discovery remains machine-owned.
	store, err := chat.NewStore(pool)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET display_name='Ben' WHERE id=$1`, ben.ID)
	require.NoError(t, err)
	importTx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer importTx.Rollback(context.WithoutCancel(ctx))
	scope := chat.Scope{RepositoryID: repo.ID, UserID: ben.ID, Owner: "ben"}
	require.NoError(t, store.ImportExternalTx(ctx, importTx, scope, "main", []chat.ExternalDraft{
		{ID: "claude-live", SourceID: "claude-live-source", Origin: "external", ReadOnly: true, Agent: "claude-code", Profile: "claude-code/2.1.0", Session: "claude-session", Participant: "claude-participant", Owner: fmt.Sprint(ben.ID), Author: "claude-participant", Kind: "tool_request", CallID: "call-1", Body: json.RawMessage(`{"name":"Bash","input":{"command":"touch /tmp/forged"}}`)},
		{ID: "codex-live", SourceID: "codex-live-source", Origin: "external", ReadOnly: true, Agent: "codex", Profile: "codex/0.160.0", Session: "codex-session", Participant: "codex-participant", Owner: fmt.Sprint(ben.ID), Author: "codex-participant", Kind: "assistant", Body: json.RawMessage(`"Codex observed the tests"`)},
	}))
	require.NoError(t, importTx.Commit(ctx))
	benSharedSocket, aliceSharedSocket := open(benCookie), open(aliceCookie)
	send(benSharedSocket, 10, "conversation:main")
	benShared := string(receive(benSharedSocket, 10, "snap").Data)
	send(aliceSharedSocket, 10, "conversation:main")
	aliceShared := string(receive(aliceSharedSocket, 10, "snap").Data)
	require.JSONEq(t, benShared, aliceShared)
	require.Contains(t, benShared, `"authorName":"Ben"`)
	require.Contains(t, benShared, `"participant_id":"claude-participant"`)
	require.Contains(t, benShared, `"participant_id":"codex-participant"`)
	require.Contains(t, benShared, `"call_id":"call-1"`)
	require.Contains(t, benShared, `"read_only":true`)
	require.JSONEq(t, benShared, call("GET", "/api/conversations/main", "", aliceCookie, 200))
	importReconnect := open(aliceCookie)
	send(importReconnect, 12, "conversation:main")
	require.JSONEq(t, benShared, string(receive(importReconnect, 12, "snap").Data))
	var imported chat.SharedConversation
	require.NoError(t, json.Unmarshal([]byte(benShared), &imported))
	for _, entry := range imported.Entries {
		if entry.ExternalDraft == nil {
			continue
		}
		for _, cookie := range []string{benCookie, aliceCookie} {
			call("PATCH", "/api/conversations/main/turns/"+entry.ID, `{"prompt":"mutate imported"}`, cookie, 403)
			call("POST", "/api/conversations/main/turns/"+entry.ID+"/stop", "{}", cookie, 403)
			call("DELETE", "/api/conversations/main/turns/"+entry.ID, "", cookie, 403)
		}
	}
	select {
	case <-host.started:
		t.Fatal("imported content started a turn")
	default:
	}

	require.Contains(t, benShared, held.TurnID)
	require.NotContains(t, benShared, queued.TurnID)
	require.NotContains(t, benShared, "Ben queue canary")
	require.NotContains(t, benShared, "ben-private-entry")
	send(benSharedSocket, 11, "conversation:feature")
	require.JSONEq(t, `{"id":"`+feature.ID+`","entries":[]}`, string(receive(benSharedSocket, 11, "snap").Data))
	send(aliceSharedSocket, 11, "conversation:feature")
	require.Empty(t, receive(aliceSharedSocket, 11, "err").Data)
	benQueue := until(benSocket, 1, "Ben queue canary")
	require.Contains(t, benQueue, queued.TurnID)
	require.NotContains(t, benQueue, "held")
	require.NotContains(t, call("GET", "/api/conversations/main/view-state", "", aliceCookie, 200), "Ben queue canary")
	require.Contains(t, call("GET", "/api/conversations/main/view-state", "", benCookie, 200), "Ben queue canary")
	call("PUT", "/api/conversations/main/view-state", `{"queue":[{"prompt":"forged"}]}`, benCookie, 400)
	var aliceQueued struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal([]byte(call("POST", "/api/conversations/main/prompt", `{"prompt":"Alice queue canary","idempotencyKey":"private-queue"}`, aliceCookie, 202)), &aliceQueued))
	aliceQueue := until(aliceSocket, 1, "Alice queue canary")
	require.NotContains(t, aliceQueue, "Ben queue canary")
	require.NotContains(t, call("GET", "/api/conversations/main/view-state", "", benCookie, 200), "Alice queue canary")
	// A fresh socket restores the durable queue without the original tab.
	reconnected := open(benCookie)
	send(reconnected, 1, benTopic)
	require.Contains(t, string(receive(reconnected, 1, "snap").Data), "Ben queue canary")
	call("PATCH", "/api/conversations/main/turns/"+queued.TurnID, `{"prompt":"Ben edited queue"}`, benCookie, 200)
	editedQueue := until(benSocket, 1, "Ben edited queue")
	require.NotContains(t, editedQueue, "Ben queue canary")
	call("DELETE", "/api/conversations/main/turns/"+queued.TurnID, "", benCookie, 200)
	for range 10 {
		if !strings.Contains(string(receive(benSocket, 1, "snap").Data), `"queue"`) {
			break
		}
	}
	require.NotContains(t, call("GET", "/api/conversations/main/view-state", "", benCookie, 200), `"queue"`)
	call("DELETE", "/api/conversations/main/turns/"+aliceQueued.TurnID, "", aliceCookie, 200)
	call("POST", "/api/conversations/main/turns/"+held.TurnID+"/stop", "", benCookie, 200)
	// Removal commits through the member route and closes the private delivery.
	call("DELETE", "/api/members/ben", "", ownerCookie, 204)
	closeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		_, _, err := benSocket.Read(closeCtx)
		if err != nil {
			require.NotEqual(t, context.DeadlineExceeded, closeCtx.Err())
			break
		}
	}
}
