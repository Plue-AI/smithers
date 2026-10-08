package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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

// Only transport timing/failure is injected; the repository serves real Git.
type dropCatalogHost struct {
	*pollingGitHost
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	fail    atomic.Bool
}

func (h *dropCatalogHost) InfoRefs(ctx context.Context, owner, repo, service string, out io.Writer) (string, error) {
	if h.fail.Load() {
		return "", errors.New("catalog transport unavailable")
	}
	h.once.Do(func() { close(h.entered) })
	select {
	case <-h.release:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	return h.pollingGitHost.InfoRefs(ctx, owner, repo, service, out)
}

func TestTodoDropAnswersBeforeCatalogTransportComposedInstall(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	host := &dropCatalogHost{pollingGitHost: &pollingGitHost{dir: filepath.Join(t.TempDir(), "mirror.git")}, entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(host.release) }) })
	gitctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); release.Do(func() { close(host.release) }) })
	require.NoError(t, host.git(gitctx, nil, io.Discard, "init", "--bare", host.dir))
	var tree, commit bytes.Buffer
	require.NoError(t, host.git(gitctx, nil, &tree, "mktree"))
	require.NoError(t, host.git(gitctx, nil, &commit, "commit-tree", strings.TrimSpace(tree.String()), "-m", "Main"))
	base := strings.TrimSpace(commit.String())
	require.NoError(t, host.git(gitctx, nil, io.Discard, "update-ref", "refs/heads/main", base))
	require.NoError(t, host.git(gitctx, nil, io.Discard, "update-ref", "refs/heads/mythical", base))
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repo.ID))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-06T01:00:00Z"}`, repo.ID))}))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active',tip_commit=$2,landed_main=$2 WHERE repository_id=$1`, repo.ID, base)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "blocked", Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,request_run_id='run-1',title='Interrupted',stack_position=1 WHERE id=$1`, item.ID, owner.ID)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, host)
	client := &http.Client{Timeout: time.Second}
	raw := "interrupted-session"
	hash := sha256.Sum256([]byte(raw))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	call := func(method, body, key string) (int, map[string]any) {
		req, err := http.NewRequest(method, origin+"/api/todos/1", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Idempotency-Key", key)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: raw})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		res, err := client.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var value map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&value))
		return res.StatusCode, value
	}
	// A second TODO has a candidate: catalog projection must inspect its Git
	// tree even though it has no flow edit. Drop itself must never wait for it.
	_, _, err = q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "blocked", Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=2,owner_id=$2,title='Other candidate',stack_position=2,candidate_base=$4,candidate_head=$4 WHERE repository_id=$1 AND id<>$3`, repo.ID, owner.ID, item.ID, base)
	require.NoError(t, err)
	// A deadline fails the old synchronous fetch without leaving a held request.
	began := time.Now()
	status, receipt := call("POST", `{"op":"drop"}`, "drop-once")
	elapsed := time.Since(began)
	require.Equal(t, 202, status, receipt)
	require.Equal(t, "accepted", receipt["state"])
	require.Less(t, elapsed, time.Second)
	t.Logf("Drop acknowledgment: %s", elapsed)
	select {
	case <-host.entered:
		t.Fatal("Drop fetched the flow catalog before answering")
	default:
	}
	status, card := call("GET", "", "")
	require.Equal(t, 200, status)
	require.Equal(t, "dropped", card["state"])
	// Restart after admission. The committed stack request owns the refresh.
	recovered := services.NewMythicalService(pool, host)
	host.fail.Store(true)
	require.NoError(t, recovered.PollOnce(ctx))
	stack, err := q.GetMythicalStack(ctx, repo.ID)
	require.NoError(t, err)
	require.Contains(t, stack.LastError, "refresh flow catalog")
	require.Greater(t, stack.RequestedGeneration, stack.ProcessedGeneration)
	host.fail.Store(false)
	_, err = q.RequestMythicalStack(ctx, repo.ID)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- recovered.PollOnce(ctx) }()
	select {
	case <-host.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("recovered worker did not retry catalog transport")
	}
	status, receipt = call("POST", `{"op":"drop"}`, "drop-once")
	require.Equal(t, 202, status, receipt)
	status, card = call("GET", "", "")
	require.Equal(t, 200, status)
	require.Equal(t, "dropped", card["state"])
	release.Do(func() { close(host.release) })
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("catalog refresh did not finish")
	}
	stack, err = q.GetMythicalStack(ctx, repo.ID)
	require.NoError(t, err)
	require.Empty(t, stack.LastError)
	var events int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='flows.changed'`).Scan(&events))
	require.Positive(t, events)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped'`).Scan(&events))
	require.Equal(t, 1, events, "duplicate press never drops twice")
}
