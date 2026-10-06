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
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/externalsessions"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// The owner's Codex and Claude Code sessions through the composed install
// router, the live channel and real PostgreSQL (mvp.md M-38): the owner's
// browser session reads a rollout as raw JSONL from a byte offset in
// chunks that end at a line boundary, follows its growth on
// external:<agent>:<session>, and is the owner the read names. A member,
// a maintainer, a person off the roster and the owner's own token are
// refused, and no read reaches a file outside the agents' session
// directories.
func TestExternalSessionsComposedInstallPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user := func(name, display string) db.User {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name, DisplayName: display})
		require.NoError(t, err)
		return created
	}
	owner, maintainer, writer, outsider := user("ben", "Ben Ito"), user("maya", "Maya"), user("alice", "Alice"), user("carol", "Carol")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	for _, row := range []struct {
		user       db.User
		permission string
		githubID   int64
	}{{owner, "admin", 101}, {maintainer, "admin", 102}, {writer, "write", 103}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,$3,$4,$5)`,
			repo.ID, row.user.ID, row.permission, row.githubID, row.user.Username)
		require.NoError(t, err)
	}
	github := &rosterGitHub{roles: map[string]string{"ben": "admin", "maya": "maintain", "alice": "write"}}
	provider := httptest.NewServer(http.HandlerFunc(github.serve))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)

	// The install runs as Ben: his Codex home and his Claude Code home.
	home := t.TempDir()
	const codexID = "0199e2e0-0000-7000-8000-00000000c0de"
	const claudeID = "5b2c9e10-4d3a-4f6e-9a1b-7c8d9e0f1a2b"
	rollout := filepath.Join(home, ".codex", "sessions", "2026", "10", "05", "rollout-2026-10-05T11-45-26-"+codexID+".jsonl")
	meta := `{"timestamp":"2026-10-05T18:00:00.000Z","type":"session_meta","payload":{"id":"` + codexID + `","cwd":"/repo","cli_version":"0.160.0"}}` + "\n"
	prompt := `{"timestamp":"2026-10-05T18:00:01.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","content":[{"type":"text","text":"Make the reset link expire · naïve"}]}}}` + "\n"
	require.NoError(t, os.MkdirAll(filepath.Dir(rollout), 0o700))
	require.NoError(t, os.WriteFile(rollout, []byte(meta+prompt+`{"partial":`), 0o600))
	transcript := filepath.Join(home, ".claude", "projects", "-Users-ben-repo", claudeID+".jsonl")
	require.NoError(t, os.MkdirAll(filepath.Dir(transcript), 0o700))
	require.NoError(t, os.WriteFile(transcript, []byte(`{"type":"user","sessionId":"`+claudeID+`"}`+"\n"), 0o600))
	// A file beside the homes is never a session, whatever a request names.
	require.NoError(t, os.WriteFile(filepath.Join(home, "secret.jsonl"), []byte("secret\n"), 0o600))
	finder := &externalsessions.Finder{Home: home}

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	topics := &liveTopics{queries: q, external: finder}
	liveHandler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{Members: &routes.MembersHandler{Service: members}, Live: liveHandler, ExternalSessions: &routes.ExternalSessionsHandler{Queries: q, Sessions: finder}})
	server.Start()
	defer server.Close()

	session := func(u db.User) string {
		key := u.Username + "-cookie"
		digest := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	seed := sha256.Sum256([]byte("ben-pat"))
	pat := "smithers_" + hex.EncodeToString(seed[:])[:40]
	hash := sha256.Sum256([]byte(pat))
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "pat", TokenHash: hex.EncodeToString(hash[:]),
		TokenLastEight: hex.EncodeToString(hash[:])[56:], Scopes: "all", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	type credential struct{ cookie, bearer string }
	ben := credential{cookie: session(owner)}
	get := func(c credential, query string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, origin+"/api/external/sessions?"+query, nil)
		require.NoError(t, err)
		req.Header.Set("Origin", origin)
		if c.cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: c.cookie})
		}
		if c.bearer != "" {
			req.Header.Set("Authorization", "Bearer "+c.bearer)
		}
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		body := map[string]any{}
		require.NoError(t, json.Unmarshal(raw, &body), string(raw))
		return res.StatusCode, body
	}

	// Complete lines from the offset; the line Codex is still writing waits.
	status, body := get(ben, "agent=codex&session=0199e2e0")
	require.Equal(t, http.StatusOK, status, body)
	complete := float64(len(meta + prompt))
	require.Equal(t, map[string]any{"agent": "codex", "session_id": codexID, "owner": map[string]any{"login": "ben", "name": "Ben Ito"},
		"offset": 0.0, "next": complete, "text": meta + prompt, "eof": true}, body)
	status, body = get(ben, fmt.Sprintf("agent=codex&session=%s&offset=%d", codexID, len(meta)))
	require.Equal(t, http.StatusOK, status, body)
	require.Equal(t, prompt, body["text"])
	status, body = get(ben, fmt.Sprintf("agent=codex&session=%s&offset=%d", codexID, int(complete)))
	require.Equal(t, http.StatusOK, status, body)
	require.Equal(t, []any{complete, "", true}, []any{body["next"], body["text"], body["eof"]})
	status, body = get(ben, "agent=claude-code&session=5b2c")
	require.Equal(t, http.StatusOK, status, body)
	require.Equal(t, []any{"claude-code", claudeID}, []any{body["agent"], body["session_id"]})

	// Refusals in the install's envelope.
	for _, tc := range []struct {
		query  string
		status int
		code   string
	}{
		{"agent=codex&session=ffffffff", http.StatusNotFound, "source_not_found"},
		{"agent=claude-code&session=" + codexID, http.StatusNotFound, "source_not_found"},
		{"agent=gemini&session=0199e2e0", http.StatusBadRequest, "invalid_request"},
		{"agent=codex&session=../../secret", http.StatusBadRequest, "invalid_request"},
		{"agent=codex&session=019", http.StatusBadRequest, "invalid_request"},
		{"agent=codex&session=0199e2e0&offset=-1", http.StatusBadRequest, "invalid_request"},
		{"agent=codex&session=0199e2e0&offset=01", http.StatusBadRequest, "invalid_request"},
		{"agent=codex&session=0199e2e0&offset=99999", http.StatusConflict, "offset_out_of_range"},
	} {
		status, body = get(ben, tc.query)
		require.Equal(t, tc.status, status, tc.query)
		require.Equal(t, tc.code, body["code"], tc.query)
		require.NotContains(t, fmt.Sprint(body), "secret\n", tc.query)
	}
	ambiguous := filepath.Join(home, ".codex", "sessions", "2026", "10", "05", "rollout-2026-10-05T12-00-00-0199e2e0-1111-7000-8000-000000000000.jsonl")
	require.NoError(t, os.WriteFile(ambiguous, []byte(meta), 0o600))
	status, body = get(ben, "agent=codex&session=0199e2e0")
	require.Equal(t, http.StatusConflict, status)
	require.Equal(t, "ambiguous_session", body["code"])
	require.NoError(t, os.Remove(ambiguous))

	// Only the owner's browser session reads them.
	aliceCookie := session(writer)
	for who, c := range map[string]credential{"maintainer": {cookie: session(maintainer)}, "member": {cookie: aliceCookie},
		"off roster": {cookie: session(outsider)}, "owner's token": {bearer: pat}, "signed out": {}} {
		status, body = get(c, "agent=codex&session="+codexID)
		require.Contains(t, []int{http.StatusUnauthorized, http.StatusForbidden}, status, who)
		require.NotContains(t, body, "text", who)
	}

	// external:codex:<session> follows the file's size: an append is a new snapshot.
	dial := func(cookie string) *websocket.Conn {
		t.Helper()
		dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{
			Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=" + cookie}}})
		require.NoError(t, err)
		t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
		return conn
	}
	type frame struct {
		T    string          `json:"t"`
		ID   uint32          `json:"id"`
		Data json.RawMessage `json:"data"`
		Code string          `json:"code"`
	}
	next := func(conn *websocket.Conn) frame {
		t.Helper()
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := conn.Read(readCtx)
		require.NoError(t, err)
		var f frame
		require.NoError(t, json.Unmarshal(raw, &f))
		return f
	}
	sub := func(conn *websocket.Conn, id uint32, topic string) {
		t.Helper()
		require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":%d,"topic":%q}`, id, topic))))
	}
	socket := dial(ben.cookie)
	sub(socket, 1, "external:codex:0199e2e0")
	first := next(socket)
	require.Equal(t, "snap", first.T)
	size := func(f frame) float64 {
		var data map[string]any
		require.NoError(t, json.Unmarshal(f.Data, &data))
		require.Equal(t, codexID, data["session_id"])
		return data["size"].(float64)
	}
	require.Equal(t, complete+float64(len(`{"partial":`)), size(first))
	file, err := os.OpenFile(rollout, os.O_APPEND|os.O_WRONLY, 0)
	require.NoError(t, err)
	_, err = file.WriteString(`"done"}` + "\n")
	require.NoError(t, err)
	require.NoError(t, file.Close())
	grown := next(socket)
	require.Equal(t, "snap", grown.T)
	require.Equal(t, complete+float64(len(`{"partial":"done"}`+"\n")), size(grown))
	for topic, code := range map[string]string{"external:codex:ffffffff": live.UnknownTopic, "external:gemini:0199e2e0": live.UnknownTopic,
		"external:codex:../x": live.UnknownTopic} {
		sub(socket, 2, topic)
		refused := next(socket)
		require.Equal(t, frame{T: "err", ID: 2, Code: code}, refused, topic)
	}
	// A member's socket is refused the owner's session.
	member := dial(aliceCookie)
	sub(member, 1, "external:codex:"+codexID)
	require.Equal(t, frame{T: "err", ID: 1, Code: live.Forbidden}, next(member))
}
