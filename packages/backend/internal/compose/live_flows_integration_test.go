package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This is transport/projection coverage, not a microVM activation receipt.
// No broker is attached: a missed hint must not leave the Flow card stale.
func TestLiveFlowsRepairsMissedHintAndKeepsActive(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "flow-owner", LowerUsername: "flow-owner"})
	require.NoError(t, err)
	var repository int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,is_public) VALUES ($1,'app','app','main',false) RETURNING id`, user.ID).Scan(&repository))
	active, failed := strings.Repeat("a", 64), strings.Repeat("b", 64)
	_, err = q.InsertFlowVersion(ctx, repository, "todo", "flows/todo/flow.ts", strings.Repeat("1", 40), active, "loaded", "", json.RawMessage(`{"steps":[{"id":"changelog","label":"Changelog"}]}`))
	require.NoError(t, err)
	_, err = q.ActivateFlowVersion(ctx, repository, "todo", active)
	require.NoError(t, err)
	topics := &liveTopics{queries: q}
	source, refusal := topics.resolve(ctx, "flows", repository, "flow-owner/app", user.ID)
	require.Empty(t, refusal)
	require.Equal(t, time.Second, source.Every)
	hub := live.NewHub(ctx, nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{live.Protocol}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		hub.Serve(r.Context(), conn, func(ctx context.Context, topic string) (live.Source, string) {
			return topics.resolve(ctx, topic, repository, "flow-owner/app", user.ID)
		})
	}))
	defer server.Close()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{Subprotocols: []string{live.Protocol}})
	require.NoError(t, err)
	defer conn.CloseNow()
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"flows"}`)))
	read := func(timeout time.Duration) liveFrame {
		t.Helper()
		bounded, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		_, raw, err := conn.Read(bounded)
		require.NoError(t, err)
		var frame liveFrame
		require.NoError(t, json.Unmarshal(raw, &frame))
		require.Equal(t, "snap", frame.T)
		return frame
	}
	first := read(3 * time.Second)
	var cards []services.FlowCard
	require.NoError(t, json.Unmarshal(first.Data, &cards))
	require.Equal(t, "todo", cards[1].Name)
	require.Equal(t, active, cards[1].Versions[0].ID)
	require.Equal(t, []services.FlowStep{{ID: "changelog", Label: "Changelog"}}, cards[1].Versions[0].Steps)
	_, err = q.RequestMythicalBootstrap(ctx, repository, user.ID, 100, false)
	require.NoError(t, err)
	load, err := q.EnsureFlowLoad(ctx, repository)
	require.NoError(t, err)
	load.CommitID, load.LoadedCommit = strings.Repeat("2", 40), strings.Repeat("2", 40)
	load.Versions = json.RawMessage(`[{"name":"todo","path":"flows/todo/flow.ts","digest":"` + failed + `","status":"failed","error":"flows/todo/flow.ts:12: invalid type"}]`)
	_, err = q.SaveFlowLoad(ctx, load)
	require.NoError(t, err)
	// Allow scheduling overhead, while refusing the old five-second cadence.
	changed := read(2 * time.Second)
	require.NotNil(t, first.Cursor)
	require.NotNil(t, changed.Cursor)
	require.Greater(t, *changed.Cursor, *first.Cursor)
	require.NoError(t, json.Unmarshal(changed.Data, &cards))
	require.Equal(t, "todo", cards[1].Name)
	require.Equal(t, active, cards[1].Versions[0].ID)
	require.Equal(t, []services.FlowStep{{ID: "changelog", Label: "Changelog"}}, cards[1].Versions[0].Steps)
	require.Equal(t, "active", cards[1].Versions[0].State)
	require.Equal(t, failed, cards[1].Versions[1].ID)
	require.Equal(t, "merged-failed", cards[1].Versions[1].State)
	require.Equal(t, "flows/todo/flow.ts:12: invalid type", cards[1].Versions[1].Error)
}

// The person-facing install route reads the same persisted version metadata
// across fresh compositions; it never replaces it with built-in steps.
func TestInstallFlowsServesPersistedGuestSteps(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "flow-owner", LowerUsername: "flow-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repository int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,is_public) VALUES ($1,'app','app','main',false) RETURNING id`, owner.ID).Scan(&repository))
	binding := fmt.Sprintf(`{"owner_login":"flow-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repository, time.Now().UTC().Format(time.RFC3339))
	for key, value := range map[string]string{"github.repository": binding, "owner.access": binding} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	const cookie = "flow-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	digest := strings.Repeat("a", 64)
	_, err = q.InsertFlowVersion(ctx, repository, "todo", "flows/todo/flow.ts", strings.Repeat("1", 40), digest, "loaded", "", json.RawMessage(`{"steps":[{"id":"changelog","label":"Changelog"}]}`))
	require.NoError(t, err)
	_, err = q.ActivateFlowVersion(ctx, repository, "todo", digest)
	require.NoError(t, err)

	// Persist the guest projection through the shared provider, as settlement
	// does. A new install composition must replay it at the same source cursor.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	cards, err := services.RepositoryFlowCatalog(ctx, db.New(tx), repository)
	require.NoError(t, err)
	projection, err := json.Marshal(map[string]any{"card": cards})
	require.NoError(t, err)
	event, err := jobs.RecordFactInTx(ctx, tx, services.FlowLiveScope(repository), uuid.NewString(), "flows.changed", "completed", projection)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	for attempt := range 2 {
		t.Run(fmt.Sprint(attempt), func(t *testing.T) {
			server := httptest.NewUnstartedServer(nil)
			origin := "http://" + server.Listener.Addr().String()
			t.Setenv("SMITHERS_PUBLIC_URL", origin)
			server.Config.Handler = startSplitProcess(t, Options{FlowHostProductAPIURL: origin, Workspace: runtime, ChatHost: unusedChatHost{}})
			server.Start()
			req, err := http.NewRequest("GET", server.URL+"/api/flows", nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			response, err := server.Client().Do(req)
			require.NoError(t, err)
			require.Equal(t, http.StatusOK, response.StatusCode)
			var cards []services.FlowCard
			require.NoError(t, json.NewDecoder(response.Body).Decode(&cards))
			require.NoError(t, response.Body.Close())

			bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			conn, _, err := websocket.Dial(bounded, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{
				Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + cookie}, "Origin": {origin}},
			})
			require.NoError(t, err)
			defer conn.CloseNow()
			require.NoError(t, conn.Write(bounded, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"flows","cursor":0}`)))
			_, raw, err := conn.Read(bounded)
			require.NoError(t, err)
			var frame liveFrame
			require.NoError(t, json.Unmarshal(raw, &frame))
			require.Equal(t, "delta", frame.T, string(raw))
			require.NotNil(t, frame.Cursor)
			require.Equal(t, event.Sequence, *frame.Cursor)
			var replayed jobs.Event
			require.NoError(t, json.Unmarshal(frame.Data, &replayed))
			require.JSONEq(t, string(projection), string(replayed.Data))
			conn.CloseNow()
			server.Close()
			require.Equal(t, digest, cards[1].Versions[0].ID)
			require.Equal(t, []services.FlowStep{{ID: "changelog", Label: "Changelog"}}, cards[1].Versions[0].Steps)
		})
	}
}
