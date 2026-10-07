package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The guest observation is a test-only fake. The composed HTTP route, auth,
// stack ordering, invalidation and persistence are real. This is not the
// reference-host microVM acceptance receipt for C-STK-06.
type candidateHeadRuntime struct {
	workspaceapi.WorkspaceRuntime
	head, change, tree, candidate, candidateTree string
	operations                                   map[string]bool
	fail                                         bool
	calls                                        int
	host                                         bool
	repositoryDir                                string
}

func (r *candidateHeadRuntime) Isolation() workspaceapi.IsolationLevel {
	if r.host {
		return workspaceapi.IsolationTrustedProcess
	}
	return workspaceapi.IsolationSandboxed
}

func (r *candidateHeadRuntime) ExecuteCommand(ctx context.Context, _ string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	r.calls++
	operation, ok := workspaceapi.OperationFromContext(ctx)
	if !ok || r.operations[operation.OperationID] {
		return workspaceapi.CommandResult{}, fmt.Errorf("live read reused an execution identity")
	}
	r.operations[operation.OperationID] = true
	if r.repositoryDir != "" {
		cmd := exec.CommandContext(ctx, command.Args[0], command.Args[1:]...)
		cmd.Dir = r.repositoryDir
		cmd.Env = os.Environ()
		for key, value := range command.Environment {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			return workspaceapi.CommandResult{}, fmt.Errorf("fixture guest command: %w: %s", err, out)
		}
		return workspaceapi.CommandResult{Stdout: string(out)}, nil
	}
	if r.fail {
		return workspaceapi.CommandResult{ExitCode: 1}, nil
	}
	if command.Args[0] == "jj" {
		for _, arg := range command.Args {
			if arg == "--ignore-working-copy" {
				return workspaceapi.CommandResult{}, fmt.Errorf("live observation ignored unsnapshotted edits")
			}
		}
		return workspaceapi.CommandResult{Stdout: r.head + " " + r.change}, nil
	}
	if command.Args[0] != "git" || len(command.Args) != 4 {
		return workspaceapi.CommandResult{}, fmt.Errorf("unexpected observation command")
	}
	if command.Environment["GIT_NO_REPLACE_OBJECTS"] != "1" {
		return workspaceapi.CommandResult{}, fmt.Errorf("candidate observation allowed replace refs")
	}
	switch command.Args[3] {
	case r.head + "^{tree}":
		return workspaceapi.CommandResult{Stdout: r.tree}, nil
	case r.candidate + "^{tree}":
		return workspaceapi.CommandResult{Stdout: r.candidateTree}, nil
	default:
		return workspaceapi.CommandResult{}, fmt.Errorf("unknown immutable commit")
	}
}

func TestCandidateHeadReportComposedInstall(t *testing.T) {
	for _, installAuthority := range []bool{false, true} {
		t.Run(fmt.Sprintf("install_authority_%t", installAuthority), func(t *testing.T) {
			testCandidateHeadReportComposedInstall(t, installAuthority)
		})
	}
}

