package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/services"
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
	_, err = q.InsertFlowVersion(ctx, repository, "todo", "flows/todo/flow.ts", strings.Repeat("1", 40), active, "loaded", "", json.RawMessage(`{"steps":[]}`))
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
	require.Equal(t, active, cards[0].Versions[0].ID)
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
	require.Equal(t, active, cards[0].Versions[0].ID)
	require.Equal(t, "active", cards[0].Versions[0].State)
	require.Equal(t, failed, cards[0].Versions[1].ID)
	require.Equal(t, "merged-failed", cards[0].Versions[1].State)
	require.Equal(t, "flows/todo/flow.ts:12: invalid type", cards[0].Versions[1].Error)
}
