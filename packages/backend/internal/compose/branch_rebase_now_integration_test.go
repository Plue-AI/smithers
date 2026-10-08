package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Admission must not await repository transport. The real native host remains
// underneath; any attempt to fetch during the HTTP request is refused here.
type rebaseAdmissionHost struct {
	*repohost.Client
	touched atomic.Bool
}

func (h *rebaseAdmissionHost) InfoRefs(context.Context, string, string, string, io.Writer) (string, error) {
	h.touched.Store(true)
	return "", errors.New("repository transport held")
}

func TestBranchRebaseNowComposedAdmission(t *testing.T) {
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
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "running", Checks: []byte(fmt.Sprintf(`{"todo":true,"run_launched":true,"run_attached":true,"flowSource":"%s"}`, source))})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,flow_digest=$3,request_run_id='pinned-run',workspace_id='11111111-1111-4111-8111-111111111111',revisions='[{"text":"Original","acceptance":[],"reason":"create"}]',title='Pinned source' WHERE id=$1`, item.ID, owner.ID, digest)
	require.NoError(t, err)
	hash := sha256.Sum256([]byte("pin-cookie"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'pin-owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Server.PublicURL, cfg.Server.AllowedOrigins = "selfhost", origin, []string{origin}
	storage := t.TempDir()
	local, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "rebase-test", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH")})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	require.NoError(t, local.Client().InitRepo(ctx, owner.Username, "app", "main", true))
	base, err := local.Client().GetBookmark(ctx, owner.Username, "app", "main")
	require.NoError(t, err)
	source = base.TargetCommitID
	git := func(args ...string) string {
		t.Helper()
		argv := append([]string{"-C", filepath.Join(storage, owner.Username, "app", ".jj", "repo", "store", "git"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"}, args...)
		out, err := exec.CommandContext(ctx, "git", argv...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	tree := git("rev-parse", source+"^{tree}")
	onto := git("commit-tree", tree, "-p", source, "-m", "Main moved")
	head := git("commit-tree", tree, "-p", source, "-m", "Candidate")
	git("update-ref", "refs/smithers/test/candidate", head)
	git("update-ref", "refs/smithers/test/onto", onto)
	host := &rebaseAdmissionHost{Client: local.Client()}
	service := services.NewMythicalService(pool, host)
	service.SetLauncher(&conflictDoorProvider{})

	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active',landed_main=$2 WHERE repository_id=$1`, repo.ID, onto)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='integrating',reason='rebase_pending',stack_position=1,candidate_base=$2,candidate_head=$3,checks=checks || jsonb_build_object('branch','smithers/test','rebase',jsonb_build_object('onto',$4::text,'name','main')) WHERE id=$1`, item.ID, source, head, onto)
	require.NoError(t, err)
	call := func(key string) (int, map[string]any) {
		req, err := http.NewRequest("POST", origin+"/api/branches/smithers%2Ftest", strings.NewReader(`{"rebase":true}`))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var data map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&data))
		return res.StatusCode, data
	}
	// An event write failure rolls back the scheduling override and receipt.
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_rebase_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='todo.rebase-requested' THEN RAISE EXCEPTION 'injected rebase fact failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_rebase_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_rebase_fact()`)
	require.NoError(t, err)
	code, data := call("rebase-press")
	require.Equal(t, 503, code, data)
	var pendingRequest []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'rebase'->'request' FROM mythical_items WHERE id=$1`, item.ID).Scan(&pendingRequest))
	require.Nil(t, pendingRequest)
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_rebase_fact ON product_job_events; DROP FUNCTION refuse_rebase_fact()`)
	require.NoError(t, err)
	for range 2 {
		code, data := call("rebase-press")
		require.Equal(t, 202, code, data)
		require.Equal(t, "accepted", data["state"])
	}
	current, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, head, current.CandidateHead, "the request returns before execution")
	var checks map[string]any
	require.NoError(t, json.Unmarshal(current.Checks, &checks))
	request := checks["rebase"].(map[string]any)["request"].(map[string]any)
	require.Equal(t, head, request["head"])
	require.Equal(t, map[string]any{"person": "pin-owner"}, request["by"])
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='todo.rebase-requested'`).Scan(&count))
	require.Equal(t, 1, count)
	require.False(t, host.touched.Load(), "the press returned without waiting for Git")
	// A new press cannot supersede a merge/publication fence.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op='{"kind":"push"}' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	code, data = call("new-press")
	require.Equal(t, 409, code, data)
	require.Equal(t, "merging", data["code"])
	// The original receipt still replays while the state advances.
	code, data = call("rebase-press")
	require.Equal(t, 202, code, data)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op=NULL,checks=jsonb_set(checks,'{rebase,onto}','"changed"') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	code, data = call("new-press")
	require.Equal(t, 409, code, data)
	require.Equal(t, "rebase_target_changed", data["code"])
}
