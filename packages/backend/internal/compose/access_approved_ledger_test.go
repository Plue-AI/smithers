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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The reviewed SG oracle is literal and independent of catalog descriptors.
// Every resolved cell crosses a composed install HTTP door with stored credentials.
// Co-edit uses the existing controlled guest transport to isolate authorization;
// guest security qualification remains separate. Child flow launch crosses
// the real durable dispatcher with its stored parent authority.
func TestApprovedAccessDecisionLedgerPostgres(t *testing.T) {
	var fixture struct {
		Cells []struct{ Group, Command, Credential, Expected string }
	}
	data, err := os.ReadFile("testdata/access/approved-58.json")
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &fixture))
	require.Len(t, fixture.Cells, 58)
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	users := make([]db.User, 3)
	for i, login := range []string{"maya", "ben", "alice"} {
		users[i], err = q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login})
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, users[0].ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: users[0].ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID)
	for key, value := range map[string]string{"github.repository": binding, "owner.access": binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-07T12:00:00Z"}`} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, users[0].ID)
	require.NoError(t, err)
	for i, u := range users {
		permission := "admin"
		if i == 2 {
			permission = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, permission)
		require.NoError(t, err)
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	issuer := services.NewAuthService(q, cfg.Auth, nil, nil)
	issuer.Members = &services.Members{Pool: pool}
	// Literal O/X credentials bind to different stored execution subjects.
	// These rows let SG-07 cross the production TODO route rather than treating
	// a missing subject as evidence for either an allow or a refusal.
	workspaces := make([]db.Workspace, 2)
	for i := range workspaces {
		workspaces[i], err = q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: users[0].ID, Name: fmt.Sprintf("ledger-%d", i), TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,created_by,revisions,checks,attempt)
 VALUES($1,'todo','running',$2,$2,'Bound execution',$3,$4,$5,$5,'[{"private":"never-return-person-card"}]','{"private":"never-return-confirmation"}',1)`, repo.ID, i+1, workspaces[i].ID, fmt.Sprintf("ledger-run-%d", i), users[0].ID)
		require.NoError(t, err)
	}
	infos := map[string]*middleware.AuthInfo{}
	tokens, sessions := map[string]string{}, map[string]string{}
	for _, label := range []string{"SO", "SM", "SE", "DO", "DM", "DE", "RO", "RX", "MO", "MX"} {
		i := 0
		if label[1] == 'M' {
			i = 1
		}
		if label[1] == 'E' {
			i = 2
		}
		info := &middleware.AuthInfo{User: &users[i]}
		if label[0] == 'S' {
			sessions[label] = "approved-" + label
			sum := sha256.Sum256([]byte(sessions[label]))
			info.SessionHash = hex.EncodeToString(sum[:])
			_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: users[i].ID, Username: users[i].Username, SessionKey: info.SessionHash, ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
		} else if label[0] == 'D' {
			credential, err := issuer.CreateToken(ctx, users[i].ID, services.CreateTokenRequest{Name: label, Via: "codex", Scopes: []string{"repo", "user"}})
			require.NoError(t, err)
			row, err := q.GetAccessTokenByID(ctx, credential.ID)
			require.NoError(t, err)
			require.True(t, row.SystemIssued)
			require.Contains(t, row.Scopes, "via:codex")
			require.WithinDuration(t, time.Now().Add(30*24*time.Hour), row.ExpiresAt.Time, time.Second)
			info.IsTokenAuth, info.TokenSystemIssued = true, row.SystemIssued
			info.TokenID, info.TokenHash, info.RawScopes = row.ID, row.TokenHash, row.Scopes
			info.Scopes = middleware.ParseTokenScopes(row.Scopes)
			tokens[label] = credential.Token
		} else {
			info.IsTokenAuth, info.TokenSystemIssued = true, true
			subjectIndex := 0
			if label[1] == 'X' {
				subjectIndex = 1
			}
			info.RawScopes = "repo,user," + middleware.RepositoryRestrictionScope(repo.ID)
			if label[0] == 'M' {
				info.RawScopes += "," + middleware.WorkspaceRestrictionScope(workspaces[subjectIndex].ID)
			} else {
				info.RawScopes += "," + middleware.LandingWorkspaceScope(workspaces[subjectIndex].ID) + "," + middleware.AgentSessionRestrictionScope(fmt.Sprintf("ledger-run-%d", subjectIndex))
			}
			info.Scopes = middleware.ParseTokenScopes(info.RawScopes)
			tokens[label] = fmt.Sprintf("smithers_%040x", len(infos)+12000)
			sum := sha256.Sum256([]byte(tokens[label]))
			info.TokenHash = hex.EncodeToString(sum[:])
			row, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: users[i].ID, Name: label, TokenHash: info.TokenHash, TokenLastEight: info.TokenHash[56:], Scopes: info.RawScopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
			require.NoError(t, err)
			info.TokenID = row.ID
		}
		infos[label] = info
	}
	todos := services.NewMythicalService(pool, nil)
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	secrets := &routes.SecretHandler{Service: services.NewSecretService(q, nil, services.WithSecretInstallAuthorization(true, pool))}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q}, conformanceServices{pool: pool, mythical: &routes.MythicalHandler{Service: todos}, members: &routes.MembersHandler{Service: members}, secret: secrets})
	var ledger []map[string]any
	resolved, retired := 0, 0
	for index, cell := range fixture.Cells {
		t.Run(fmt.Sprintf("%s/%s/%s", cell.Group, cell.Command, cell.Credential), func(t *testing.T) {
			entry := map[string]any{"group": cell.Group, "command": cell.Command, "credential": cell.Credential, "expected": cell.Expected, "layer": "PostgreSQL authorizer", "execution": "pending"}
			info := infos[cell.Credential]
			entry["credential_hash"] = info.TokenHash
			if info.SessionHash != "" {
				entry["credential_hash"] = info.SessionHash
			}
			entry["trusted_kind"] = info.CredentialKind()
			ledger = append(ledger, entry)
			if cell.Group == "SG-04" && cell.Command == "branch.fork" && cell.Credential == "RO" && cell.Expected == "allow" {
				proof := testInstallRunForkAuthorizationPostgres(t)
				entry["credential_hash"] = proof["credential_hash"]
				entry["subject"] = proof
				entry["layer"], entry["execution"] = "composed install native fork HTTP", "passed"
				entry["actual_status"] = 201
				entry["receipt"] = "TestInstallRunForkAuthorizationPostgres"
				resolved++
				return
			}
			if cell.Command == "flow.source-coedit" && cell.Credential == "RO" && cell.Expected == "allow" {
				proof := testInstallSourceCoeditAdmissionPostgres(t)
				entry["credential_hash"], entry["subject"] = proof["credential_hash"], proof
				entry["layer"], entry["execution"] = "composed install co-edit HTTP; controlled guest transport", "passed"
				entry["actual_status"] = 200
				entry["receipt"] = "TestInstallSourceCoeditAdmissionPostgres"
				resolved++
				return
			}
			if cell.Command == "flow.run" && cell.Credential == "RO" && cell.Expected == "allow" {
				proof := testInstallOwnRunFlowDispatchPostgres(t)
				entry["credential_hash"], entry["subject"] = proof["credential_hash"], proof
				entry["layer"], entry["execution"] = "composed install HTTP and durable Flow worker; controlled runtime transport", "passed"
				entry["actual_status"], entry["receipt"] = 202, "TestInstallOwnRunFlowDispatchPostgres"
				resolved++
				return
			}
			status, code, class := 200, "", ""
			if cell.Group == "SG-07" && cell.Command == "todo.read" {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/todos/1", nil)
				req.Header.Set("Authorization", "Bearer "+tokens[cell.Credential])
				// Attribution assertions cannot turn another branch into this one.
				req.Header.Set("Smithers-Via", "smithers")
				req.Header.Set("Smithers-Actor", "person")
				w := httptest.NewRecorder()
				router.ServeHTTP(w, req)
				status = w.Code
				var envelope struct{ Code, Class string }
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
				code, class = envelope.Code, envelope.Class
				entry["layer"] = "composed install HTTP"
				require.NotContains(t, w.Body.String(), "never-return")
				if cell.Expected == "allow" {
					require.Contains(t, w.Body.String(), `"title":"Bound execution"`)
				}
			} else if cell.Group == "SG-08" && strings.HasPrefix(cell.Command, "confirmation.create") || cell.Group == "SG-09" {
				path, body := "/api/confirmations", `{"command":"todo.new","payload":{"title":"Literal ledger","prompt":"Retain greeting"}}`
				if cell.Group == "SG-09" {
					path, body = "/api/repos/maya/demo/repository-jobs", "{}"
				}
				req := httptest.NewRequest("POST", cfg.Server.PublicURL+path, strings.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
				req.Header.Set("Idempotency-Key", fmt.Sprint("approved-", index))
				if raw := sessions[cell.Credential]; raw != "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: raw})
					req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
					req.Header.Set("X-CSRF-Token", "csrf")
				} else {
					req.Header.Set("Authorization", "Bearer "+tokens[cell.Credential])
				}
				w := httptest.NewRecorder()
				router.ServeHTTP(w, req)
				status = w.Code
				var envelope struct{ Code, Class string }
				_ = json.Unmarshal(w.Body.Bytes(), &envelope)
				code, class = envelope.Code, envelope.Class
				entry["layer"] = "composed install HTTP"
				if cell.Group == "SG-09" {
					// The retired cell covers every former user-management door,
					// including aliases that otherwise enter gateway worker routing.
					for _, door := range []struct{ method, path string }{
						{"GET", "/api/repos/maya/demo/repository-jobs"},
						{"PUT", "/api/repos/maya/demo/repository-jobs/ci"},
						{"DELETE", "/api/repos/maya/demo/repository-jobs/ci"},
						{"POST", "/api/repos/maya/demo/repository-jobs/ci/pause"},
						{"POST", "/api/repos/maya/demo/repository-jobs/ci/resume"},
						{"GET", "/api/gateways/host/repository-jobs/ci"},
						{"POST", "/api/gateways/host/repository-jobs/ci/manual/request"},
						{"POST", "/api/gateways/host/repository-jobs/ci/trials/request"},
						{"POST", "/api/gateways/host/repository-jobs/ci/check-receipts/request"},
					} {
						alias := httptest.NewRequest(door.method, cfg.Server.PublicURL+door.path, strings.NewReader("{}"))
						alias.Header = req.Header.Clone()
						response := httptest.NewRecorder()
						router.ServeHTTP(response, alias)
						require.Equal(t, 404, response.Code, door)
					}
				}
			} else {
				// Literal HTTP doors, independent of descriptors under test.
				method, path, body := "GET", "", ""
				switch cell.Command {
				case "install.setup-step":
					method, path, body = "POST", "/api/install/setup/models", `{}`
				case "install.read":
					path = "/api/install"
				case "members.list":
					path = "/api/members"
				case "secrets.names":
					path = "/api/secrets"
				case "ssh.copy":
					path = "/api/repos/maya/demo/workspaces/" + workspaces[0].ID + "/ssh"
				case "agents.read":
					path = "/api/agents"
				case "confirmation.list":
					path = "/api/confirmations"
				case "terminal":
					method, path, body = "POST", "/api/terminals", `{"branch":"T1"}`
				case "branch.add-to-stack":
					method, path, body = "POST", "/api/branches/T1/add-to-stack", `{}`
				case "branch.rebase", "branch.rebase-now", "branch.sleep", "branch.wake":
					method, path = "POST", "/api/branches/T1"
					body = `{"op":"` + strings.TrimPrefix(cell.Command, "branch.") + `"}`
					if cell.Command == "branch.rebase-now" {
						body = `{"rebase":true}`
					}
				default:
					t.Fatalf("missing literal HTTP fixture for %s", cell.Command)
				}
				req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
				req.Header.Set("Idempotency-Key", fmt.Sprint("approved-", index))
				if raw := sessions[cell.Credential]; raw != "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: raw})
					req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
					req.Header.Set("X-CSRF-Token", "csrf")
				} else {
					req.Header.Set("Authorization", "Bearer "+tokens[cell.Credential])
				}
				var commands []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
				w := httptest.NewRecorder()
				router.ServeHTTP(w, req)
				status = w.Code
				var envelope struct{ Code, Class string }
				if status != http.StatusOK {
					require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope), w.Body.String())
				}
				code, class = envelope.Code, envelope.Class
				if cell.Command == "confirmation.list" {
					require.LessOrEqual(t, len(commands), 1)
				} else {
					require.Len(t, commands, 1, "one decision through HTTP: %v; %s", commands, w.Body.String())
				}
				entry["layer"] = "composed install HTTP"
			}

			entry["actual_status"], entry["actual_code"], entry["actual_class"] = status, code, class
			switch cell.Expected {
			case "allow":
				require.Equal(t, 200, status)
			case "confirm":
				require.Equal(t, 202, status)
			case "not-served-404":
				require.Equal(t, 404, status)
				retired++
			default:
				require.Equal(t, 403, status)
				require.Equal(t, cell.Expected, code)
				require.Equal(t, cell.Expected, class)
			}
			entry["execution"] = "passed"
			if cell.Group != "SG-09" {
				resolved++
			}
		})
	}
	require.Equal(t, 52, resolved)
	require.Equal(t, 6, retired)
	var todosCount, confirmationCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&todosCount))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&confirmationCount))
	require.Equal(t, 2, todosCount, "confirmation admission must not add to the two execution fixtures")
	require.Equal(t, 3, confirmationCount, "only the three eligible delegated create cells store private confirmations")
	if dir := os.Getenv("SMITHERS_ACCESS_LEDGER_DIR"); dir != "" {
		data, err := json.MarshalIndent(map[string]any{"acceptance_complete": resolved == 52 && retired == 6 && !t.Failed(), "authorization_resolved": resolved, "retired_resolved": retired, "pending": 0, "cells": ledger}, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(dir, 0700))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "ledger.json"), append(data, '\n'), 0600))
	}
	t.Logf("approved decision ledger: %d resolved authorization cells, %d retired routes, %d pending; live command execution remains separate", resolved, retired, 0)
}
