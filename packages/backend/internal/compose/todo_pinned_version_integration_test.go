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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Real PostgreSQL and the install router/auth; seeded attempt facts qualify
// the public projection, not production machine source loading.
func TestTodoPinnedVersionComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "pin-owner", LowerUsername: "pin-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"pin-owner","repository_name":"app","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	access := []byte(fmt.Sprintf(`{"owner_login":"pin-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: access}))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "blocked", Checks: []byte(fmt.Sprintf(`{"flowSource":"%s"}`, source))})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,flow_digest=$3,request_run_id='pinned-run',title='Pinned source' WHERE id=$1`, item.ID, owner.ID, digest)
	require.NoError(t, err)
	hash := sha256.Sum256([]byte("pin-cookie"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'pin-owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Server.PublicURL, cfg.Server.AllowedOrigins = "selfhost", origin, []string{origin}
	service := services.NewMythicalService(pool, nil)
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	read := func() map[string]any {
		req, err := http.NewRequest("GET", origin+"/api/todos/1", nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var card map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&card))
		require.Equal(t, 200, res.StatusCode, card)
		return card
	}
	card := read()
	require.Equal(t, map[string]any{"flow_name": "todo", "source_commit": source, "digest": digest}, card["flow_version"])
	require.Equal(t, "pinned-run", card["run"].(map[string]any)["id"])
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, repo.ID, strings.Repeat("c", 40))
	require.NoError(t, err)
	require.Equal(t, card["flow_version"], read()["flow_version"], "a main sync never rewrites the attempt pin")

	// A newer successfully loaded Active version must not become the source
	// of an ordinary Retry, even when its source differs from mirrored main.
	activeSource, activeDigest := strings.Repeat("d", 40), strings.Repeat("e", 64)
	_, err = pool.Exec(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,$2,$3,'loaded')`, repo.ID, activeSource, activeDigest)
	require.NoError(t, err)
	activeReads := 0
	service.SetTodoFlow(func(ctx context.Context, repositoryID int64, sourceCommit string) (string, error) {
		activeReads++
		return services.ActiveFlowDigest(ctx, q, repositoryID, "todo")
	})
	control := func(op, key string, want int) map[string]any {
		req, err := http.NewRequest("POST", origin+"/api/todos/1", strings.NewReader(fmt.Sprintf(`{"op":%q}`, op)))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Idempotency-Key", key)
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var value map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&value))
		require.Equal(t, want, res.StatusCode, value)
		return value
	}
	before, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	for _, op := range []string{"stop", "resume"} {
		refusal := control(op, op+"-pin", http.StatusServiceUnavailable)
		require.Equal(t, "todo_control_unavailable", refusal["code"])
		require.Equal(t, "infra", refusal["class"])
		after, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, before, after, "unavailable controls cannot mutate a pinned attempt")
	}
	first := control("retry", "same-pin", http.StatusAccepted)
	require.EqualValues(t, 2, first["attempt"])
	require.Equal(t, first, control("retry", "same-pin", http.StatusAccepted))
	require.Zero(t, activeReads, "ordinary Retry never resolves the newer Active version")
	retried := read()
	require.Equal(t, "queued", retried["state"])
	require.Equal(t, card["flow_version"], retried["flow_version"])
	require.Equal(t, card["evidence"], retried["evidence"])

	// Current-flow Retry selects a new pin, but leaves attempt one's public
	// version and evidence intact until Starting commits the next attempt.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='blocked' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	current := control("retry-current-flow", "current-pin", http.StatusAccepted)
	require.EqualValues(t, 2, current["attempt"])
	require.Equal(t, current, control("retry-current-flow", "current-pin", http.StatusAccepted))
	require.Equal(t, 1, activeReads, "reconnecting does not select Active again")
	queued, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	var checks struct {
		Retries []struct {
			Pin *struct {
				Flow            string `json:"flow"`
				SourceCommit    string `json:"sourceCommit"`
				ExecutionDigest string `json:"executionDigest"`
			} `json:"pin"`
		} `json:"retries"`
	}
	require.NoError(t, json.Unmarshal(queued.Checks, &checks))
	require.Len(t, checks.Retries, 2)
	require.Nil(t, checks.Retries[0].Pin)
	require.NotNil(t, checks.Retries[1].Pin)
	require.Equal(t, "todo", checks.Retries[1].Pin.Flow)
	require.Equal(t, activeSource, checks.Retries[1].Pin.SourceCommit)
	require.Equal(t, activeDigest, checks.Retries[1].Pin.ExecutionDigest)
	require.Equal(t, card["flow_version"], read()["flow_version"])
	require.Equal(t, card["evidence"], read()["evidence"])
}
