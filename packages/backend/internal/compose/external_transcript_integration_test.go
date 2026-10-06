package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestExternalImportCommitReplay(t *testing.T) {
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

	host := revokedAuthorHost{started: make(chan ports.ChatTurnGrant, 8), stopped: make(chan string, 8)}

	runtime, err := chat.NewRuntime(pool, host, "http://127.0.0.1:4000", chat.RuntimeOptions{})
	require.NoError(t, err)
	branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
	runtime.Handler.ResolveBranch = conversationBranchResolver(branches)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{"http://127.0.0.1:4000"}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}).(chi.Router)
	mountChatPublic(router, runtime, q, cfg)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runtime.Run(runCtx) }()
	defer func() { cancel(); require.NoError(t, <-done) }()
	server := httptest.NewServer(router)
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
	call := func(method, path, body, cookie string, expected int) string {
		res := request(method, path, body, cookie)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, expected, res.StatusCode, string(raw))
		return string(raw)
	}

	var machineOwner int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM users WHERE username='smithers-machines'`).Scan(&machineOwner))
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, Name: "external", TargetBookmark: "feature", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	store, err := chat.NewStore(pool)
	require.NoError(t, err)
	registry := new(machined.Registry)
	authority, err := registry.MintBoot(branch.ID, "vm-external")
	require.NoError(t, err)
	connection, err := registry.Admit(authority.ID, []byte(authority.Credential), io.NopCloser(strings.NewReader("")))
	require.NoError(t, err)
	participant := [16]byte{1}
	source := [16]byte{2}
	scope := chat.Scope{RepositoryID: repo.ID, UserID: ben.ID, Owner: "ben"}
	sessionBinding := TranscriptBinding{Scope: scope, Session: 1, Participant: participant, Source: source, Live: true}
	draft := chat.ExternalDraft{ID: "literal-source-offset-0", SourceID: "claude-message-1", Origin: "external", ReadOnly: true, Agent: "claude-code", Profile: "claude-code/2.1.0", Session: "1", Participant: "01000000-0000-0000-0000-000000000000", Owner: fmt.Sprint(ben.ID), Author: "01000000-0000-0000-0000-000000000000", Kind: "assistant", Body: json.RawMessage(`"The answer is 42"`)}
	fail := true
	writer := &TranscriptIngest{Store: store, Resolve: func(context.Context, pgx.Tx, string, uint32) (TranscriptBinding, error) { return sessionBinding, nil }, Normalize: func(context.Context, pgx.Tx, string, TranscriptBinding, wire.Transcript) ([]chat.ExternalDraft, error) {
		return []chat.ExternalDraft{draft}, nil
	}}
	ingestor := &machined.Ingestor{Pool: pool, Write: func(ctx context.Context, tx pgx.Tx, b string, e machined.Event) (machined.Acknowledgement, error) {
		ack, err := writer.Write(ctx, tx, b, e)
		if err == nil && fail {
			return ack, errors.New("fixture failure before commit")
		}
		return ack, err
	}}
	payload, err := wire.EncodeTranscript(wire.Transcript{Version: 1, Session: 1, Participant: participant, Source: source, Profile: "claude-code/2.1.0", Generation: 1, End: 16, Record: `{"type":"user"}`})
	require.NoError(t, err)
	event := machined.Event{Seq: 1, EventID: [16]byte{3}, Payload: payload}
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.ErrorContains(t, err, "fixture failure before commit")
	var entries, receipts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
	require.Zero(t, entries)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
	require.Zero(t, receipts)
	fail = false
	ack, err := ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, machined.AckApplied, ack.Outcome)
	// Lost acknowledgment and a new host/store instance retain the same history.
	store, err = chat.NewStore(pool)
	require.NoError(t, err)
	writer.Store = store
	ack, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, machined.AckDuplicate, ack.Outcome)
	event.Seq = 2
	event.EventID[0] = 4
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
	require.Equal(t, 1, entries)
	shared := call("GET", "/api/conversations/"+branch.ID, "", benCookie, 200)
	require.Contains(t, shared, `"The answer is 42"`)
	require.Contains(t, shared, `"origin":"external"`)
	require.Contains(t, shared, `"read_only":true`)
	require.JSONEq(t, shared, call("GET", "/api/conversations/"+branch.ID, "", aliceCookie, 200))
	var conversation chat.SharedConversation
	require.NoError(t, json.Unmarshal([]byte(shared), &conversation))
	require.Len(t, conversation.Entries, 1)
	id := conversation.Entries[0].ID
	for _, cookie := range []string{benCookie, aliceCookie} {
		call("PATCH", "/api/conversations/"+branch.ID+"/turns/"+id, `{"prompt":"mutate imported"}`, cookie, 403)
		call("POST", "/api/conversations/"+branch.ID+"/turns/"+id+"/stop", "{}", cookie, 403)
		call("DELETE", "/api/conversations/"+branch.ID+"/turns/"+id, "", cookie, 403)
	}
	select {
	case <-host.started:
		t.Fatal("import launched app-agent turn")
	default:
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE NOT terminal`).Scan(&entries))
	require.Zero(t, entries)
	// Missing or revoked dependencies refuse before normalization or persistence.
	for _, alter := range []func(*TranscriptIngest){func(w *TranscriptIngest) { w.Store = nil }, func(w *TranscriptIngest) { w.Resolve = nil }, func(w *TranscriptIngest) { w.Normalize = nil }} {
		clone := *writer
		alter(&clone)
		ingestor.Write = clone.Write
		event.Seq++
		event.EventID[0]++
		_, err = ingestor.Commit(ctx, connection, branch.ID, event)
		require.ErrorIs(t, err, machined.ErrNotReady)
	}
	ingestor.Write = writer.Write
	sessionBinding.Live = false
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.ErrorIs(t, err, machined.ErrUnauthorized)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
	require.Equal(t, 2, receipts)
	// Bookkeeping records commit their adapter state even with no visible draft.
	bindingLive := true
	sessionBinding.Live = bindingLive
	adapter := &checkpointTestAdapter{}
	writer.Normalize = nil
	writer.Host = adapter
	sessionBinding.Source = [16]byte{7}
	record := wire.Transcript{Version: 1, Session: 1, Participant: participant, Source: sessionBinding.Source, Profile: "claude-code/2.1.0", Generation: 1, End: 16, Record: `{"type":"user"}`}
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event = machined.Event{Seq: 30, EventID: [16]byte{30}, Payload: payload}
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 1, adapter.calls)
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 1, adapter.calls)
	record.Start = 16
	record.End = 32
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event.Payload = payload
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 2, adapter.calls)
	require.JSONEq(t, `{"offset":16,"pending":"","calls":{"tool1":{"name":"read","input":{"path":"a.ts"}}}}`, string(adapter.previous))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE transcript_checkpoint IS NOT NULL`).Scan(&receipts))
	require.Equal(t, 3, receipts)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
	require.Equal(t, 1, entries)
	// A changed record at an already committed range never re-normalizes.
	record.Start = 0
	record.End = 16
	record.Record = `{"type":"edit"}`
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event.Payload = payload
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.ErrorIs(t, err, chat.ErrConflict)
	require.Equal(t, 2, adapter.calls)

}

// Test-only adapter provider. Packaged HTTP tests exercise the real TS decoder;
// this provider isolates the receipt transaction from parser semantics.
type checkpointTestAdapter struct {
	calls    int
	previous json.RawMessage
}

func (a *checkpointTestAdapter) NormalizeExternalTranscript(_ context.Context, input chat.ExternalNormalizeInput) (chat.ExternalNormalized, error) {
	a.calls++
	a.previous = append(json.RawMessage(nil), input.State...)
	state := json.RawMessage(fmt.Sprintf(`{"offset":%d,"pending":"","calls":{"tool1":{"name":"read","input":{"path":"a.ts"}}}}`, input.End))
	return chat.ExternalNormalized{Entries: []chat.ExternalDraft{}, State: state}, nil
}
