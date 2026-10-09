package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// TODO creation, coding, verification, review, person confirmation, squash
// commit, native mirror advancement and private receipt use the installed
// composition. This does not qualify a microVM or Mac install.
func TestDelegatedMergeSettlementNativeInstall(t *testing.T) {
	if os.Getenv("SMITHERS_CONFIRMATION_SETTLEMENT") != "1" {
		t.Skip("set SMITHERS_CONFIRMATION_SETTLEMENT=1 for native Merge settlement")
	}
	r := newRehearsal(t, "SMITHERS_CONFIRMATION_SETTLEMENT", "C-ACC-02", "delegated-settlement-")
	require.True(t, r.setupSource(), r.logs.String())
	require.True(t, r.setupMachine(), r.logs.String())
	require.NoError(t, r.waitStackActive())
	q := db.New(r.pool)
	owner, err := q.GetUserByLowerUsername(r.ctx, "rehearsal-owner")
	require.NoError(t, err)
	repository, err := services.InstallRepositoryID(r.ctx, q)
	require.NoError(t, err)
	session := ""
	for _, cookie := range r.jar.Cookies(mustRehearsalURL(r.origin)) {
		if cookie.Name == "smithers_session" {
			session = cookie.Value
		}
	}
	require.NotEmpty(t, session)
	// Let the ordinary TODO flow produce its accepted candidate and review;
	// no candidate, check result or pull-request row is supplied by this test.
	number, err := r.file("Reviewed greeting", "[FILE greeting.txt] Write Hello in greeting.txt")
	require.NoError(t, err)
	card, err := r.waitTodoWithin(number, j10RunWait, "in_review")
	require.NoError(t, err)
	head := card.PR.Head
	require.NotEmpty(t, head)
	pullNumber := card.PR.Number
	require.Positive(t, pullNumber)
	var waiting struct{ Number int64 }
	require.NoError(t, r.pool.QueryRow(r.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,issue_title,owner_id,created_by,revisions,checks,paused_at)
 VALUES($1,'todo','queued',2,'Held neighbor','Held neighbor',$2,$2,'[{"text":"Retain the launch refusal","acceptance":[]}]','{"todo":true}',now()) RETURNING number`, repository, owner.ID).Scan(&waiting.Number))

	token, err := r.token("repo", "user")
	require.NoError(t, err)
	request, err := http.NewRequestWithContext(r.ctx, "POST", fmt.Sprintf("%s/api/todos/%d/merge", r.origin, number), strings.NewReader(fmt.Sprintf(`{"reviewed_head_sha":%q}`, head)))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "settlement-request")
	response, err := r.fake.Client().Do(request)
	require.NoError(t, err)
	var admitted struct {
		Confirmation string
		State        string
	}
	payload, readErr := io.ReadAll(response.Body)
	require.NoError(t, readErr)
	require.Equal(t, 202, response.StatusCode, string(payload))
	require.NoError(t, json.Unmarshal(payload, &admitted))
	require.NoError(t, response.Body.Close())
	require.Equal(t, 202, response.StatusCode)
	require.Equal(t, "pending", admitted.State)
	// The packaged CLI/skill reaches the same installed Merge confirmation.
	// A full-scope guest credential still cannot merge, and replay keeps the
	// original confirmation rather than creating another approval or effect.
	invoke := packagedTerminalCLIInvoker(t, r.ctx, r.origin, token)
	for range 2 {
		code, receipt := invoke("merge", fmt.Sprintf("T%d", number), "--reviewed_head_sha", head, "--idempotencyKey", "settlement-request")
		require.Equal(t, 3, code, receipt)
		require.Equal(t, admitted.Confirmation, receipt["confirmation"])
		require.Equal(t, "pending", receipt["state"])
	}
	for _, write := range r.fake.Writes() {
		require.False(t, write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge"), "a delegated CLI request cannot merge before the person's press")
	}
	before, err := q.GetMythicalItemByNumber(r.ctx, repository, number)
	require.NoError(t, err)
	require.NotEmpty(t, before.RequestRunID, "coding ran through the engine")
	require.NotEmpty(t, before.VerifyRunID, "verification ran through the engine")
	require.True(t, before.CandidateVerified)
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		row, readErr := q.GetMythicalItemByNumber(context.Background(), repository, number)
		t.Logf("settlement failure: item=%s pending=%s checks=%s error=%v", row.State, row.PendingOp, row.Checks, readErr)
		for _, write := range r.fake.Writes() {
			if strings.HasSuffix(write.Path, "/merge") {
				t.Logf("merge transport: method=%s status=%d body=%s", write.Method, write.Status, write.Body)
			}
		}
		var stack []byte
		_ = r.pool.QueryRow(context.Background(), `SELECT row_to_json(s) FROM mythical_stacks s WHERE repository_id=$1`, repository).Scan(&stack)
		t.Logf("stack: %s", stack)
		var mainPull string
		_ = r.pool.QueryRow(context.Background(), `SELECT row_to_json(p)::text FROM github_main_pulls p WHERE repository_id=$1`, repository).Scan(&mainPull)
		t.Logf("native settlement main pull: %s", mainPull)
		t.Logf("backend: %s", r.stdout.String())
	})
	t.Setenv("SMITHERS_CONFIRMATION_SESSION", session)
	t.Setenv("SMITHERS_CONFIRMATION_REPOSITORY", "rehearsal-owner/app")
	runMergeConfirmationBrowser(t, nil, r.pool, nil, r.server, owner, token, admitted.Confirmation, number, head, before.ID, nil)
	merged, err := r.readFakePull(pullNumber)
	require.NoError(t, err)
	require.True(t, merged.Merged)
	// Confirmation settlement observes GitHub's receipt. The mirror advances
	// separately through GitHub sync; qualify that real completion before
	// comparing its head, rather than racing the next refs poll.
	require.NoError(t, r.waitMerged(number, pullNumber, head))
	completed, err := q.GetMythicalItemByNumber(r.ctx, repository, number)
	require.NoError(t, err)
	require.Empty(t, completed.PendingOp, "settlement clears the merge fence")
	mirror, err := r.repoClient.GetBookmark(r.ctx, owner.Username, "app", "main")
	require.NoError(t, err)
	require.Equal(t, merged.MergeCommitSHA, mirror.TargetCommitID)
	merges := 0
	for _, write := range r.fake.Writes() {
		if write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge") {
			merges++
			require.Equal(t, 200, write.Status)
			var body struct {
				SHA    string
				Method string `json:"merge_method"`
			}
			require.NoError(t, json.Unmarshal(write.Body, &body))
			require.Equal(t, head, body.SHA)
			require.Equal(t, "squash", body.Method)
		}
	}
	require.Equal(t, 1, merges)
	var approved int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM approvals WHERE member_id=$1 AND state='approved'`, owner.ID).Scan(&approved))
	require.Equal(t, 1, approved)
	// A paused queued neighbor must not acquire a machine/run while the
	// reviewed TODO completes its person-approved Merge.
	queued, err := q.GetMythicalItemByNumber(r.ctx, repository, waiting.Number)
	require.NoError(t, err)
	require.Equal(t, "queued", queued.State)
	require.True(t, queued.PausedAt.Valid)
	require.Zero(t, queued.Attempt)
	require.Empty(t, queued.WorkspaceID)
	require.Empty(t, queued.RequestRunID)
}
