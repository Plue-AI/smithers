package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type retainedHTTPCase struct {
	Command, Method, Path, Door, Delegated string
	MaintainerDelegated, MemberDelegated   string
	Body                                   map[string]any
	System                                 bool
	Decision                               string
}

// This campaign is intentionally separate from the 58-cell admission ledger.
// It starts the install itself, not a router with empty handlers. The frozen
// HTTP oracle never reads descriptors to decide an expected result.
func TestRetainedCommandHTTPStateEffectsPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed-install PostgreSQL campaign runs in the access integration gate")
	}
	var fixture struct{ Commands []retainedHTTPCase }
	data, err := os.ReadFile("testdata/access/retained-http.json")
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &fixture))
	t.Setenv("SMITHERS_RETAINED_ACCESS_CAMPAIGN", "1")
	r := newRehearsal(t, "SMITHERS_RETAINED_ACCESS_CAMPAIGN", "C-ACC-01", "retained-")
	require.True(t, r.install("Retained commands"))
	benJar, err := r.member("ben", 208, "admin")
	require.NoError(t, err)
	aliceJar, err := r.member("alice", 209, "write")
	require.NoError(t, err)
	pool, ctx := r.pool, r.ctx
	q := db.New(pool)
	owner, err := q.GetUserByLowerUsername(ctx, "rehearsal-owner")
	require.NoError(t, err)
	ben, err := q.GetUserByLowerUsername(ctx, "ben")
	require.NoError(t, err)
	alice, err := q.GetUserByLowerUsername(ctx, "alice")
	require.NoError(t, err)
	repo, err := q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: owner.Username, LowerName: "app"})
	require.NoError(t, err)
	issuer := services.NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	issuer.Members = &services.Members{Pool: pool}
	type credential struct {
		name, token, cookie string
		user                int64
	}
	var credentials []credential
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	for index, u := range []db.User{owner, ben, alice} {
		jar := r.jar
		if index == 1 {
			jar = benJar
		}
		if index == 2 {
			jar = aliceJar
		}
		cookie := ""
		for _, c := range jar.Cookies(origin) {
			if c.Name == "smithers_session" || c.Name == "session" {
				cookie = c.Value
			}
		}
		require.NotEmpty(t, cookie, "OAuth must mint a real browser session")
		credentials = append(credentials, credential{name: u.Username + "/session", cookie: cookie, user: u.ID})
		for _, via := range []string{"cli", "codex"} {
			data, err := r.expectAs(jar, "POST", "/api/user/tokens", fmt.Sprintf(`{"name":"retained-%s","via":"%s","scopes":["repo","user"]}`, via, via), 201)
			require.NoError(t, err)
			var token struct{ Token string }
			require.NoError(t, json.Unmarshal(data, &token))
			require.NotEmpty(t, token.Token)
			credentials = append(credentials, credential{name: u.Username + "/external_agent/" + via, token: token.Token, user: u.ID})
		}
		app, err := issuer.MintForTurn(ctx, u.ID, liveAppTurnCredentialFixture(t, pool, u.ID), 1)
		require.NoError(t, err)
		credentials = append(credentials, credential{name: u.Username + "/app_agent", token: app.Token, user: u.ID})
	}
	limited, err := issuer.CreateToken(ctx, owner.ID, services.CreateTokenRequest{Name: "retained-limited", Via: "codex", Scopes: []string{"read:user", "read:repository"}})
	require.NoError(t, err)
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: ben.ID, Name: "retained-system", TargetBookmark: "main", Kind: "container", Status: "running"})
	require.NoError(t, err)
	router := r.server.Config.Handler
	cookieName := "smithers_session"
	for _, c := range r.jar.Cookies(origin) {
		if c.Value == credentials[0].cookie {
			cookieName = c.Name
		}
	}
	// Bootstrap wiki work runs independently. Snapshot command subjects and
	// all non-bootstrap admissions; do not treat guest heartbeats as effects.
	snapshot := func() string {
		t.Helper()
		var result string
		require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_build_object(
   'members',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM collaborators t),
   'secrets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM repository_secrets t),
   'todos',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM mythical_items t),
   'confirmations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM approvals t),
   'workspaces',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM workspaces t WHERE t.id=$1 OR (t.name NOT LIKE 'mythical wiki %' AND t.name NOT LIKE 'mythical source %' AND t.name NOT LIKE 'flow-load g%')),
   'requests',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM product_job_requests t WHERE t.request_id LIKE 'campaign-%'),
   'workflows',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM workflow_runs t WHERE NOT (t.trigger_event='main' AND t.trigger_ref='mythical'))
  )::text`, workspace.ID).Scan(&result))
		return result
	}
	replacements := strings.NewReplacer("{owner}", "rehearsal-owner", "{repo}", "app", "{n}", "1", "{number}", "1", "{branch}", "sample", "{b}", "sample", "{name}", "CAMPAIGN_SECRET", "{id}", "1", "{run_id}", "1", "{documentId}", "campaign-document", "{pattern}", "main", "{child_id}", "campaign-child", "{operationID}", "campaign-operation", "{port}", "3000", "{delivery_id}", "1")
	var receipts []map[string]any
	// Qualify the canonical catalog door with real admitted effects as well as
	// refusals. The same existing service handles POST and historical PUT.
	for index, cred := range []credential{credentials[0], credentials[4]} {
		jar := r.jar
		if index == 1 {
			jar = benJar
		}
		body, err := r.expectAs(jar, "POST", "/api/secrets", fmt.Sprintf(`{"name":"CANONICAL_POST","value":"person-secret-%d"}`, index), 201)
		require.NoError(t, err)
		require.NotContains(t, string(body), "person-secret")
		require.NotContains(t, string(body), `"value"`)
		var encrypted []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT value_encrypted FROM repository_secrets WHERE repository_id=$1 AND name='CANONICAL_POST'`, repo.ID).Scan(&encrypted))
		require.NotEqual(t, []byte(fmt.Sprintf("person-secret-%d", index)), encrypted)
		receipts = append(receipts, map[string]any{"command": "secrets.set", "credential": cred.name, "state": "active", "status": 201, "effects": 1, "boundary": "HTTP socket with OAuth browser session"})
	}
	githubMutations := func() []any {
		// The fake records every POST, including Git's read-only upload-pack.
		// Background mirror reads are not command-owned outbound mutations.
		var writes []any
		for _, write := range r.fake.Writes() {
			if strings.HasSuffix(write.Path, "/git-upload-pack") {
				continue
			}
			writes = append(writes, write)
		}
		return writes
	}
	request := func(t *testing.T, c retainedHTTPCase, cred credential, state string, status int, code string) {
		t.Helper()
		body, err := json.Marshal(c.Body)
		require.NoError(t, err)
		path := c.Path
		if c.System {
			path = strings.ReplaceAll(path, "{id}", workspace.ID)
		}
		req := httptest.NewRequest(c.Method, r.origin+replacements.Replace(path), strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", r.origin)
		req.RemoteAddr = "127.0.0.1:50999"
		req.Header.Set("Idempotency-Key", fmt.Sprintf("campaign-%d", len(receipts)))
		// Every request carries forged attribution. Stored kind/via stays decisive.
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		req.Header.Set("Smithers-Profile", "full")
		if cred.token != "" {
			req.Header.Set("Authorization", "Bearer "+cred.token)
		}
		if cred.cookie != "" {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: cred.cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "campaign"})
			req.Header.Set("X-CSRF-Token", "campaign")
		}
		before := snapshot()
		outboundBefore := githubMutations()
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		if c.Command == "workspace.provider-pool" && c.System && cred.token == "" {
			require.JSONEq(t, `{"error":{"message":"Authentication required.","type":"authentication_error"}}`, out.Body.String())
			require.Equal(t, before, snapshot())
			receipts = append(receipts, map[string]any{"command": c.Command, "credential": cred.name, "state": state, "status": 401, "protocol": "model", "effects": 0})
			return
		}
		var envelope struct{ Code, Class, Message string }
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &envelope), out.Body.String())
		require.Equal(t, code, envelope.Code, out.Body.String())
		class := "permission"
		if code == "never" {
			class = "never"
			require.Equal(t, "Only a person can do this", envelope.Message)
		}
		require.Equal(t, class, envelope.Class)
		var fields map[string]any
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &fields))
		for _, key := range []string{"confirmation", "state", "result", "value", "subject"} {
			require.NotContains(t, fields, key, "refusal must not disclose a result")
		}
		if code == "never" {
			require.Len(t, decisions, 1, "eligible forbidden delegation obtains one decision")
		}
		if status == 401 {
			require.Empty(t, decisions, "dead credentials must precede policy")
		} else {
			require.LessOrEqual(t, len(decisions), 1, "one bound decision")
		}
		if c.Decision != "" && status != 401 {
			if strings.HasSuffix(cred.name, "/terminal_s1") {
				require.Empty(t, decisions, "terminal profile excludes workflow dispatch before policy")
			} else {
				require.Equal(t, []string{c.Decision}, decisions, "dispatch must decide once before effects")
			}
		}
		require.NotContains(t, out.Body.String(), "never-disclose-campaign-secret")
		require.Equal(t, before, snapshot(), "refusal must preserve exact effect rows")
		require.Equal(t, outboundBefore, githubMutations(), "refusal must not send a GitHub write")
		receipts = append(receipts, map[string]any{"command": c.Command, "credential": cred.name, "state": state, "method": c.Method, "path": c.Path, "door": c.Door, "expected_status": status, "expected_code": code, "expected_class": class, "status": out.Code, "code": envelope.Code, "class": envelope.Class, "effects": 0, "decisions": decisions})
	}
	// Independent live-role/profile oracle. These are production reads and
	// denied writes against the same install, not admission-ledger cells.
	for i, jar := range []http.CookieJar{r.jar, benJar, aliceJar} {
		for _, path := range []string{"/api/members", "/api/secrets"} {
			t.Run(fmt.Sprintf("live/session/%d%s", i, path), func(t *testing.T) {
				before := snapshot()
				body, err := r.expectAs(jar, "GET", path, "", 200)
				require.NoError(t, err)
				if path == "/api/members" {
					for _, login := range []string{"rehearsal-owner", "ben", "alice"} {
						require.Contains(t, string(body), login)
					}
				} else {
					require.Contains(t, string(body), "CANONICAL_POST")
					require.NotContains(t, string(body), `"value"`)
					require.NotContains(t, string(body), "person-secret")
				}
				require.Equal(t, before, snapshot())
				command := "members.list"
				if path == "/api/secrets" {
					command = "secrets.read"
				}
				receipts = append(receipts, map[string]any{"command": command, "credential": credentials[i*4].name, "state": "active", "path": path, "status": 200, "effects": 0, "read_assertions": "stored roster/secret names"})
			})
		}
	}
	// Admitted reads are qualified independently of the refusal sweep. A
	// stored review item and the real install catalogs supply visible data;
	// every full-profile person/app/external role must read the same subject.
	var readNumber int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,owner_id,created_by,revisions,checks)
 VALUES($1,'todo','proposed','Retained read subject','Retained read subject',$2,$2,'[]','{}') RETURNING number`, repo.ID, ben.ID).Scan(&readNumber))
	readCases := []struct{ command, path, shape string }{
		{"agents.read", "/api/agents", "agents"},
		{"agents.read", "/api/agents/planner", "planner"},
		{"agents.read", "/api/agents/implementer", "implementer"},
		{"agents.read", "/api/agents/reviewer", "reviewer"},
		{"agents.read", "/api/agents/app", "app"},
		{"flows.read", "/api/flows", "flows"},
		{"flows.read", "/api/flows/todo", "todo-flow"},
		{"todo.read", "/api/todos", "todos"},
		{"todo.read", fmt.Sprintf("/api/todos/%d", readNumber), "todo"},
		{"todo.read", "/api/stack", "stack"},
		{"confirmations.read", "/api/confirmations", "confirmations"},
	}
	for _, cell := range readCases {
		for _, cred := range credentials {
			t.Run("admitted-read/"+cell.path+"/"+cred.name, func(t *testing.T) {
				req := httptest.NewRequest("GET", r.origin+cell.path, nil)
				req.RemoteAddr = "127.0.0.1:50999"
				if cred.token != "" {
					req.Header.Set("Authorization", "Bearer "+cred.token)
				}
				if cred.cookie != "" {
					req.AddCookie(&http.Cookie{Name: cookieName, Value: cred.cookie})
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				before, outboundBefore := snapshot(), githubMutations()
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, 200, out.Code, out.Body.String())
				require.Equal(t, []string{cell.command}, decisions)
				require.NotContains(t, out.Body.String(), "never-disclose-campaign-secret")
				require.NotContains(t, out.Body.String(), "person-secret")
				switch cell.shape {
				case "agents", "planner", "implementer", "reviewer", "app":
					var value struct {
						CanAssign bool `json:"canAssign"`
						Agents    []struct {
							ID string `json:"id"`
						} `json:"agents"`
					}
					require.NoError(t, json.Unmarshal(out.Body.Bytes(), &value))
					var roles []string
					for _, agent := range value.Agents {
						roles = append(roles, agent.ID)
					}
					if cell.shape == "agents" {
						require.Equal(t, []string{"planner", "implementer", "reviewer", "app"}, roles)
					} else {
						require.Equal(t, []string{cell.shape}, roles)
					}
					// Even the Owner's delegated agent cannot assign a model.
					require.Equal(t, cred.user == owner.ID && cred.cookie != "", value.CanAssign)
				case "flows":
					var value []struct {
						Name string `json:"name"`
					}
					require.NoError(t, json.Unmarshal(out.Body.Bytes(), &value))
					var names []string
					for _, flow := range value {
						names = append(names, flow.Name)
					}
					require.Contains(t, names, "todo")
				case "todo-flow":
					var value struct {
						Name     string `json:"name"`
						Versions []struct {
							ID    string `json:"id"`
							State string `json:"state"`
						} `json:"versions"`
					}
					require.NoError(t, json.Unmarshal(out.Body.Bytes(), &value))
					require.Equal(t, "todo", value.Name)
					require.NotEmpty(t, value.Versions)
					require.Equal(t, "active", value.Versions[0].State)
					require.NotEmpty(t, value.Versions[0].ID)
				case "todos", "todo", "stack":
					require.Contains(t, out.Body.String(), "Retained read subject", "read must reach the stored TODO")
					var value any
					require.NoError(t, json.Unmarshal(out.Body.Bytes(), &value))
				case "confirmations":
					// This install has no pending confirmations; even the Owner's
					// delegated credential receives only its own empty collection.
					require.JSONEq(t, `[]`, out.Body.String())
				}
				require.Equal(t, before, snapshot(), "an admitted read cannot mutate command-owned rows")
				require.Equal(t, outboundBefore, githubMutations())
				receipts = append(receipts, map[string]any{"command": cell.command, "credential": cred.name, "state": "active/full", "path": cell.path, "status": 200, "effects": 0, "decisions": decisions, "read_assertions": cell.shape})
			})
		}
	}
	// Both implicit append and explicit create qualify every eligible full
	// delegated role/profile through the real persisted confirmation consumer.
	// They must never execute the TODO before its requesting person presses.
	call := func(cred credential, method, path, body, key, command string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, r.origin+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", r.origin)
		req.Header.Set("Idempotency-Key", key)
		req.RemoteAddr = "127.0.0.1:50999"
		if cred.token != "" {
			req.Header.Set("Authorization", "Bearer "+cred.token)
		}
		if cred.cookie != "" {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: cred.cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "campaign"})
			req.Header.Set("X-CSRF-Token", "campaign")
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, decisions)
		return out
	}
	withoutConfirmations := func() string {
		t.Helper()
		var rows map[string]json.RawMessage
		require.NoError(t, json.Unmarshal([]byte(snapshot()), &rows))
		delete(rows, "confirmations")
		data, err := json.Marshal(rows)
		require.NoError(t, err)
		return string(data)
	}
	personSessions := map[int64]credential{owner.ID: credentials[0], ben.ID: credentials[4], alice.ID: credentials[8]}
	pendingByMember := map[int64][]string{}
	seenConfirmationCredentials := map[string]string{}
	for _, cred := range []credential{credentials[0], credentials[4], credentials[8]} {
		request(t, retainedHTTPCase{Command: "confirmation.create", Method: "POST", Path: "/api/confirmations", Body: map[string]any{"command": "todo.new", "payload": map[string]any{"title": "Person create refused", "prompt": "Person create refused"}}}, cred, "active/full/explicit-create", 403, "permission")
	}
	for _, mode := range []string{"implicit", "explicit"} {
		for _, cred := range credentials {
			if cred.token == "" {
				continue
			}
			t.Run("confirmed-append/"+mode+"/"+cred.name, func(t *testing.T) {
				title := "Retained confirmation " + mode + " " + cred.name
				payload := map[string]any{"title": title, "prompt": "[PR] [FILE acc-profile.md] [HOLD acc-profile] " + title, "place": map[string]string{"mode": "append"}}
				path := "/api/todos"
				var input any = payload
				if mode == "explicit" {
					path = "/api/confirmations"
					input = map[string]any{"command": "todo.new", "payload": payload}
				}
				body, err := json.Marshal(input)
				require.NoError(t, err)
				key := fmt.Sprintf("campaign-confirm-%d", len(receipts))
				before, outboundBefore := withoutConfirmations(), githubMutations()
				var countBefore, countAfter int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&countBefore))
				out := call(cred, "POST", path, string(body), key, "todo.new", 202)
				var value map[string]string
				require.NoError(t, json.Unmarshal(out.Body.Bytes(), &value))
				require.Len(t, value, 2)
				require.NotEmpty(t, value["confirmation"])
				require.Equal(t, "pending", value["state"])
				id := value["confirmation"]
				var state, kind, command, storedCredential string
				var member int64
				require.NoError(t, pool.QueryRow(ctx, `SELECT state,kind,command,member_id,credential_id FROM approvals WHERE id=$1`, id).Scan(&state, &kind, &command, &member, &storedCredential))
				require.Equal(t, "pending", state)
				require.Equal(t, "one_click", kind)
				require.Equal(t, "todo.new", command)
				require.Equal(t, cred.user, member)
				require.NotEmpty(t, storedCredential)
				if previous, exists := seenConfirmationCredentials[storedCredential]; exists {
					require.Equal(t, cred.name, previous)
				}
				seenConfirmationCredentials[storedCredential] = cred.name
				pendingByMember[cred.user] = append(pendingByMember[cred.user], id)
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&countAfter))
				require.Equal(t, countBefore+1, countAfter)
				require.Equal(t, before, withoutConfirmations(), "confirmation creates no TODO/admission or management effects")
				require.Equal(t, outboundBefore, githubMutations())
				receipts = append(receipts, map[string]any{"command": "todo.new", "credential": cred.name, "state": "active/full/" + mode, "status": 202, "effects": 1, "effect_kind": "private-pending-confirmation", "todo_effects": 0, "decisions": []string{"todo.new"}})
				// A replay decides afresh before disclosing the saved response.
				beforeReplay := snapshot()
				replay := call(cred, "POST", path, string(body), key, "todo.new", 202)
				require.JSONEq(t, out.Body.String(), replay.Body.String())
				require.Equal(t, beforeReplay, snapshot())
				receipts = append(receipts, map[string]any{"command": "todo.new", "credential": cred.name, "state": "active/full/replay", "status": 202, "effects": 0, "decisions": []string{"todo.new"}})
				foreign := credentials[0]
				if cred.user == owner.ID {
					foreign = credentials[4]
				}
				for _, reader := range []credential{cred, personSessions[cred.user], foreign} {
					beforeRead := snapshot()
					listed := call(reader, "GET", "/api/confirmations", "", "", "confirmations.read", 200)
					var rows []map[string]any
					require.NoError(t, json.Unmarshal(listed.Body.Bytes(), &rows))
					var ids []string
					for _, row := range rows {
						ids = append(ids, row["id"].(string))
						if reader.token != "" {
							require.Len(t, row, 2)
							require.Equal(t, "pending", row["state"])
						}
					}
					require.ElementsMatch(t, pendingByMember[reader.user], ids)
					if reader.user == cred.user && reader.cookie != "" {
						require.Contains(t, listed.Body.String(), title)
					}
					if reader.user != cred.user {
						require.NotContains(t, listed.Body.String(), id)
						require.NotContains(t, listed.Body.String(), title)
					}
					if reader.token != "" {
						require.NotContains(t, listed.Body.String(), title)
					}
					require.Equal(t, beforeRead, snapshot())
					require.Equal(t, outboundBefore, githubMutations())
					receipts = append(receipts, map[string]any{"command": "confirmations.read", "credential": reader.name, "state": "active/full/private-audience", "status": 200, "effects": 0, "decisions": []string{"confirmations.read"}})
				}
				request(t, retainedHTTPCase{Command: "confirmation.decide-own", Method: "POST", Path: "/api/confirmations/" + id + "/approve", Body: map[string]any{}}, foreign, "active/foreign-member", 403, "permission")
			})
		}
	}
	require.Len(t, seenConfirmationCredentials, 9, "each minted delegated credential owns a distinct confirmation scope")
	// Qualify allowed management writes on real stored subjects for both
	// eligible person roles. Each request binds exactly one decision, and no
	// management write may create a confirmation or outbound GitHub mutation.
	allowed := func(command, method, path, body string, cred credential, status int) {
		t.Helper()
		req := httptest.NewRequest(method, r.origin+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", r.origin)
		req.RemoteAddr = "127.0.0.1:50999"
		req.AddCookie(&http.Cookie{Name: cookieName, Value: cred.cookie})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "campaign"})
		req.Header.Set("X-CSRF-Token", "campaign")
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		var approvalsBefore, approvalsAfter int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&approvalsBefore))
		outboundBefore := githubMutations()
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, decisions)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&approvalsAfter))
		require.Equal(t, approvalsBefore, approvalsAfter)
		require.Equal(t, outboundBefore, githubMutations())
		require.NotContains(t, out.Body.String(), `"value"`)
		receipts = append(receipts, map[string]any{"command": command, "credential": cred.name, "state": "active/full", "method": method, "path": path, "status": status, "effects": 1, "decisions": decisions})
	}
	for _, cred := range []credential{credentials[0], credentials[4]} {
		t.Run("allowed-management/"+cred.name, func(t *testing.T) {
			allowed("secrets.set", "POST", "/api/secrets", `{"name":"EPHEMERAL","value":"never-disclose-campaign-secret"}`, cred, 201)
			var encrypted []byte
			require.NoError(t, pool.QueryRow(ctx, `SELECT value_encrypted FROM repository_secrets WHERE repository_id=$1 AND name='EPHEMERAL'`, repo.ID).Scan(&encrypted))
			require.NotEmpty(t, encrypted)
			require.NotEqual(t, []byte("never-disclose-campaign-secret"), encrypted)
			allowed("secrets.delete", "DELETE", "/api/secrets/EPHEMERAL", "", cred, 204)
			var remaining int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_secrets WHERE repository_id=$1 AND name='EPHEMERAL'`, repo.ID).Scan(&remaining))
			require.Zero(t, remaining)
			for _, change := range []struct{ role, permission string }{{"maintainer", "admin"}, {"member", "write"}} {
				allowed("members.role", "PATCH", "/api/members/alice", fmt.Sprintf(`{"role":%q}`, change.role), cred, 204)
				var permission string
				require.NoError(t, pool.QueryRow(ctx, `SELECT permission FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, alice.ID).Scan(&permission))
				require.Equal(t, change.permission, permission)
			}
		})
	}
	// Owner target and role-to-owner bypass cases are independent literal
	// subject fixtures, including a no-op update on the stored Owner.
	for _, target := range []struct{ login, role string }{{"rehearsal-owner", "maintainer"}, {"rehearsal-owner", "owner"}, {"alice", "owner"}} {
		for _, cred := range credentials {
			code := "permission"
			if cred.user != alice.ID {
				code = "owner_immutable"
				if cred.token != "" {
					code = "never"
				}
			}
			t.Run("owner-subject/"+target.login+"/"+target.role+"/"+cred.name, func(t *testing.T) {
				request(t, retainedHTTPCase{Command: "members.role", Method: "PATCH", Path: "/api/members/" + target.login, Body: map[string]any{"role": target.role}}, cred, "active/owner-target", 403, code)
			})
		}
	}
	for _, cell := range []struct {
		command, method, path, code string
		body                        map[string]any
	}{
		{"install.read", "GET", "/api/install", "permission", map[string]any{}},
		{"secrets.set", "POST", "/api/secrets", "permission", map[string]any{"name": "MEMBER_DENIED", "value": "never-disclose-campaign-secret"}},
		{"secrets.delete", "DELETE", "/api/secrets/CANONICAL_POST", "permission", map[string]any{}},
	} {
		for _, cred := range credentials[8:] {
			if cred.token == "" && cell.code == "never" {
				continue
			}
			t.Run(cell.command+"/active-member/"+cred.name, func(t *testing.T) {
				request(t, retainedHTTPCase{Command: cell.command, Method: cell.method, Path: cell.path, Body: cell.body}, cred, "active/member/full", 403, cell.code)
			})
		}
	}
	httpCommands := 0
	for _, c := range fixture.Commands {
		if c.Method == "" || c.Command == "telemetry.report" || c.Door == "pending:T-CAT-01" {
			continue
		}
		httpCommands++
		t.Run(c.Command+"/unknown", func(t *testing.T) {
			request(t, c, credential{name: "unknown/session", cookie: "unknown-campaign"}, "unknown", 401, "unauthenticated")
		})
		if strings.HasPrefix(c.Path, "/api/repos/") && c.Method != "GET" {
			t.Run(c.Command+"/insufficient-scope", func(t *testing.T) {
				request(t, c, credential{name: "owner/external_agent/read:user", token: limited.Token}, "active", 403, "permission")
			})
		}
		if c.System {
			for _, cred := range credentials {
				status := 403
				if c.Command == "workspace.provider-pool" && c.System && cred.token == "" {
					status = 401
				}
				t.Run(c.Command+"/excluded/"+cred.name, func(t *testing.T) { request(t, c, cred, "active/exact-stored-workspace", status, "permission") })
			}
		}
		if c.Delegated == "never" {
			for _, cred := range credentials {
				if cred.token == "" {
					continue
				}
				t.Run(c.Command+"/"+cred.name, func(t *testing.T) {
					code := "never"
					if cred.user == ben.ID {
						code = c.MaintainerDelegated
					}
					if cred.user == alice.ID {
						code = c.MemberDelegated
					}
					require.Contains(t, []string{"permission", "never"}, code, "literal role oracle required")
					request(t, c, cred, "active", 403, code)
				})
			}
		}
	}
	// Terminal credentials are issued for a real persisted branch session;
	// attribution headers cannot widen the terminal_s1 profile to full scope.
	terminalSession, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: workspace.ID, RepositoryID: repo.ID, UserID: ben.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	terminal, err := issuer.MintForTerminal(ctx, ben.ID, repo.ID, workspace.ID, terminalSession.ID)
	require.NoError(t, err)
	for _, c := range fixture.Commands {
		if c.Delegated != "never" {
			continue
		}
		t.Run(c.Command+"/terminal_s1", func(t *testing.T) {
			request(t, c, credential{name: "ben/external_agent/terminal_s1", token: terminal.Token, user: ben.ID}, "active/terminal_s1", 403, "permission")
		})
	}
	// Both workflow dispatch doors must reject a different retained command,
	// including hidden system commands, before looking up a workflow. This is
	// transport-binding evidence, not an allowed execution of that descriptor.
	// Expected permission/denied is literal, independent of catalog policy.
	dispatchCases := make([]retainedHTTPCase, 0, 2*len(fixture.Commands))
	for _, c := range fixture.Commands {
		if c.Command == "flow.run" {
			continue // This is the door's actual command, covered by flow launch tests.
		}
		for _, path := range []string{
			"/api/repos/{owner}/{repo}/workflows/campaign/dispatch",
			"/api/repos/{owner}/{repo}/workflows/1/dispatches",
		} {
			dispatchCases = append(dispatchCases, retainedHTTPCase{
				Command: c.Command, Method: "POST", Path: path, Door: "workflow-body-mismatch",
				Body: map[string]any{"command": c.Command, "ref": "main", "inputs": map[string]any{}}, Decision: "denied",
			})
		}
	}
	dispatchStart := len(receipts)
	for _, c := range dispatchCases {
		for _, cred := range append(append([]credential{}, credentials...), credential{name: "ben/external_agent/terminal_s1", token: terminal.Token, user: ben.ID}) {
			t.Run(c.Command+"/dispatch-binding/"+c.Path+"/"+cred.name, func(t *testing.T) {
				request(t, c, cred, "active/body-command-mismatch", 403, "permission")
			})
		}
		t.Run(c.Command+"/dispatch-binding/"+c.Path+"/unknown", func(t *testing.T) {
			request(t, c, credential{name: "unknown/session", cookie: "unknown-campaign"}, "unknown/body-command-mismatch", 401, "unauthenticated")
		})
	}
	dispatchActiveCells := len(receipts) - dispatchStart
	for _, state := range []string{"expired", "revoked"} {
		dead, err := issuer.CreateToken(ctx, owner.ID, services.CreateTokenRequest{Name: "campaign-" + state, Via: "codex", Scopes: []string{"repo", "user"}})
		require.NoError(t, err)
		if state == "revoked" {
			require.NoError(t, issuer.DeleteToken(ctx, owner.ID, dead.ID))
		} else {
			_, err = pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, dead.ID)
			require.NoError(t, err)
		}
		for _, c := range dispatchCases {
			t.Run(c.Command+"/dispatch-binding/"+c.Path+"/"+state, func(t *testing.T) {
				request(t, c, credential{name: "owner/external_agent/" + state, token: dead.Token, user: owner.ID}, state+"/body-command-mismatch", 401, "unauthenticated")
			})
		}
		for _, c := range fixture.Commands {
			if c.Method == "" || c.Command == "telemetry.report" || c.Door == "pending:T-CAT-01" {
				continue
			}
			t.Run(c.Command+"/"+state, func(t *testing.T) {
				request(t, c, credential{name: "owner/external_agent/" + state, token: dead.Token, user: owner.ID}, state, 401, "unauthenticated")
			})
		}
	}
	// The credentials were minted while Ben was active. Roster death must take
	// priority immediately, before asynchronous physical revocation or policy.
	for _, state := range []string{"suspended", "removed"} {
		if state == "suspended" {
			_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, ben.ID)
		} else {
			_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`, ben.ID)
			require.NoError(t, err)
			req := httptest.NewRequest("DELETE", r.origin+"/api/members/ben", nil)
			req.Header.Set("Origin", r.origin)
			req.RemoteAddr = "127.0.0.1:50999"
			req.AddCookie(&http.Cookie{Name: cookieName, Value: credentials[0].cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "campaign"})
			req.Header.Set("X-CSRF-Token", "campaign")
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, 204, out.Code, out.Body.String())
		}
		require.NoError(t, err)
		for _, c := range dispatchCases {
			for _, cred := range credentials[4:8] {
				t.Run(c.Command+"/dispatch-binding/"+c.Path+"/"+state+"/"+cred.name, func(t *testing.T) {
					request(t, c, cred, state+"/body-command-mismatch", 401, "unauthenticated")
				})
			}
		}
		for _, c := range fixture.Commands {
			if c.Method == "" || c.Command == "telemetry.report" || c.Door == "pending:T-CAT-01" {
				continue
			}
			for _, cred := range credentials[4:8] {
				t.Run(c.Command+"/"+state+"/"+cred.name, func(t *testing.T) { request(t, c, cred, state, 401, "unauthenticated") })
			}
		}
	}
	// An Owner presses their real pending card, then the composed engine
	// issues the run credential while the packaged model is deliberately held.
	// This qualifies trusted-process issuance, not a real microVM guest.
	var todosBefore, todosAfter int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&todosBefore))
	approvedID := pendingByMember[owner.ID][0]
	approved := call(credentials[0], "POST", "/api/confirmations/"+approvedID+"/approve", `{}`, "campaign-owner-press", "todo.new", 200)
	require.JSONEq(t, fmt.Sprintf(`{"id":%q,"state":"approved"}`, approvedID), approved.Body.String())
	var approvedNumber int64
	var approvedTitle string
	require.NoError(t, pool.QueryRow(ctx, `SELECT number,title FROM mythical_items WHERE checks->>'filedRequest'=$1 AND owner_id=$2 AND created_by=$2`, "confirmation:"+approvedID, owner.ID).Scan(&approvedNumber, &approvedTitle))
	require.Equal(t, "Retained confirmation implicit rehearsal-owner/external_agent/cli", approvedTitle)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&todosAfter))
	require.Equal(t, todosBefore+1, todosAfter)
	receipts = append(receipts, map[string]any{"command": "todo.new", "credential": credentials[0].name, "state": "active/full/own-session-press", "status": 200, "effects": 1, "effect_kind": "person-approved-todo", "decisions": []string{"todo.new"}})
	t.Cleanup(func() { _ = r.release("acc-profile") })
	require.NoError(t, r.waitHeld("acc-profile", 3*time.Minute))
	var executionWorkspace, executionRun string
	require.NoError(t, pool.QueryRow(ctx, `SELECT workspace_id,request_run_id FROM mythical_items WHERE repository_id=$1 AND number=$2`, repo.ID, approvedNumber).Scan(&executionWorkspace, &executionRun))
	issued, exists := r.hostCredentials.Load(executionWorkspace)
	require.True(t, exists, "the real packaged coding host must receive its issued credential")
	issuedToken := issued.(string)
	digest := sha256.Sum256([]byte(issuedToken))
	var issuedSponsor int64
	var issuedScopes string
	var issuedSystem bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT user_id,scopes,system_issued FROM access_tokens WHERE token_hash=$1`, hex.EncodeToString(digest[:])).Scan(&issuedSponsor, &issuedScopes, &issuedSystem))
	require.Equal(t, owner.ID, issuedSponsor)
	require.True(t, issuedSystem)
	require.Equal(t, middleware.CredentialAgentRun, middleware.TokenCredentialKind(issuedSystem, issuedScopes, "user", true))
	require.Equal(t, executionRun, middleware.ParseTokenAgentSessionRestriction(issuedScopes))
	runCredential := credential{name: "owner/run/trusted-process", token: issuedToken, user: owner.ID}
	beforeRunRead, outboundBeforeRunRead := snapshot(), githubMutations()
	runRead := call(runCredential, "GET", fmt.Sprintf("/api/todos/%d", approvedNumber), "", "", "todo.read", 200)
	var execution map[string]any
	require.NoError(t, json.Unmarshal(runRead.Body.Bytes(), &execution))
	require.Equal(t, float64(approvedNumber), execution["n"])
	for _, key := range []string{"owner", "present", "waits", "steers", "preapproval", "view_state", "confirmations", "revisions"} {
		require.NotContains(t, execution, key)
	}
	require.Equal(t, beforeRunRead, snapshot())
	require.Equal(t, outboundBeforeRunRead, githubMutations())
	receipts = append(receipts, map[string]any{"command": "todo.read", "credential": runCredential.name, "state": "active/exact-run-workspace", "status": 200, "effects": 0, "decisions": []string{"todo.read"}, "boundary": "real composed engine issuer, trusted-process coding host"})
	for _, denied := range []struct{ command, path string }{
		{"todo.read", fmt.Sprintf("/api/todos/%d", readNumber)},
		{"todo.read", "/api/todos"}, {"agents.read", "/api/agents"},
		{"members.list", "/api/members"}, {"secrets.read", "/api/secrets"},
		{"confirmations.read", "/api/confirmations"},
	} {
		request(t, retainedHTTPCase{Command: denied.command, Method: "GET", Path: denied.path, Body: map[string]any{}}, runCredential, "active/foreign-or-person-subject", 403, "permission")
	}
	require.Equal(t, 137, httpCommands)
	require.Equal(t, 2081+44+132+111+8+24*len(dispatchCases), len(receipts), "HTTP policy and separate dispatch-binding cells must pass")
	require.Equal(t, 14*len(dispatchCases), dispatchActiveCells)
	if dir := os.Getenv("SMITHERS_ACCESS_LEDGER_DIR"); dir != "" {
		data, err := json.MarshalIndent(map[string]any{"boundary": "production composed install HTTP role/profile/state campaign", "admitted_writes": 11, "admitted_reads": 193, "admitted_confirmations": 18, "confirmation_replays": 18, "confirmation_refusal_cells": 21, "trusted_process_run_refusal_cells": 6, "real_guest_run_qualified": false, "http_policy_refusal_cells": 2109, "dispatch_binding_refusal_cells": 24 * len(dispatchCases), "http_commands": httpCommands, "pending_http_commands": []string{"issue.new (T-CAT-01)"}, "public_http_commands": []string{"telemetry.report"}, "app_commands_without_http_door": 194, "dispatch_binding_commands": len(fixture.Commands) - 1, "dispatch_binding_cells": 24 * len(dispatchCases), "cells": receipts, "full_live_effect_matrix_complete": false}, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(dir, 0700))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "retained-http-effects.json"), append(data, '\n'), 0600))
	}
	t.Logf("HTTP campaign: %d commands, %d refusal cells, 11 admitted writes, 193 asserted reads and 18 private pending confirmations; full admitted-effect matrix remains separate", httpCommands, len(receipts)-240)
}

// Catalog data is used only to measure coverage; it never supplies outcomes.
// A new descriptor requires an explicit frozen campaign entry.
func TestRetainedCommandHTTPOracleCoverage(t *testing.T) {
	var fixture struct{ Commands []retainedHTTPCase }
	data, err := os.ReadFile("testdata/access/retained-http.json")
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &fixture))
	var catalog struct {
		Operations []struct {
			Name string
			HTTP *struct{ Method, Path string }
		}
	}
	data, err = os.ReadFile("../../../../catalog.mvp.json")
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &catalog))
	cases := map[string]retainedHTTPCase{}
	for _, c := range fixture.Commands {
		require.NotContains(t, cases, c.Command)
		cases[c.Command] = c
	}
	require.Len(t, cases, len(catalog.Operations))
	for _, operation := range catalog.Operations {
		c, ok := cases[operation.Name]
		require.True(t, ok, "missing literal case for %s", operation.Name)
		if operation.HTTP != nil {
			require.Equal(t, operation.HTTP.Method, c.Method, operation.Name)
			require.Equal(t, operation.HTTP.Path, c.Path, operation.Name)
		} else {
			require.Equal(t, "app", c.Door, operation.Name)
		}
	}
}
