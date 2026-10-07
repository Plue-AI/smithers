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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	repositoryapi "github.com/smithersai/smithers/packages/backend/repository"
	"github.com/stretchr/testify/require"
)

// Real native mirror, PostgreSQL, snapshot reader, admission and install HTTP.
// Trusted-process admission is test-only; no VM/root qualification is claimed.
func TestBranchAddComposedInstall(t *testing.T) {
	for _, remove := range []string{"", "confirm-after", "confirm-default", "membership", "authorize", "lane", "microvm", "identity", "capture", "awake"} {
		t.Run("provider-"+remove, func(t *testing.T) { runBranchAddComposed(t, remove) })
	}
}
func TestFreshForkCreatedThroughInstall(t *testing.T) { runBranchAddComposed(t, "fresh-fork") }
func runBranchAddComposed(t *testing.T, remove string) {
	placement := "before"
	if strings.HasPrefix(remove, "confirm-") {
		placement = strings.TrimPrefix(remove, "confirm-")
		remove = ""
	}
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	t.Setenv("SMITHERS_FEATURE_FLAGS_WORKSPACES", "true")
	t.Setenv("SMITHERS_FEATURE_FLAGS_SANDBOXES", "true")
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	cookie := "add-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	root := t.TempDir()
	storage := repositoryapi.Config{StoragePath: filepath.Join(root, "repositories"), AuthToken: "adoption", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH")}
	local, err := repositoryapi.OpenLocal(storage)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	source, store := filepath.Join(root, "source"), storage.GitBackendPath("ben", "demo")
	git := func(args ...string) string {
		out, err := hostexec.Git(ctx, append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "core.hooksPath=/dev/null"}, args...)...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	git("init", "--initial-branch=main", source)
	require.NoError(t, os.WriteFile(filepath.Join(source, "base.txt"), []byte("main\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "base")
	base := git("-C", source, "rev-parse", "HEAD")
	require.NoError(t, os.WriteFile(filepath.Join(source, "scratch.txt"), []byte("fixed scratch bytes\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "scratch")
	head := git("-C", source, "rev-parse", "HEAD")
	require.NoError(t, local.Client().InitRepo(ctx, "ben", "demo", "main", false))
	git("-C", store, "fetch", source, "+refs/heads/*:refs/heads/*")
	git("-C", store, "update-ref", "refs/heads/main", base)
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, TargetBookmark: "scratch/ben/try", Status: "stopped"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET is_fork=true,forked_from_base=$1,source_commit=$1,head_commit_id=$2,vm_id='asleep-fixture' WHERE id=$3`, base, head, workspace.ID)
	require.NoError(t, err)
	git("-C", store, "update-ref", "refs/heads/scratch/ben/try", head)
	git("-C", store, "update-ref", repohost.BranchHeadRef(workspace.ID), head)
	require.NoError(t, local.Client().ImportRefs(ctx, "ben", "demo"))
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state,landed_main) VALUES($1,$2,'active',$3)`, repo.ID, owner.ID, base)
	require.NoError(t, err)
	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 2, OutputLimit: 1 << 20})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	providers := rehearsalBranchMachines(pool)
	switch remove {
	case "membership":
		providers.Membership = nil
	case "authorize":
		providers.Authorize = nil
	case "lane":
		providers.LaneBinding = nil
	case "microvm":
		providers.MicroVM = nil
	case "identity":
		providers.SessionIdentity = nil
	case "capture":
		git("-C", store, "update-ref", "-d", repohost.BranchHeadRef(workspace.ID))
		require.NoError(t, local.Client().ImportRefs(ctx, "ben", "demo"))
	case "awake":
		_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, workspace.ID)
		require.NoError(t, err)
	}
	handler := startSplitProcess(t, Options{Repository: local.Client(), ChatHost: unusedChatHost{}, Workspace: runtime, BranchMachines: providers, FlowHostProductAPIURL: "http://127.0.0.1:4000"})
	call := func(body, key, session string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "http://127.0.0.1:4000/api/branches/scratch%2Fben%2Ftry/add-to-stack", strings.NewReader(body))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		request.Header.Set("Origin", "http://127.0.0.1:4000")
		request.Header.Set("X-CSRF-Token", "add-csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "add-csrf"})
		if session != "" {
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	if remove == "fresh-fork" {
		request := httptest.NewRequest("POST", "http://127.0.0.1:4000/api/branches", strings.NewReader(`{"from":"main","name":"fresh"}`))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "http://127.0.0.1:4000")
		request.Header.Set("X-CSRF-Token", "fresh-csrf")
		request.Header.Set("Idempotency-Key", "fresh-fork")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "fresh-csrf"})
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		for range 2 {
			copy := request.Clone(ctx)
			copy.Body = io.NopCloser(strings.NewReader(`{"from":"main","name":"fresh"}`))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, copy)
			require.Equal(t, 201, response.Code, response.Body.String())
			var receipt struct {
				Name       string
				ForkedFrom struct{ Commit, Base string } `json:"forked_from"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &receipt))
			require.Equal(t, "scratch/ben/fresh", receipt.Name)
			require.Equal(t, base, receipt.ForkedFrom.Commit)
			require.Equal(t, base, receipt.ForkedFrom.Base)
		}
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces`).Scan(&count))
		require.Equal(t, 2, count)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.fork.completed'`).Scan(&count))
		require.Equal(t, 1, count)
		// A fresh retained hosted caller resolves main through the same writer.
		sourceRow, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: "main", TargetBookmark: "main", Status: "running"})
		require.NoError(t, err)
		hosted := request.Clone(ctx)
		hosted.URL.Path = "/api/repos/ben/demo/workspaces/" + sourceRow.ID + "/fork"
		hosted.Header.Set("Idempotency-Key", "hosted-fresh")
		hosted.Body = io.NopCloser(strings.NewReader(`{"name":"hosted-fresh"}`))
		hostedResponse := httptest.NewRecorder()
		handler.ServeHTTP(hostedResponse, hosted)
		require.Equal(t, 201, hostedResponse.Code, hostedResponse.Body.String())
		retainedSource, err := q.GetWorkspace(ctx, sourceRow.ID)
		require.NoError(t, err)
		require.Equal(t, "running", retainedSource.Status)
		var hostedReceipt struct {
			ID             string
			TargetBookmark string `json:"target_bookmark"`
		}
		require.NoError(t, json.Unmarshal(hostedResponse.Body.Bytes(), &hostedReceipt))
		hostedChild, err := q.GetWorkspace(ctx, hostedReceipt.ID)
		require.NoError(t, err)
		require.Equal(t, base, hostedChild.SourceCommit)
		require.Equal(t, "scratch/ben/hosted-fresh", hostedChild.TargetBookmark)
		return
	}
	if remove != "" {
		response := call(`{"text":"Keep scratch"}`, "refused", cookie)
		require.Equal(t, 503, response.Code, response.Body.String())
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
		require.Zero(t, count)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces`).Scan(&count))
		require.Equal(t, 1, count)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.added-to-stack'`).Scan(&count))
		require.Zero(t, count)
		require.Equal(t, head, git("-C", store, "rev-parse", "refs/heads/scratch/ben/try"))
		return
	}
	require.Equal(t, 401, call(`{"text":"Keep scratch"}`, "unauth", "").Code)
	invalid := call(`{"text":"Keep scratch","after":1,"before":2}`, "both", cookie)
	require.Equal(t, 400, invalid.Code, invalid.Body.String())
	for range 2 {
		response := call(`{"text":"Keep scratch"}`, "adopt", cookie)
		require.Equal(t, 202, response.Code, response.Body.String())
		var receipt map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &receipt))
		require.EqualValues(t, 1, receipt["n"])
	}
	row, err := q.GetWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	require.Equal(t, "smithers/try-"+workspace.ID, row.TargetBookmark)
	item, err := q.GetMythicalItemByNumber(ctx, repo.ID, 1)
	require.NoError(t, err)
	require.Equal(t, workspace.ID, item.WorkspaceID)
	var seed struct {
		Seed struct{ Base, Head, Diff string }
	}
	require.NoError(t, json.Unmarshal(item.Checks, &seed))
	require.Equal(t, base, seed.Seed.Base)
	require.Contains(t, seed.Seed.Diff, "+fixed scratch bytes")
	require.Equal(t, "fixed scratch bytes", git("-C", store, "show", seed.Seed.Head+":scratch.txt"))
	require.Equal(t, base, git("-C", store, "rev-parse", seed.Seed.Head+"^"))

	// The delegated catalog HTTP door persists a private confirmation, then the
	// person's browser press consumes exactly that branch/head in the transaction.
	confirmed, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, TargetBookmark: "scratch/ben/confirmed", Status: "stopped"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET is_fork=true,forked_from_base=$1,source_commit=$1,head_commit_id=$2,vm_id='asleep-confirm',forked_from_item=$4 WHERE id=$3`, base, head, confirmed.ID, item.ID)
	require.NoError(t, err)
	git("-C", store, "update-ref", "refs/heads/"+confirmed.TargetBookmark, head)
	git("-C", store, "update-ref", repohost.BranchHeadRef(confirmed.ID), head)
	require.NoError(t, local.Client().ImportRefs(ctx, "ben", "demo"))
	token := "smithers_" + strings.Repeat("c", 40)
	tokenSum := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(tokenSum[:])
	scopes := []string{"read:repository", "write:repository"}
	scopes = append(scopes, middleware.DelegationScopes(middleware.Delegation{Via: "codex"})...)
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "delegated", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: strings.Join(scopes, ","), SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	agentPayload := `{"text":"Confirmed scratch","before":1}`
	expectedPlace := int64(1)
	if placement == "after" {
		agentPayload, expectedPlace = `{"text":"Confirmed scratch","after":1}`, 2
	} else if placement == "default" {
		agentPayload, expectedPlace = `{"text":"Confirmed scratch"}`, 2
	}
	agentRequest := httptest.NewRequest("POST", "http://127.0.0.1:4000/api/branches/scratch%2Fben%2Fconfirmed/add-to-stack", strings.NewReader(agentPayload))
	agentRequest.RemoteAddr = "127.0.0.1:12345"
	agentRequest.Header.Set("Authorization", "Bearer "+token)
	agentRequest.Header.Set("Content-Type", "application/json")
	agentRequest.Header.Set("Idempotency-Key", "agent-add")
	pending := httptest.NewRecorder()
	handler.ServeHTTP(pending, agentRequest)
	require.Equal(t, 202, pending.Code, pending.Body.String())
	var ask struct {
		ID    string `json:"confirmation"`
		State string `json:"state"`
	}
	require.NoError(t, json.Unmarshal(pending.Body.Bytes(), &ask))
	require.Equal(t, "pending", ask.State)
	var beforeCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&beforeCount))
	require.Equal(t, 1, beforeCount)
	var subject, payload []byte
	var revision string
	require.NoError(t, pool.QueryRow(ctx, `SELECT subject,revision,payload FROM approvals WHERE id=$1`, ask.ID).Scan(&subject, &revision, &payload))
	var card struct {
		Input struct{ Before, After *int64 }
		Card  struct {
			Subject struct{ Kind, Ref, Revision string }
		}
	}
	require.NoError(t, json.Unmarshal(payload, &card))
	require.Equal(t, "branch", card.Card.Subject.Kind)
	require.Equal(t, confirmed.TargetBookmark, card.Card.Subject.Ref)
	if placement == "before" {
		require.EqualValues(t, 1, *card.Input.Before)
		require.Nil(t, card.Input.After)
	} else if placement == "after" {
		require.EqualValues(t, 1, *card.Input.After)
		require.Nil(t, card.Input.Before)
	} else {
		require.Nil(t, card.Input.Before)
		require.Nil(t, card.Input.After)
	}
	pressBody, _ := json.Marshal(map[string]any{"subject": json.RawMessage(subject), "revision": revision})
	press := httptest.NewRequest("POST", "http://127.0.0.1:4000/api/confirmations/"+ask.ID+"/approve", strings.NewReader(string(pressBody)))
	press.RemoteAddr = "127.0.0.1:12345"
	press.Header.Set("Origin", "http://127.0.0.1:4000")
	press.Header.Set("X-CSRF-Token", "add-csrf")
	press.Header.Set("Content-Type", "application/json")
	press.Header.Set("Idempotency-Key", "person-confirm")
	press.AddCookie(&http.Cookie{Name: "__csrf", Value: "add-csrf"})
	press.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
	// A capture arriving after the card was prepared invalidates its revision.
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$1 WHERE id=$2`, base, confirmed.ID)
	require.NoError(t, err)
	git("-C", store, "update-ref", repohost.BranchHeadRef(confirmed.ID), base)
	require.NoError(t, local.Client().ImportRefs(ctx, "ben", "demo"))
	stalePress := press.Clone(ctx)
	stalePress.Body = io.NopCloser(strings.NewReader(string(pressBody)))
	stale := httptest.NewRecorder()
	handler.ServeHTTP(stale, stalePress)
	require.Equal(t, 409, stale.Code, stale.Body.String())
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$1 WHERE id=$2`, head, confirmed.ID)
	require.NoError(t, err)
	git("-C", store, "update-ref", repohost.BranchHeadRef(confirmed.ID), head)
	require.NoError(t, local.Client().ImportRefs(ctx, "ben", "demo"))
	// Once stale, the person needs a newly prepared card for the restored head.
	freshRequest := agentRequest.Clone(ctx)
	freshRequest.Body = io.NopCloser(strings.NewReader(agentPayload))
	freshRequest.Header.Set("Idempotency-Key", "agent-add-fresh")
	freshPending := httptest.NewRecorder()
	handler.ServeHTTP(freshPending, freshRequest)
	require.Equal(t, 202, freshPending.Code, freshPending.Body.String())
	require.NoError(t, json.Unmarshal(freshPending.Body.Bytes(), &ask))
	require.NoError(t, pool.QueryRow(ctx, `SELECT subject,revision FROM approvals WHERE id=$1`, ask.ID).Scan(&subject, &revision))
	pressBody, _ = json.Marshal(map[string]any{"subject": json.RawMessage(subject), "revision": revision})
	press.URL.Path = "/api/confirmations/" + ask.ID + "/approve"
	press.Body = io.NopCloser(strings.NewReader(string(pressBody)))
	// Consumption and adoption share one transaction, even when a retained
	// ref write succeeded before the activity store failed.
	_, err = pool.Exec(ctx, `CREATE FUNCTION fail_confirm_add() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='branch.added-to-stack' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_confirm_add BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION fail_confirm_add()`)
	require.NoError(t, err)
	failed := httptest.NewRecorder()
	retryPress := press.Clone(ctx)
	retryPress.Body = io.NopCloser(strings.NewReader(string(pressBody)))
	handler.ServeHTTP(failed, retryPress)
	require.GreaterOrEqual(t, failed.Code, 500, failed.Body.String())
	var confirmationState string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, ask.ID).Scan(&confirmationState))
	require.Equal(t, "pending", confirmationState)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&beforeCount))
	require.Equal(t, 1, beforeCount)
	_, err = pool.Exec(ctx, `DROP TRIGGER fail_confirm_add ON product_job_events; DROP FUNCTION fail_confirm_add()`)
	require.NoError(t, err)
	approved := httptest.NewRecorder()
	handler.ServeHTTP(approved, press)
	require.Equal(t, 200, approved.Code, approved.Body.String())
	confirmedItem, err := q.GetMythicalItemByNumber(ctx, repo.ID, 2)
	require.NoError(t, err)
	require.Equal(t, confirmed.ID, confirmedItem.WorkspaceID)
	require.EqualValues(t, expectedPlace, confirmedItem.StackPosition.Int64)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces`).Scan(&count))
	require.Equal(t, 2, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.added-to-stack'`).Scan(&count))
	require.Equal(t, 2, count)
	require.Equal(t, 409, call(`{"text":"Different"}`, "adopt", cookie).Code)
	// The composed Drop door folds the adopted child before source removal.
	item, err = q.GetMythicalItemByNumber(ctx, repo.ID, 1)
	require.NoError(t, err)
	item.CandidateBase, item.CandidateHead, item.CandidateVerified, item.State = base, seed.Seed.Head, true, "proposed"
	_, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	for range 2 {
		drop := httptest.NewRequest("POST", "http://127.0.0.1:4000/api/todos/1", strings.NewReader(`{"op":"drop"}`))
		drop.RemoteAddr = "127.0.0.1:12345"
		drop.Header = press.Header.Clone()
		drop.Header.Set("Idempotency-Key", "drop-source")
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, drop)
		require.Equal(t, 202, result.Code, result.Body.String())
	}
	confirmedItem, err = q.GetMythicalItemByNumber(ctx, repo.ID, 2)
	require.NoError(t, err)
	var folded struct{ Seed struct{ Base, Head string } }
	require.NoError(t, json.Unmarshal(confirmedItem.Checks, &folded))
	require.Equal(t, base, folded.Seed.Base)
	require.Equal(t, "fixed scratch bytes", git("-C", store, "show", folded.Seed.Head+":scratch.txt"))
	require.EqualValues(t, 1, confirmedItem.StackPosition.Int64)

}
