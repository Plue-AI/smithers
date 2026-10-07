package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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
// This supplements live execution tests: ordinary cells qualify the PostgreSQL
// authorizer, SG-08 qualifies real confirmation HTTP and SG-09 route absence.
// The five unlanded T-ACC-03 run/machine grants are explicitly pending, never
// converted to passing permission refusals. Full C-ACC-01 requires their real
// subjects and execution consumers as well as this independent decision oracle.
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
		} else {
			info.IsTokenAuth, info.TokenSystemIssued = true, true
			info.RawScopes = "repo,user"
			if label[0] == 'D' {
				info.RawScopes += ",via:codex"
			}
			if label[0] == 'M' {
				info.RawScopes += ",workspace:approved-own-branch"
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
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	todos := services.NewMythicalService(pool, nil)
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}})
	aliases := map[string]string{"install.setup-step": "settings.setup", "secrets.names": "secrets.read", "ssh.copy": "ssh", "confirmation.list": "confirmations.read", "flow.source-coedit": "flow.source"}
	var ledger []map[string]any
	resolved, retired, pending := 0, 0, 0
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
			if cell.Expected == "allow" && (cell.Credential[0] == 'R' || cell.Credential[0] == 'M') {
				entry["pending_ticket"] = "T-ACC-03"
				command := cell.Command
				if alias := aliases[command]; alias != "" {
					command = alias
				}
				_, observed := services.Authorize(middleware.ContextWithAuthInfo(ctx, info), q, command)
				if observed == nil {
					entry["observed_status"] = 200
				} else {
					var refusal *services.AccessError
					require.True(t, errors.As(observed, &refusal), observed)
					entry["observed_status"], entry["observed_code"], entry["observed_class"] = refusal.Status, refusal.Code, refusal.Class
				}
				pending++
				t.Skip("T-ACC-03: subject-bound run/machine authorization grants are not installed")
			}
			status, code, class := 200, "", ""
			if cell.Group == "SG-08" && strings.HasPrefix(cell.Command, "confirmation.create") || cell.Group == "SG-09" {
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
				command := cell.Command
				if alias := aliases[command]; alias != "" {
					command = alias
				}
				_, err := services.Authorize(middleware.ContextWithAuthInfo(ctx, infos[cell.Credential]), q, command)
				if err != nil {
					var access *services.AccessError
					require.True(t, errors.As(err, &access), err)
					status, code, class = access.Status, access.Code, access.Class
				}
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
	var todosCount, confirmationCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&todosCount))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&confirmationCount))
	require.Zero(t, todosCount, "confirmation admission must not file a TODO")
	require.Equal(t, 3, confirmationCount, "only the three eligible delegated create cells store private confirmations")
	if dir := os.Getenv("SMITHERS_ACCESS_LEDGER_DIR"); dir != "" {
		data, err := json.MarshalIndent(map[string]any{"acceptance_complete": false, "authorization_resolved": resolved, "retired_resolved": retired, "pending": pending, "cells": ledger}, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(dir, 0700))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "ledger.json"), append(data, '\n'), 0600))
	}
	t.Logf("approved decision ledger: %d resolved authorization cells, %d retired routes, %d pending; live command execution remains separate", resolved, retired, pending)
}