func testCandidateHeadReportComposedInstall(t *testing.T, installAuthority bool) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "candidate-owner", LowerUsername: "candidate-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"candidate-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	hash := sha256.Sum256([]byte("candidate-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,kind,status,vm_id,target_bookmark) VALUES($1,$2,'candidate','container','running','fixture','smithers/candidate') RETURNING id`, repo.ID, owner.ID).Scan(&workspaceID))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	runtime := &candidateHeadRuntime{head: strings.Repeat("a", 40), change: strings.Repeat("z", 32), tree: strings.Repeat("b", 40), candidate: strings.Repeat("c", 40), candidateTree: strings.Repeat("b", 40), operations: map[string]bool{}}
	var itemID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,owner_id,workspace_id,candidate_base,candidate_head,candidate_verified,attempt,generation,checks) VALUES($1,'todo','proposed','Candidate',$2,$3,$4,$5,true,1,3,'{}') RETURNING id::text`, repo.ID, owner.ID, workspaceID, strings.Repeat("d", 40), runtime.candidate).Scan(&itemID))
	priorHead := strings.Repeat("e", 40)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pr_head=$2,
		pending_op=jsonb_build_object('kind','push','target','smithers/candidate','desired',$2::text,'precondition','','state','unknown'),
		checks=jsonb_build_object('land',jsonb_build_object('head',$2::text)) WHERE id=$1`, itemID, priorHead)
	require.NoError(t, err)
	var originalPending []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT pending_op FROM mythical_items WHERE id=$1`, itemID).Scan(&originalPending))
	service := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithWorkspaceRuntime(runtime))
	var machineToken string
	if installAuthority {
		service = services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithWorkspaceRuntime(runtime), services.WithWorkspaceInstallAuthorization(q))
	}
	{
		machineToken = "smithers_" + strings.Repeat("a", 40)
		digest := sha256.Sum256([]byte(machineToken))
		hash := hex.EncodeToString(digest[:])
		token, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "candidate-machine", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], SystemIssued: true,
			Scopes: "write:repository," + middleware.RepositoryRestrictionScope(repo.ID) + "," + middleware.WorkspaceRestrictionScope(workspaceID), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, workspaceID, token.ID)
		require.NoError(t, err)
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, pool, nil, &routes.WorkspaceHandler{Service: service})
	report := func(head string, authenticated bool) *httptest.ResponseRecorder {
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		request := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/repos/candidate-owner/app/workspaces/"+workspaceID+"/head", strings.NewReader(fmt.Sprintf(`{"change_id":%q,"commit_id":%q,"ahead":1,"behind":0}`, runtime.change, head)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", cfg.Server.PublicURL)
		request.Header.Set("X-CSRF-Token", "candidate-csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "candidate-csrf"})
		if authenticated {
			request.Header.Set("Authorization", "Bearer "+machineToken)
		}
		request = request.WithContext(bounded)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.NoError(t, bounded.Err(), "candidate observation must share the publisher transaction")
		return response
	}
	state := func() (bool, int64, string) {
		var verified bool
		var version int64
		var head string
		require.NoError(t, pool.QueryRow(ctx, `SELECT candidate_verified,version FROM mythical_items WHERE id=$1`, itemID).Scan(&verified, &version))
		require.NoError(t, pool.QueryRow(ctx, `SELECT head_commit_id FROM workspaces WHERE id=$1`, workspaceID).Scan(&head))
		return verified, version, head
	}
	denied := report(runtime.head, false)
	require.Equal(t, 404, denied.Code, denied.Body.String())
	require.Zero(t, runtime.calls)
	runtime.host = true
	refused := report(runtime.head, true)
	require.Equal(t, 503, refused.Code, refused.Body.String())
	require.Zero(t, runtime.calls, "a TODO head report cannot execute repository tools on the host")
	runtime.host = false
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op=jsonb_build_object('kind','merge','target','1','desired',$2::text,'precondition','open','state','intended') WHERE id=$1`, itemID, priorHead)
	require.NoError(t, err)
	response := report(runtime.head, true)
	require.Equal(t, 409, response.Code, response.Body.String())
	require.Zero(t, runtime.calls, "a merge fence refuses before snapshotting the working copy")
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pending_op=$2 WHERE id=$1`, itemID, originalPending)
	require.NoError(t, err)
	if installAuthority {
		t.Run("publication lock precedes workspace lock", func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
			_, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repo.ID)
			require.NoError(t, err)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- report(runtime.head, true) }()
			// Observe the blocked production query before testing the other
			// lock. This proves ordering without a scheduling sleep.
			require.Eventually(t, func() bool {
				var waiting bool
				err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%mythical_stacks%FOR UPDATE%')`).Scan(&waiting)
				return err == nil && waiting
			}, 5*time.Second, 10*time.Millisecond)
			_, err = tx.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT`, workspaceID)
			require.NoError(t, err, "a report waiting on publication must not hold the workspace")
			require.NoError(t, tx.Commit(ctx))
			select {
			case response := <-done:
				require.Equal(t, 200, response.Code, response.Body.String())
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
	response = report(runtime.head, true)
	require.Equal(t, 200, response.Code, response.Body.String())
	verified, version, head := state()
	require.True(t, verified, "equal trees preserve verification even with distinct commits")
	require.Equal(t, runtime.head, head)
	response = report(strings.Repeat("e", 40), true)
	require.Equal(t, 409, response.Code, response.Body.String())
	v, revision, h := state()
	require.True(t, v)
	require.Equal(t, version, revision)
	require.Equal(t, head, h)
	runtime.fail = true
	response = report(runtime.head, true)
	require.Equal(t, 409, response.Code, response.Body.String())
	v, revision, h = state()
	require.True(t, v)
	require.Equal(t, version, revision)
	require.Equal(t, head, h)
	runtime.fail = false
	runtime.tree = strings.Repeat("f", 40)
	// A failed head write must roll back its candidate invalidation too.
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_candidate_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'head persistence fault'; END $$;
		CREATE TRIGGER refuse_candidate_head BEFORE UPDATE OF head_commit_id ON workspaces FOR EACH ROW EXECUTE FUNCTION refuse_candidate_head()`)
	require.NoError(t, err)
	response = report(runtime.head, true)
	require.Equal(t, 500, response.Code, response.Body.String())
	v, revision, h = state()
	require.True(t, v)
	require.Equal(t, version, revision)
	require.Equal(t, head, h)
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_candidate_head ON workspaces; DROP FUNCTION refuse_candidate_head()`)
	require.NoError(t, err)
	response = report(runtime.head, true)
	require.Equal(t, 200, response.Code, response.Body.String())
	v, revision, _ = state()
	require.False(t, v)
	require.Equal(t, version+1, revision)
	var retainedHead, retainedCandidate string
	var pending []byte
	var generation int32
	var landCleared bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT pr_head,candidate_head,pending_op,generation,COALESCE(NOT (checks ? 'land'),true) FROM mythical_items WHERE id=$1`, itemID).Scan(&retainedHead, &retainedCandidate, &pending, &generation, &landCleared))
	require.Equal(t, priorHead, retainedHead)
	require.Equal(t, runtime.candidate, retainedCandidate)
	require.JSONEq(t, string(originalPending), string(pending))
	require.EqualValues(t, 3, generation)
	require.True(t, landCleared)
	runtime.tree = runtime.candidateTree
	response = report(runtime.head, true)
	require.Equal(t, 200, response.Code, response.Body.String())
	v, _, _ = state()
	require.False(t, v, "a later equal report cannot restore verification")

	t.Run("unsnapshotted tracked edits reject the previous report", func(t *testing.T) {
		// Real JJ and Git bytes through the same composed HTTP boundary. Only
		// the guest process adapter is test-owned; this is not microVM proof.
		root := t.TempDir()
		jj := func(args ...string) string {
			command := exec.Command("jj", args...)
			command.Dir = root
			out, err := command.CombinedOutput()
			require.NoError(t, err, string(out))
			return strings.TrimSpace(string(out))
		}
		jj("git", "init", "--colocate", ".")
		jj("config", "set", "--repo", "user.name", "Candidate fixture")
		jj("config", "set", "--repo", "user.email", "fixture@example.com")
		file := filepath.Join(root, "tracked.txt")
		require.NoError(t, os.WriteFile(file, []byte("verified\n"), 0600))
		ids := strings.Fields(jj("log", "--no-graph", "-r", "@", "-T", `commit_id ++ " " ++ change_id`))
		require.Len(t, ids, 2)
		runtime.head, runtime.change = ids[0], ids[1]
		runtime.repositoryDir = root
		_, err := pool.Exec(ctx, `UPDATE mythical_items SET candidate_head=$2,candidate_verified=true WHERE id=$1`, itemID, ids[0])
		require.NoError(t, err)
		response := report(ids[0], true)
		require.Equal(t, 200, response.Code, response.Body.String())
		require.NoError(t, os.WriteFile(file, []byte("edited without jj\n"), 0600))
		response = report(ids[0], true)
		require.Equal(t, 409, response.Code, response.Body.String())
		verified, _, head := state()
		require.False(t, verified, "a stale report still invalidates a different authoritative live tree")
		require.Equal(t, ids[0], head, "the stale report never writes a head")
		current := strings.Fields(jj("log", "--no-graph", "-r", "@", "-T", `commit_id ++ " " ++ change_id`))
		require.NotEqual(t, ids[0], current[0])
		response = report(current[0], true)
		require.Equal(t, 200, response.Code, response.Body.String())
		verified, _, head = state()
		require.False(t, verified)
		require.Equal(t, current[0], head)
		bytes, err := os.ReadFile(file)
		require.NoError(t, err)
		require.Equal(t, "edited without jj\n", string(bytes))
	})
}
