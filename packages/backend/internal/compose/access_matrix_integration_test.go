package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/stretchr/testify/require"
)

// C-ACC-02's persisted TODO path crosses the composed install router, stored
// credentials, real confirmation transactions and the real TODO consumer.
// No GitHub transport or machine is needed before the durable TODO is filed.
func TestAccessMatrixConfirmationDispatchComposedInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	users := make([]db.User, 3)
	for i, name := range []string{"maya", "ben", "alice"} {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, err)
		users[i] = u
	}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, users[0].ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: users[0].ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID)
	for key, value := range map[string]string{"github.repository": binding, "owner.access": binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-06T12:00:00Z"}`} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, users[0].ID)
	require.NoError(t, err)
	issuerConfig := testConfigAllFlagsOn()
	issuerConfig.Auth.Mode = "selfhost"
	issuer := services.NewAuthService(q, issuerConfig.Auth, nil, nil)
	issuer.Members = &services.Members{Pool: pool}
	sessions, tokens, hashes := make([]string, 3), make([]string, 3), make([]string, 3)
	for i, u := range users {
		role := "admin"
		if i == 2 {
			role = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, role)
		require.NoError(t, err)
		sessions[i] = u.Username + "-matrix-session"
		sum := sha256.Sum256([]byte(sessions[i]))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		credential, err := issuer.CreateToken(ctx, u.ID, services.CreateTokenRequest{Name: "matrix-codex", Via: "codex", Scopes: []string{"repo", "user"}})
		require.NoError(t, err)
		tokens[i] = credential.Token
		sum = sha256.Sum256([]byte(tokens[i]))
		hashes[i] = hex.EncodeToString(sum[:])
	}
	todos := services.NewMythicalService(pool, nil)
	confirmations := services.NewApprovalsService(q, services.WithConfirmationTodos(pool, todos))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Confirmations: confirmations})
	call := func(i int, person bool, path, key, body string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest("POST", "http://example.com"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://example.com")
		req.Header.Set("Idempotency-Key", key)
		req.AddCookie(&http.Cookie{Name: "session", Value: sessions[i]})
		req.Header.Set("Smithers-Via", "smithers")
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Profile", "app_agent")
		if strings.HasPrefix(path, "/api/branches/") {
			// Attribution cannot select a trusted actor or widen its profile.
			req.Header.Set("Smithers-Via", "smithers")
			req.Header.Set("Smithers-Actor", "person")
			req.Header.Set("Smithers-Profile", "full")
		}
		if person {
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "matrix-csrf"})
			req.Header.Set("X-CSRF-Token", "matrix-csrf")
		} else {
			req.Header.Set("Authorization", "Bearer "+tokens[i])
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) {
			decisions = append(decisions, command)
		}))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code == http.StatusAccepted || w.Code == http.StatusCreated {
			require.Len(t, decisions, 1, "one decision before confirmation/effect: %v", decisions)
		}
		var result map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result), w.Body.String())
		return w.Code, result
	}
	t.Run("literal read and retired cells", func(t *testing.T) {
		// SG-06 and SG-09 literals: expectations are not generated from the
		// catalog or route table. Read handlers use real PostgreSQL services.
		members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
		secrets := &routes.SecretHandler{Service: services.NewSecretService(q, nil, services.WithSecretInstallAuthorization(true, pool))}
		boundary := buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, secrets, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Members: &routes.MembersHandler{Service: members}, GitHubAppSetup: &routes.GitHubAppSetupHandler{Owners: q, Roster: q, Setup: &services.InstallSetupService{Pool: pool}}})
		mountModelPublic(boundary.(chi.Router), modelhost.OwnerModels{Pool: pool}, q, cfg)
		_, err := q.CreateOrUpdateSecret(ctx, db.CreateOrUpdateSecretParams{RepositoryID: repo.ID, Name: "MATRIX_NAME", ValueEncrypted: []byte("never-return-this-value")})
		require.NoError(t, err)
		defer func() {
			require.NoError(t, q.DeleteSecret(ctx, db.DeleteSecretParams{RepositoryID: repo.ID, Name: "MATRIX_NAME"}))
		}()
		credentials := map[string]string{"DO": tokens[0], "DM": tokens[1], "DE": tokens[2]}
		for i, fixture := range []struct{ key, scopes string }{
			{"RO", fmt.Sprintf("read:repository,repo:%d,path:**", repo.ID)},
			{"RX", fmt.Sprintf("read:repository,repo:%d,path:**", repo.ID+1000)},
			{"MO", "read:repository,workspace:11111111-1111-4111-8111-111111111111"},
			{"MX", "read:repository,workspace:22222222-2222-4222-8222-222222222222"},
		} {
			raw := fmt.Sprintf("smithers_%040x", 8200+i)
			sum := sha256.Sum256([]byte(raw))
			hash := hex.EncodeToString(sum[:])
			_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: users[0].ID, Name: fixture.key, TokenHash: hash, TokenLastEight: hash[56:], Scopes: fixture.scopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
			require.NoError(t, err)
			credentials[fixture.key] = raw
		}
		for _, cell := range []struct {
			name, credential, path string
			status                 int
			code                   string
		}{
			{"install DO", "DO", "/api/install", 403, "never"},
			{"install DM", "DM", "/api/install", 403, "permission"},
			{"install DE", "DE", "/api/install", 403, "permission"},
			{"members SE", "SE", "/api/members", 200, ""},
			{"members DO", "DO", "/api/members", 403, "never"},
			{"members DM", "DM", "/api/members", 403, "never"},
			{"members DE", "DE", "/api/members", 403, "never"},
			{"members RO", "RO", "/api/members", 403, "permission"},
			{"members RX", "RX", "/api/members", 403, "permission"},
			{"secrets SE", "SE", "/api/secrets", 200, ""},
			{"secrets DO", "DO", "/api/secrets", 403, "never"},
			{"secrets DM", "DM", "/api/secrets", 403, "never"},
			{"secrets DE", "DE", "/api/secrets", 403, "never"},
			{"secrets RO", "RO", "/api/secrets", 403, "permission"},
			{"secrets RX", "RX", "/api/secrets", 403, "permission"},
			{"members MO", "MO", "/api/members", 403, "permission"},
			{"members MX", "MX", "/api/members", 403, "permission"},
			{"secrets MO", "MO", "/api/secrets", 403, "permission"},
			{"secrets MX", "MX", "/api/secrets", 403, "permission"},
			{"ssh DO", "DO", "/api/repos/maya/demo/workspaces/box/ssh", 403, "never"},
			{"ssh DM", "DM", "/api/repos/maya/demo/workspaces/box/ssh", 403, "never"},
			{"ssh DE", "DE", "/api/repos/maya/demo/workspaces/box/ssh", 403, "never"},
			{"ssh RO", "RO", "/api/repos/maya/demo/workspaces/box/ssh", 403, "permission"},
			{"session ssh DO", "DO", "/api/repos/maya/demo/workspace/sessions/terminal/ssh", 403, "never"},
			{"session ssh DM", "DM", "/api/repos/maya/demo/workspace/sessions/terminal/ssh", 403, "never"},
			{"session ssh DE", "DE", "/api/repos/maya/demo/workspace/sessions/terminal/ssh", 403, "never"},
			{"agents RO", "RO", "/api/agents", 403, "permission"},
			{"agents RX", "RX", "/api/agents", 403, "permission"},
			{"agents MO", "MO", "/api/agents", 403, "permission"},
			{"agents MX", "MX", "/api/agents", 403, "permission"},
			{"retired SO", "SO", "/api/repos/maya/demo/repository-jobs", 404, "not_found"},
			{"retired SM", "SM", "/api/repos/maya/demo/repository-jobs", 404, "not_found"},
			{"retired SE", "SE", "/api/repos/maya/demo/repository-jobs", 404, "not_found"},
			{"retired DO", "DO", "/api/repos/maya/demo/repository-jobs", 404, "not_found"},
			{"retired DM", "DM", "/api/repos/maya/demo/repository-jobs", 404, "not_found"},
			{"retired DE", "DE", "/api/repos/maya/demo/repository-jobs", 404, "not_found"},
		} {
			t.Run(cell.name, func(t *testing.T) {
				for _, forged := range []bool{false, true} {
					req := httptest.NewRequest("GET", "http://example.com"+cell.path, nil)
					if token := credentials[cell.credential]; token != "" {
						req.Header.Set("Authorization", "Bearer "+token)
					} else {
						index := map[string]int{"SO": 0, "SM": 1, "SE": 2}[cell.credential]
						req.AddCookie(&http.Cookie{Name: "session", Value: sessions[index]})
					}
					if forged {
						req.Header.Set("Smithers-Via", "smithers")
						req.Header.Set("Smithers-Actor", "person")
						req.Header.Set("Smithers-Profile", "full")
					}
					out := httptest.NewRecorder()
					boundary.ServeHTTP(out, req)
					require.Equal(t, cell.status, out.Code, out.Body.String())
					require.NotContains(t, out.Body.String(), "never-return-this-value")
					if cell.code != "" {
						var refusal map[string]any
						require.NoError(t, json.Unmarshal(out.Body.Bytes(), &refusal))
						require.Equal(t, cell.code, refusal["code"], out.Body.String())
						if cell.status == 403 {
							require.Equal(t, cell.code, refusal["class"], out.Body.String())
						}
					} else if cell.path == "/api/secrets" {
						require.Contains(t, out.Body.String(), "MATRIX_NAME")
					}
				}
			})
		}
		t.Run("setup DO SG-01", func(t *testing.T) {
			req := httptest.NewRequest("POST", "http://example.com/api/install/setup/models", strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+credentials["DO"])
			out := httptest.NewRecorder()
			boundary.ServeHTTP(out, req)
			require.Equal(t, 403, out.Code, out.Body.String())
			require.JSONEq(t, `{"code":"never","class":"never","message":"Only a person can do this"}`, out.Body.String())
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key LIKE 'setup.step.%'`).Scan(&count))
			require.Zero(t, count)
		})
		// SG-08: explicit creation is delegated-only; system credentials
		// cannot enumerate private confirmations either. These refusals never
		// insert a pending row, even with an otherwise eligible target.
		for _, cell := range []struct{ method, credential string }{
			{"POST", "SO"}, {"POST", "SM"}, {"POST", "SE"},
			{"POST", "RO"}, {"POST", "RX"}, {"POST", "MO"}, {"POST", "MX"},
			{"GET", "RO"}, {"GET", "RX"}, {"GET", "MO"}, {"GET", "MX"},
		} {
			t.Run("confirmation "+cell.method+" "+cell.credential, func(t *testing.T) {
				req := httptest.NewRequest(cell.method, "http://example.com/api/confirmations", strings.NewReader(`{"command":"todo.new","payload":{"title":"Must not file","prompt":"Must not file"}}`))
				req.Header.Set("Origin", "http://example.com")
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Idempotency-Key", "literal-"+cell.credential)
				if token := credentials[cell.credential]; token != "" {
					req.Header.Set("Authorization", "Bearer "+token)
				} else {
					index := map[string]int{"SO": 0, "SM": 1, "SE": 2}[cell.credential]
					req.AddCookie(&http.Cookie{Name: "session", Value: sessions[index]})
					req.AddCookie(&http.Cookie{Name: "__csrf", Value: "matrix-csrf"})
					req.Header.Set("X-CSRF-Token", "matrix-csrf")
				}
				out := httptest.NewRecorder()
				boundary.ServeHTTP(out, req)
				require.Equal(t, 403, out.Code, out.Body.String())
				var refusal map[string]any
				require.NoError(t, json.Unmarshal(out.Body.Bytes(), &refusal))
				require.Equal(t, "permission", refusal["code"], out.Body.String())
				require.Equal(t, "permission", refusal["class"], out.Body.String())
				var count int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&count))
				require.Zero(t, count)
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
				require.Zero(t, count)
			})
		}
	})
	t.Run("relay concrete authorization", func(t *testing.T) {
		// Authorization, membership, repository and workspace lookup are real.
		// The external coding host is recorded so refusals prove zero relay IO.
		dispatcher := &browserFlowRecordingDispatcher{}
		browser := &browserFlowAPI{installTransactions: pool, repos: services.NewRepoService(q, nil, ""), queries: q, dispatcher: dispatcher}
		relay := chi.NewRouter()
		mountBrowserFlow(relay, cfg, q, browser)
		original := router
		router = relay
		defer func() { router = original }()
		workspace := uuid.NewString()
		_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status) VALUES($1,$2,$3,'matrix-relay','matrix-relay','running')`, workspace, repo.ID, users[2].ID)
		require.NoError(t, err)
		cases := []struct {
			name, procedure, payload string
			person                   bool
			status                   int
			code                     string
		}{
			{"person approves", "Approval.Submit", `{"target":{"_tag":"Run","runId":"r","requestId":"a"},"decision":"approve"}`, true, 200, ""},
			{"agent cannot approve", "Approval.Submit", `{"target":{"_tag":"Run","runId":"r","requestId":"a"},"decision":"approve"}`, false, 403, "never"},
			{"agent cannot deny", "Approval.Submit", `{"target":{"_tag":"Run","runId":"r","requestId":"a"},"decision":"deny"}`, false, 403, "never"},
			{"invalid decision", "Approval.Submit", `{"decision":"unknown"}`, true, 400, "invalid_workflow"},
			{"external actor excluded from stop", "Cancel", `{"runId":"r"}`, false, 403, "permission"},
			{"person stops", "Cancel", `{"runId":"r"}`, true, 200, ""},
			{"agent plans", "Plan", `{"flowId":"greeting","input":{}}`, false, 200, ""},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				before := len(dispatcher.calls)
				body := fmt.Sprintf(`{"repo":"maya/demo","workspaceId":%q,"procedure":%q,"payload":%s}`, workspace, tc.procedure, tc.payload)
				status, result := call(2, tc.person, "/api/workflow/rpc", "", body)
				require.Equal(t, tc.status, status, result)
				if tc.code != "" {
					require.Equal(t, tc.code, result["code"], result)
					require.Len(t, dispatcher.calls, before)
				} else {
					require.Len(t, dispatcher.calls, before+1)
				}
			})
		}
	})
	count := func(table string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
		return n
	}
	// Catalog names measure coverage only. Every expected result below is a
	// literal invariant of the real confirmation HTTP door, independent of
	// descriptor roles, scopes, actors and delegation policy. This sweep is
	// not evidence that each command's execution consumer is composed.
	t.Run("all-command confirmation admission ledger", func(t *testing.T) {
		catalog, err := os.ReadFile("../../../smithers/src/internal/backend/catalog.mvp.json")
		require.NoError(t, err)
		var inventory struct {
			Operations []struct {
				Name string `json:"name"`
				HTTP *struct {
					Method string `json:"method"`
					Path   string `json:"path"`
				} `json:"http"`
			} `json:"operations"`
		}
		require.NoError(t, json.Unmarshal(catalog, &inventory))
		require.NotEmpty(t, inventory.Operations)
		type cell struct {
			Command        string `json:"command"`
			Role           string `json:"role"`
			Credential     string `json:"credential"`
			CredentialHash string `json:"credential_hash"`
			ExpectedStatus int    `json:"expected_status"`
			ExpectedCode   string `json:"expected_code"`
			Status         int    `json:"status"`
			Class          string `json:"class"`
			Code           string `json:"code"`
		}
		var ledger []cell
		original := append([]string(nil), tokens...)
		defer copy(tokens, original)
		credentials := map[string][]string{}
		for _, state := range []string{"expired-delegated", "revoked-delegated", "read-only-delegated"} {
			credentials[state] = make([]string, len(users))
		}
		for i, u := range users {
			credential, err := issuer.CreateToken(ctx, u.ID, services.CreateTokenRequest{Name: "expired-matrix", Scopes: []string{"repo", "user"}})
			require.NoError(t, err)
			sum := sha256.Sum256([]byte(credential.Token))
			_, err = pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hex.EncodeToString(sum[:]))
			require.NoError(t, err)
			credentials["expired-delegated"][i] = credential.Token
			revoked, err := issuer.CreateToken(ctx, u.ID, services.CreateTokenRequest{Name: "revoked-matrix", Scopes: []string{"repo", "user"}})
			require.NoError(t, err)
			require.NoError(t, issuer.DeleteToken(ctx, u.ID, revoked.ID))
			credentials["revoked-delegated"][i] = revoked.Token
			limited, err := issuer.CreateToken(ctx, u.ID, services.CreateTokenRequest{Name: "read-only-matrix", Scopes: []string{"read:user"}})
			require.NoError(t, err)
			credentials["read-only-delegated"][i] = limited.Token
		}
		roles := []string{"owner", "maintainer", "member"}
		for _, operation := range inventory.Operations {
			for i := range users {
				for _, state := range []string{"session", "expired-delegated", "revoked-delegated", "read-only-delegated"} {
					if state != "session" {
						tokens[i] = credentials[state][i]
					}
					person := state == "session"
					status, body := call(i, person, "/api/confirmations", "ledger-"+operation.Name+"-"+state, fmt.Sprintf(`{"command":%q,"payload":{}}`, operation.Name))
					wantStatus, wantCode := 401, "unauthenticated"
					if person || state == "read-only-delegated" {
						wantStatus, wantCode = 403, "permission"
					}
					require.Equal(t, wantStatus, status, "%s %s %s: %v", operation.Name, roles[i], state, body)
					require.Equal(t, "permission", body["class"], body)
					require.Equal(t, wantCode, body["code"], body)
					require.NotContains(t, body, "confirmation")
					identity := tokens[i]
					if person {
						identity = sessions[i]
					}
					digest := sha256.Sum256([]byte(identity))
					ledger = append(ledger, cell{operation.Name, roles[i], state, hex.EncodeToString(digest[:]), wantStatus, wantCode, status, body["class"].(string), body["code"].(string)})
				}
			}
		}
		t.Run("full install HTTP execution doors", func(t *testing.T) {
			if os.Getenv("SMITHERS_FFI_LIBRARY_PATH") == "" {
				t.Skip("set SMITHERS_FFI_LIBRARY_PATH for the complete install HTTP-door ledger")
			}
			// Exercise credential death at every declared HTTP execution door too.
			// A valid browser cookie and forged actor assertions accompany each dead
			// bearer. Authentication must refuse before parsing command payloads,
			// looking up subjects, or disclosing even a saved result. This is separate
			// from live-role execution and does not qualify unmounted consumers.
			type executionCell struct {
				cell
				Method        string `json:"method"`
				Path          string `json:"path"`
				PendingTicket string `json:"pending_ticket,omitempty"`
			}
			var executionAdmission []executionCell
			var pendingDoors []executionCell
			t.Setenv("SMITHERS_PUBLIC_URL", cfg.Server.PublicURL)
			t.Setenv("SMITHERS_SERVER_ALLOWED_ORIGINS", cfg.Server.PublicURL)
			t.Setenv("SMITHERS_AUTH_SESSION_COOKIE_NAME", "session")
			// Use the complete install, including the model and chat mounts that
			// live outside buildRouter. Stop it with this subtest before TODO effects.
			executionBoundary := startSplitProcess(t, Options{ChatHost: unusedChatHost{}})
			replaceSubject := strings.NewReplacer("{name}", "sample", "{id}", "1", "{branch}", "sample", "{b}", "sample", "{number}", "1", "{n}", "1", "{owner}", "maya", "{repo}", "demo")
			for _, operation := range inventory.Operations {
				if operation.HTTP == nil {
					continue
				}
				for i := range users {
					for _, state := range []string{"expired-delegated", "revoked-delegated"} {
						identity := credentials[state][i]
						req := httptest.NewRequest(operation.HTTP.Method, "http://example.com"+replaceSubject.Replace(operation.HTTP.Path), strings.NewReader(`{}`))
						req.Header.Set("Authorization", "Bearer "+identity)
						req.Header.Set("Content-Type", "application/json")
						req.Header.Set("Origin", "http://example.com")
						req.Header.Set("Idempotency-Key", "dead-door-"+operation.Name+"-"+state)
						req.Header.Set("Smithers-Via", "smithers")
						req.Header.Set("Smithers-Actor", "person")
						req.Header.Set("Smithers-Profile", "app_agent")
						req.AddCookie(&http.Cookie{Name: "session", Value: sessions[i]})
						w := httptest.NewRecorder()
						executionBoundary.ServeHTTP(w, req)
						var body map[string]any
						require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body), w.Body.String())
						// Branch mutations authenticate on their shared mounted POST door.
						if pendingTicket := map[string]string{
							"issue.comment": "T-GH-04", "monitor": "T-FLW-07", "run": "T-FLW-07", "run.inspect": "T-FLW-07", "runs": "T-FLW-07",
						}[operation.Name]; pendingTicket != "" && w.Code == http.StatusNotFound {
							// Unserved catalogue doors remain owned by their tickets.
							// Never count a missing-route response as an auth pass.
							require.Equal(t, 404, w.Code, "%s %s %s: %v", operation.Name, roles[i], state, body)
							require.Equal(t, "not_found", body["code"], body)
							digest := sha256.Sum256([]byte(identity))
							pendingDoors = append(pendingDoors, executionCell{cell{operation.Name, roles[i], state, hex.EncodeToString(digest[:]), 404, "not_found", w.Code, "user", "not_found"}, operation.HTTP.Method, req.URL.EscapedPath(), pendingTicket})
							continue
						}
						require.Equal(t, 401, w.Code, "%s %s %s: %v", operation.Name, roles[i], state, body)
						require.Equal(t, "permission", body["class"], body)
						require.Equal(t, "unauthenticated", body["code"], body)
						require.NotContains(t, body, "confirmation")
						digest := sha256.Sum256([]byte(identity))
						executionAdmission = append(executionAdmission, executionCell{cell{operation.Name, roles[i], state, hex.EncodeToString(digest[:]), 401, "unauthenticated", w.Code, "permission", "unauthenticated"}, operation.HTTP.Method, req.URL.EscapedPath(), ""})
					}
				}
			}
			require.NotEmpty(t, executionAdmission)
			t.Logf("declared HTTP execution-door credential death: %d passing cells, %d pending-route cells (not live command execution)", len(executionAdmission), len(pendingDoors))
			if output := os.Getenv("SMITHERS_ACCESS_LEDGER_DIR"); output != "" {
				require.NoError(t, os.MkdirAll(output, 0755))
				data, err := json.MarshalIndent(struct {
					Boundary string          `json:"boundary"`
					Cells    []executionCell `json:"cells"`
					Pending  []executionCell `json:"pending_routes"`
				}{"declared HTTP execution doors (dead-credential admission only)", executionAdmission, pendingDoors}, "", "  ")
				require.NoError(t, err)
				require.NoError(t, os.WriteFile(filepath.Join(output, "execution-door-dead-admission-matrix.json"), append(data, '\n'), 0644))
			}
		})
		require.Zero(t, count("approvals"))
		require.Zero(t, count("mythical_items"))
		t.Logf("confirmation admission: %d commands, %d passing cells; command execution coverage remains separate", len(inventory.Operations), len(ledger))
		if output := os.Getenv("SMITHERS_ACCESS_LEDGER_DIR"); output != "" {
			require.NoError(t, os.MkdirAll(output, 0755))
			data, err := json.MarshalIndent(struct {
				Boundary string `json:"boundary"`
				Cells    []cell `json:"cells"`
			}{"POST /api/confirmations (admission only)", ledger}, "", "  ")
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(output, "confirmation-admission-matrix.json"), append(data, '\n'), 0644))
		}
	})
	for i := range users {
		key := "new-" + users[i].Username
		payload := `{"title":"Keep greeting","prompt":"Keep greeting","acceptance":[]}`
		// SG-08 DO/DM/DE: explicit create and the direct TODO door share
		// one credential-scoped operation, confirmation and eventual effect.
		status, result := call(i, false, "/api/confirmations", key, `{"command":"todo.new","payload":`+payload+`}`)
		require.Equal(t, 202, status, result)
		require.Equal(t, "pending", result["state"])
		id := result["confirmation"].(string)
		require.Equal(t, i, count("mythical_items"), "delegated requests must not create TODOs")
		status, repeated := call(i, false, "/api/todos", key, payload)
		require.Equal(t, 202, status, repeated)
		require.Equal(t, result, repeated)
		status, changed := call(i, false, "/api/todos", key, `{"title":"Other","prompt":"Other"}`)
		require.Equal(t, 409, status, changed)
		require.Equal(t, "idempotency_mismatch", changed["code"])
		status, refused := call(i, false, "/api/confirmations/"+id+"/approve", "press", "{}")
		require.Equal(t, 403, status, refused)
		status, approved := call(i, true, "/api/confirmations/"+id+"/approve", "press", "{}")
		require.Equal(t, 200, status, approved)
		require.Equal(t, "approved", approved["state"])
		status, approved = call(i, true, "/api/confirmations/"+id+"/approve", "press", "{}")
		require.Equal(t, 200, status, approved)
		require.Equal(t, i+1, count("mythical_items"))
		status, repeated = call(i, false, "/api/todos", key, payload)
		require.Equal(t, 202, status, repeated)
		require.Equal(t, "approved", repeated["state"])
		// A catalog-authorized full delegated member lifts a typed stop;
		// no later person-only helper may replace the bound retry decision.
		var n int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT max(number) FROM mythical_items`).Scan(&n))
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='blocked', checks=jsonb_set(checks,'{fault}','{"class":"factory","tag":"defect"}'::jsonb) WHERE number=$1`, n)
		require.NoError(t, err)
		path := fmt.Sprintf("/api/todos/%d", n)
		status, retry := call(i, false, path, "retry-"+users[i].Username, `{"op":"retry","steer":"Use the shared helper"}`)
		require.Equal(t, 202, status, retry)
		require.Equal(t, "accepted", retry["state"])
		status, again := call(i, false, path, "retry-"+users[i].Username, `{"op":"retry","steer":"Use the shared helper"}`)
		require.Equal(t, 202, status, again)
		require.Equal(t, retry, again)
		var state string
		require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE number=$1`, n).Scan(&state))
		require.Equal(t, "queued", state)

	}
	// The body-bound Make TODO command has its own catalog id. Its missing
	// snapshot must not silently file an ordinary TODO or request approval.
	// This fixture deliberately has no GitHub reader, so admission fails closed.
	statusIssue, issueRefusal := call(2, false, "/api/todos", "from-issue", `{"title":"From issue","prompt":"Resolve issue","issue":23,"issue_digest":"`+strings.Repeat("a", 64)+`"}`)
	require.Equal(t, 503, statusIssue, issueRefusal)
	require.Equal(t, "confirmation_unavailable", issueRefusal["code"])
	require.Equal(t, 3, count("approvals"))
	for _, tc := range []struct {
		command  string
		statuses [3]int
		codes    [3]string
	}{
		{"members.write", [3]int{403, 403, 403}, [3]string{"never", "never", "permission"}},
		{"secrets.write", [3]int{403, 403, 403}, [3]string{"never", "never", "permission"}},
		{"settings", [3]int{403, 403, 403}, [3]string{"never", "permission", "permission"}},
		{"merge", [3]int{503, 503, 403}, [3]string{"confirmation_unavailable", "confirmation_unavailable", "permission"}},
		{"branch.bring-in", [3]int{403, 403, 403}, [3]string{"permission", "permission", "permission"}},
	} {
		for i := range users {
			status, result := call(i, false, "/api/confirmations", "refuse-"+tc.command, fmt.Sprintf(`{"command":%q}`, tc.command))
			require.Equal(t, tc.statuses[i], status, result)
			require.Equal(t, tc.codes[i], result["code"])
		}
	}
	// Issue filing consumes the same person-bound immutable read receipt as
	// direct Make TODO. This adapter performs no network IO for that receipt.
	todos.SetOrchestration(services.NewMythicalGitHub(q, nil, nil, nil), nil, nil)
	for i := range users {
		for _, number := range []int64{23, 24} {
			thread := services.InstallIssueThread{Issue: services.InstallIssue{Number: number, Title: "Keep issue context", Body: "Exact issue body", State: "open", HTMLURL: "https://github.com/maya/demo/issues/23"}}
			read, err := json.Marshal(map[string]any{"issue": number, "digest": strings.Repeat("a", 64), "thread": thread, "outsider": number == 23})
			require.NoError(t, err)
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: fmt.Sprintf("issue-read:%d", users[i].ID)}, uuid.NewString(), "issue.read", "completed", read)
			require.NoError(t, err)
			require.NoError(t, tx.Commit(ctx))
		}
	}
	payloadIssue := func(number int) string {
		return fmt.Sprintf(`{"title":"From issue","prompt":"Resolve issue","issue":%d,"issue_digest":"%s"}`, number, strings.Repeat("a", 64))
	}
	status, mismatched := call(1, false, "/api/confirmations", "issue-mismatch", fmt.Sprintf(`{"command":"todo.new","payload":%s}`, payloadIssue(23)))
	require.Equal(t, 400, status, mismatched)
	require.Equal(t, "invalid_confirmation", mismatched["code"])
	status, mismatched = call(1, false, "/api/confirmations", "missing-issue", `{"command":"todo.from-issue","payload":{"title":"No issue","prompt":"No issue"}}`)
	require.Equal(t, 400, status, mismatched)
	require.Equal(t, "invalid_confirmation", mismatched["code"])
	require.Equal(t, 3, count("approvals"))
	status, deniedIssue := call(2, false, "/api/todos", "outsider-alice", payloadIssue(23))
	require.Equal(t, 403, status, deniedIssue)
	require.Equal(t, "permission", deniedIssue["code"])
	require.Equal(t, 3, count("approvals"))
	status, unknownIssue := call(1, false, "/api/todos", "unknown-issue", payloadIssue(25))
	require.Equal(t, 409, status, unknownIssue)
	require.Equal(t, "issue_snapshot_unknown", unknownIssue["code"])
	for _, tc := range []struct {
		member, number int
		key            string
	}{{1, 23, "outsider-ben"}, {2, 24, "team-alice"}} {
		before := count("mythical_items")
		status, requested := call(tc.member, false, "/api/todos", tc.key, payloadIssue(tc.number))
		require.Equal(t, 202, status, requested)
		require.Equal(t, "pending", requested["state"])
		require.Equal(t, before, count("mythical_items"))
		id := requested["confirmation"].(string)
		status, replay := call(tc.member, false, "/api/todos", tc.key, payloadIssue(tc.number))
		require.Equal(t, 202, status, replay)
		require.Equal(t, requested, replay)
		status, changed := call(tc.member, false, "/api/todos", tc.key, strings.Replace(payloadIssue(tc.number), "Resolve issue", "Other prompt", 1))
		require.Equal(t, 409, status, changed)
		require.Equal(t, "idempotency_mismatch", changed["code"])
		status, wrong := call(0, true, "/api/confirmations/"+id+"/approve", tc.key, "{}")
		require.Equal(t, 403, status, wrong)
		if tc.number == 23 {
			_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE user_id=$1`, users[tc.member].ID)
			require.NoError(t, err)
			status, refused := call(tc.member, true, "/api/confirmations/"+id+"/approve", tc.key, "{}")
			require.Equal(t, 403, status, refused)
			require.Equal(t, before, count("mythical_items"))
			_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='admin' WHERE user_id=$1`, users[tc.member].ID)
			require.NoError(t, err)
		}
		status, approved := call(tc.member, true, "/api/confirmations/"+id+"/approve", tc.key, "{}")
		require.Equal(t, 200, status, approved)
		require.Equal(t, "approved", approved["state"])
		status, approved = call(tc.member, true, "/api/confirmations/"+id+"/approve", tc.key, "{}")
		require.Equal(t, 200, status, approved)
		require.Equal(t, before+1, count("mythical_items"))
		var source, digest, revisions string
		require.NoError(t, pool.QueryRow(ctx, `SELECT source,issue_digest,revisions::text FROM mythical_items WHERE issue_number=$1`, tc.number).Scan(&source, &digest, &revisions))
		require.Equal(t, "issue", source)
		require.Equal(t, strings.Repeat("a", 64), digest)
		require.Contains(t, revisions, `"reason": "from-issue"`)
		if tc.number == 23 {
			_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE user_id=$1`, users[tc.member].ID)
			require.NoError(t, err)
			status, refused := call(tc.member, false, "/api/todos", tc.key, payloadIssue(tc.number))
			require.Equal(t, 403, status, refused)
			require.Equal(t, "permission", refused["code"])
			require.NotContains(t, refused, "confirmation")
			_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='admin' WHERE user_id=$1`, users[tc.member].ID)
			require.NoError(t, err)
		}
	}
	// Revoke the exact credential after router admission, while its replay
	// waits on the stack lock. The bound decision cannot disclose its receipt.
	locked, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer locked.Rollback(ctx)
	_, err = locked.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repo.ID)
	require.NoError(t, err)
	type reply struct {
		status int
		body   map[string]any
	}
	done := make(chan reply, 1)
	go func() {
		status, body := call(1, false, "/api/todos/2", "retry-ben", `{"op":"retry","steer":"Use the shared helper"}`)
		done <- reply{status, body}
	}()
	require.Eventually(t, func() bool {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objid=$1)`, repo.ID).Scan(&waiting)
		return err == nil && waiting
	}, 5*time.Second, 10*time.Millisecond)
	_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE token_hash=$1`, hashes[1])
	require.NoError(t, err)
	require.NoError(t, locked.Commit(ctx))
	select {
	case denied := <-done:
		require.Equal(t, 401, denied.status, denied.body)
		require.Equal(t, "unauthenticated", denied.body["code"])
		require.NotContains(t, denied.body, "attempt")
	case <-time.After(5 * time.Second):
		t.Fatal("revoked replay did not finish")
	}
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes='write:repository,read:user,via:unlisted_tool' WHERE token_hash=$1`, hashes[0])
	require.NoError(t, err)
	status, unknown := call(0, false, "/api/todos", "unknown-actor", `{"title":"No new TODO","prompt":"No new TODO"}`)
	require.Equal(t, 403, status, unknown)
	require.Equal(t, "permission", unknown["code"])
	require.Equal(t, 5, count("approvals"))
	require.Equal(t, 5, count("mythical_items"))
	_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE token_hash=$1`, hashes[2])
	require.NoError(t, err)
	status, result := call(2, false, "/api/todos", "new-alice", `{"title":"Keep greeting","prompt":"Keep greeting","acceptance":[]}`)
	require.Equal(t, 401, status, result)
	require.Equal(t, "unauthenticated", result["code"])
	require.Equal(t, 5, count("approvals"))
	require.Equal(t, 5, count("mythical_items"))
	// Branch answers must pass the same member boundary as TODO controls.
	// A body marker grants no authority: only the two qualified commands run.
	t.Run("member branch answers", func(t *testing.T) {
		issuer := services.NewAuthService(q, cfg.Auth, nil, nil)
		issuer.Members = &services.Members{Pool: pool}
		turn := liveAppTurnCredentialFixture(t, pool, users[1].ID)
		credential, err := issuer.MintForTurn(ctx, users[1].ID, turn, 1)
		require.NoError(t, err)
		tokens[1] = credential.Token
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: users[2].ID, Name: "branch-external", TokenHash: hashes[2], TokenLastEight: hashes[2][56:], Scopes: "write:repository,read:user,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		head := strings.Repeat("1", 40)
		branch := "smithers/member-answer"
		checks := fmt.Sprintf(`{"todo":true,"branch":%q,"foreignHead":%q,"waits":[{"id":"foreign-1","kind":"foreign_push","sha":%q,"prompt":"Outside push","since":"2026-10-06T12:00:00Z"}]}`, branch, head, head)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='blocked',checks=$1,pending_op=NULL WHERE number=1`, []byte(checks))
		require.NoError(t, err)
		path := "/api/branches/smithers%2Fmember-answer"
		payload := func(op string) string { return fmt.Sprintf(`{"op":%q,"id":"foreign-1","revision":%q}`, op, head) }
		before := count("approvals")
		for _, op := range []string{"bring-in", "discard-foreign"} {
			status, refused := call(2, false, path, "external-"+op, payload(op))
			require.Equal(t, 403, status, refused)
			require.Equal(t, "permission", refused["class"])
			require.Equal(t, "permission", refused["code"])
		}
		// A trusted app actor still needs the descriptor's write scope.
		_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, credential.ID, "read:repository,read:user,via:smithers,terminal-session:"+turn+"/1")
		require.NoError(t, err)
		status, scoped := call(1, false, path, "read-only-bring-in", payload("bring-in"))
		require.Equal(t, 403, status, scoped)
		require.Equal(t, "permission", scoped["code"])
		_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, credential.ID, strings.Join(credential.Scopes, ","))
		require.NoError(t, err)
		status, bad := call(1, false, path, "bad-branch-command", payload("merge"))
		require.Equal(t, 400, status, bad)
		require.Equal(t, before, count("approvals"))
		for _, op := range []string{"bring-in", "discard-foreign"} {
			status, pending := call(1, false, path, "branch-"+op, payload(op))
			require.Equal(t, 202, status, pending)
			require.Equal(t, "pending", pending["state"])
			status, replay := call(1, false, path, "branch-"+op, payload(op))
			require.Equal(t, 202, status, replay)
			require.Equal(t, pending, replay)
			var foreign string
			require.NoError(t, pool.QueryRow(ctx, `SELECT COALESCE(checks->>'foreignHead','') FROM mythical_items WHERE number=1`).Scan(&foreign))
			require.Equal(t, head, foreign, "confirmation admission cannot answer the push")
		}
		require.Equal(t, before+2, count("approvals"))
		status, forbidden := call(2, true, path, "member-discard", payload("discard-foreign"))
		require.Equal(t, 403, status, forbidden)
		require.Equal(t, "permission", forbidden["code"])
		status, accepted := call(1, true, path, "person-discard", payload("discard-foreign"))
		require.Equal(t, 202, status, accepted)
		require.Equal(t, "accepted", accepted["state"])
		require.Equal(t, before+2, count("approvals"), "session answers execute directly")
		var foreign string
		require.NoError(t, pool.QueryRow(ctx, `SELECT COALESCE(checks->>'foreignHead','') FROM mythical_items WHERE number=1`).Scan(&foreign))
		require.Empty(t, foreign)
		for _, action := range []string{"restore", "restore-deleted"} {
			status, refused := call(2, false, path+"/files/src/a.ts", "external-"+action, fmt.Sprintf(`{"action":%q,"version":%q,"base_digest":"absent"}`, action, head))
			require.Equal(t, 403, status, refused)
			require.Equal(t, "permission", refused["class"])
			require.Equal(t, "permission", refused["code"])
		}
	})

}
