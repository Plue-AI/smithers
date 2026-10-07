package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallAgentModelsOwnerBoundaryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	create := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice := create("maya"), create("ben"), create("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	sessions := map[string]string{}
	for _, person := range []struct {
		user       db.User
		permission string
	}{{owner, "admin"}, {ben, "admin"}, {alice, "write"}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, person.user.ID, person.permission)
		require.NoError(t, err)
		raw := person.user.Username + "-model-session"
		hash := sha256.Sum256([]byte(raw))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.user.ID, Username: person.user.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		sessions[person.user.Username] = raw
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: pool}, Owners: q, Roster: q, Origins: middleware.FixedOrigins("http://example.com")})
	// This is the production composition's model mount, on the install router.
	seatsSource := &configSnapshotSource{}
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: pool}, q, cfg, seatsSource)
	call := func(person, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://example.com"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://example.com")
		req.AddCookie(&http.Cookie{Name: "session", Value: sessions[person]})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "model-boundary-csrf"})
		req.Header.Set("X-CSRF-Token", "model-boundary-csrf")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	const modelA = `{"protocol":"openai-chat","modelId":"model-a","credential":"OPENAI_API_KEY"}`
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:coding", Value: []byte(modelA)}))
	for _, person := range []string{"maya", "ben", "alice"} {
		res := call(person, "GET", "/api/agents", "")
		require.Equal(t, 200, res.Code, res.Body.String())
		var payload struct {
			CanAssign bool `json:"canAssign"`
			Agents    []struct {
				ID    string `json:"id"`
				Model struct {
					ID string `json:"id"`
				} `json:"model"`
				Source string `json:"source"`
			} `json:"agents"`
		}
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &payload))
		require.Equal(t, person == "maya", payload.CanAssign)
		require.Len(t, payload.Agents, 4)
		require.Equal(t, []string{"planner", "implementer", "reviewer", "app"}, []string{payload.Agents[0].ID, payload.Agents[1].ID, payload.Agents[2].ID, payload.Agents[3].ID})
		require.Equal(t, "model-a", payload.Agents[2].Model.ID)
		for _, path := range []string{"/api/model/catalog", "/api/model/default"} {
			res = call(person, "GET", path, "")
			require.Equal(t, 200, res.Code, res.Body.String())
		}
	}
	// Recent runs come from actual turn-linked model receipts, never the role's
	// current model. Private conversations and unrelated calls stay private.
	store, err := chat.NewStore(pool)
	require.NoError(t, err)
	for _, shared := range []bool{true, false} {
		run := fmt.Sprintf("receipt-run-%t", shared)
		request := json.RawMessage(fmt.Sprintf(`{"runId":%q,"instructions":"Answer","messages":[],"sharedConversation":%t}`, run, shared))
		accepted, err := store.Admit(ctx, chat.AdmitInput{Scope: chat.Scope{UserID: owner.ID, RepositoryID: repo.ID, Owner: "maya"}, RunID: run,
			Journal: chat.JournalRequest{Version: 1, LegID: "leg", Token: strings.Repeat("a", 48)}, Request: request})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO model_usage(request_key,paid_by,owner_type,owner_id,source,repository_id,reference,provider,model,outcome,settled_at)
   VALUES($1,'owner','user',$2,'app',$3,$4,'openai','actual-model-old','succeeded',now())`, run, owner.ID, repo.ID, accepted.TurnID)
		require.NoError(t, err)
	}
	recent := call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, recent.Code, recent.Body.String())
	var recentPayload struct {
		Agents []struct {
			ID   string             `json:"id"`
			Runs []db.AgentModelRun `json:"runs"`
		} `json:"agents"`
	}
	require.NoError(t, json.Unmarshal(recent.Body.Bytes(), &recentPayload))
	require.Equal(t, []db.AgentModelRun{{ID: "receipt-run-true", Model: "actual-model-old"}}, recentPayload.Agents[3].Runs)
	for _, agent := range recentPayload.Agents[:3] {
		require.Empty(t, agent.Runs, "no factory role inferred from a chat receipt")
	}
	require.NotContains(t, recent.Body.String(), "receipt-run-false")
	// Factory receipts retain the model actually used, after assignments change.
	var definition, factoryRun, factoryStep int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config) VALUES($1,'todo','flows/todo/flow.ts','{}') RETURNING id`, repo.ID).Scan(&definition))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event) VALUES($1,$2,'running','agent') RETURNING id`, repo.ID, definition).Scan(&factoryRun))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_steps(workflow_run_id,name,position,status) VALUES($1,'coding/review',0,'running') RETURNING id`, factoryRun).Scan(&factoryStep))
	_, err = pool.Exec(ctx, `INSERT INTO model_usage(request_key,paid_by,owner_type,owner_id,source,repository_id,workflow_run_id,workflow_step_id,provider,model,outcome,settled_at)
 VALUES('factory-receipt','owner','user',$1,'agent_run',$2,$3,$4,'openai','review-model-old','succeeded',now())`, owner.ID, repo.ID, factoryRun, factoryStep)
	require.NoError(t, err)
	recent = call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, recent.Code, recent.Body.String())
	require.NoError(t, json.Unmarshal(recent.Body.Bytes(), &recentPayload))
	require.Equal(t, []db.AgentModelRun{{ID: fmt.Sprint(factoryRun), Model: "review-model-old"}}, recentPayload.Agents[2].Runs)
	require.Empty(t, recentPayload.Agents[0].Runs)
	require.Empty(t, recentPayload.Agents[1].Runs)
	_, err = pool.Exec(ctx, `UPDATE workflow_steps SET name='unrelated' WHERE id=$1`, factoryStep)
	require.NoError(t, err)
	recent = call("alice", "GET", "/api/agents", "")
	require.NoError(t, json.Unmarshal(recent.Body.Bytes(), &recentPayload))
	require.Empty(t, recentPayload.Agents[2].Runs)
	// Only successfully activated repository declarations override their roles.
	seatsSource.config = `{"seats":{"coding/review":"openai:repository-review"}}`
	unactivated := call("alice", "GET", "/api/agents", "")
	require.NotContains(t, unactivated.Body.String(), "repository-review")
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: fmt.Sprintf("agent.instructions.main:%d", repo.ID), Value: []byte(`"` + strings.Repeat("a", 40) + `"`)}))
	activated := call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, activated.Code, activated.Body.String())
	var overlay struct {
		Agents []struct {
			ID    string `json:"id"`
			Model struct {
				ID string `json:"id"`
			} `json:"model"`
			Source string `json:"source"`
		} `json:"agents"`
	}
	require.NoError(t, json.Unmarshal(activated.Body.Bytes(), &overlay))
	require.Equal(t, "repository-review", overlay.Agents[2].Model.ID)
	require.Equal(t, "repository", overlay.Agents[2].Source)
	require.Equal(t, "model-a", overlay.Agents[0].Model.ID)
	require.Equal(t, "owner", overlay.Agents[0].Source)
	require.Equal(t, "model-a", overlay.Agents[3].Model.ID)
	seatsSource.config = `{"seats":{"coding/plan":"auto"}}`
	automatic := call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, automatic.Code, automatic.Body.String())
	require.Contains(t, automatic.Body.String(), `"id":"auto"`)
	seatsSource.config = ""
	const fast = `{"protocol":"openai-chat","modelId":"model-f","credential":"CEREBRAS_API_KEY","baseUrl":"https://api.cerebras.ai"}`
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:fast", Value: []byte(fast)}))
	_, err = pool.Exec(ctx, `INSERT INTO owner_model_credentials(user_id,name,origin,value_encrypted) VALUES($1,'CEREBRAS_API_KEY','https://api.cerebras.ai','sealed-fixture')`, owner.ID)
	require.NoError(t, err)
	resFast := call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, resFast.Code)
	require.Contains(t, resFast.Body.String(), `"id":"model-f"`)
	_, err = pool.Exec(ctx, `UPDATE owner_model_credentials SET value_encrypted=NULL WHERE user_id=$1 AND name='CEREBRAS_API_KEY'`, owner.ID)
	require.NoError(t, err)
	resFast = call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, resFast.Code)
	var after struct {
		Agents []struct {
			ID    string `json:"id"`
			Model struct {
				ID string `json:"id"`
			} `json:"model"`
		} `json:"agents"`
	}
	require.NoError(t, json.Unmarshal(resFast.Body.Bytes(), &after))
	require.Equal(t, "model-a", after.Agents[3].Model.ID)
	const modelB = `{"model":{"protocol":"openai-chat","modelId":"model-b","credential":"OPENAI_API_KEY"}}`
	for _, person := range []string{"ben", "alice"} {
		for _, write := range []struct{ method, path, body string }{{"PUT", "/api/agents/reviewer/model", modelB}, {"PUT", "/api/model/default", modelB}, {"POST", "/api/model/credential", `{}`}, {"POST", "/api/model/test", `{}`}, {"GET", "/api/model/test/receipt?requestId=private-probe-id", ""}} {
			res := call(person, write.method, write.path, write.body)
			require.Equal(t, 403, res.Code, res.Body.String())
			require.Contains(t, res.Body.String(), `"class":"permission"`)
		}
	}
	for _, person := range []db.User{owner, alice} {
		raw := fmt.Sprintf("smithers_%040x", person.ID)
		hash := sha256.Sum256([]byte(raw))
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: person.ID, Name: "model-delegation", TokenHash: hex.EncodeToString(hash[:]), TokenLastEight: "12345678", Scopes: "write:user,write:agent,write:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		req := httptest.NewRequest("PUT", "/api/agents/reviewer/model", strings.NewReader(modelB))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://example.com")
		req.Header.Set("Authorization", "Bearer "+raw)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		require.Equal(t, 403, res.Code, res.Body.String())
		if person.ID == owner.ID {
			require.Contains(t, res.Body.String(), `"class":"never"`)
		} else {
			require.Contains(t, res.Body.String(), `"class":"permission"`)
		}
	}
	var settings, receipts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='agent:reviewer'`).Scan(&settings))
	require.Zero(t, settings)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM owner_model_credential_receipts`).Scan(&receipts))
	require.Zero(t, receipts)
	for _, body := range []string{modelB + strings.Repeat(" ", 16384) + `{}`, `{}`, `{"model":{"protocol":"evaluation","modelId":"bad","credential":"OPENAI_API_KEY"}}`, modelB + ` {}`, `{"model":{"protocol":"openai-chat","modelId":"b","credential":"OPENAI_API_KEY","extra":true}}`} {
		res := call("maya", "PUT", "/api/agents/reviewer/model", body)
		require.Equal(t, 400, res.Code, res.Body.String())
	}
	res := call("maya", "PUT", "/api/agents/reviewer/model", modelB)
	require.Equal(t, 200, res.Code, res.Body.String())
	row, err := q.GetInstallSetting(ctx, "agent:reviewer")
	require.NoError(t, err)
	require.JSONEq(t, `{"protocol":"openai-chat","modelId":"model-b","credential":"OPENAI_API_KEY"}`, string(row.Value))
	res = call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, res.Code)
	require.Contains(t, res.Body.String(), `"id":"model-b"`)
	_, err = pool.Exec(ctx, `INSERT INTO owner_model_credentials(user_id,name,origin,value_encrypted) VALUES($1,'OPENAI_API_KEY','https://api.openai.com','sealed-fixture')`, owner.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:fast", Value: []byte(modelA)}))
	res = call("maya", "PUT", "/api/agents/coding/model", modelB)
	require.Equal(t, 200, res.Code, res.Body.String())
	res = call("alice", "GET", "/api/install", "")
	require.Equal(t, 403, res.Code, res.Body.String())
	res = call("maya", "GET", "/api/install", "")
	require.Equal(t, 200, res.Code, res.Body.String())
	var install struct {
		CanAssignModels bool `json:"can_assign_models"`
		Models          []struct {
			Role  string `json:"role"`
			Model string `json:"model"`
		} `json:"models"`
	}
	require.NoError(t, json.Unmarshal(res.Body.Bytes(), &install))
	require.True(t, install.CanAssignModels)
	require.Len(t, install.Models, 3)
	require.Equal(t, "coding", install.Models[1].Role)
	require.Equal(t, "model-b", install.Models[1].Model)
	require.Equal(t, "model-b", install.Models[0].Model)
	res = call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, res.Code)
	require.NoError(t, json.Unmarshal(res.Body.Bytes(), &after))
	require.Equal(t, "model-b", after.Agents[3].Model.ID)
	res = call("maya", "PUT", "/api/agents/fast/model", `{"model":`+modelA+`}`)
	require.Equal(t, 200, res.Code, res.Body.String())
	res = call("maya", "PUT", "/api/agents/coding/model", strings.ReplaceAll(modelB, "model-b", "model-c"))
	require.Equal(t, 200, res.Code, res.Body.String())
	res = call("alice", "GET", "/api/agents", "")
	require.Equal(t, 200, res.Code)
	require.NoError(t, json.Unmarshal(res.Body.Bytes(), &after))
	require.Equal(t, "model-a", after.Agents[3].Model.ID)
	res = call("alice", "GET", "/api/model/default", "")
	require.Equal(t, 200, res.Code)
	require.Contains(t, res.Body.String(), `"modelId":"model-c"`)
	res = call("maya", "PUT", "/api/model/default", strings.ReplaceAll(modelB, "model-b", "model-d"))
	require.Equal(t, 200, res.Code, res.Body.String())
	row, err = q.GetInstallSetting(ctx, "agent:coding")
	require.NoError(t, err)
	require.JSONEq(t, `{"protocol":"openai-chat","modelId":"model-d","credential":"OPENAI_API_KEY"}`, string(row.Value))
	res = call("maya", "PUT", "/api/agents/unknown/model", modelB)
	require.Equal(t, 400, res.Code)
}
