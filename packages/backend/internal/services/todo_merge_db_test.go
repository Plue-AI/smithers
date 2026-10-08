package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// mergeOrderCredential mints a system-issued token for user and answers its
// request context as the install's authentication loads it: scopes without
// a via is a run's credential, scopes with one a delegated credential.
func mergeOrderCredential(t *testing.T, h *mergeHarness, user int64, name, scopes string) context.Context {
	t.Helper()
	sum := sha256.Sum256([]byte("c-j4-03-" + name))
	hash := hex.EncodeToString(sum[:])
	_, err := h.q.CreateAccessToken(context.Background(), db.CreateAccessTokenParams{UserID: user, Name: name, TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
		Scopes: scopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	info, err := middleware.ReloadCredential(context.Background(), h.q, middleware.Credential{TokenHash: hash}, time.Now())
	require.NoError(t, err)
	middleware.BindInstallCredential(info)
	return middleware.ContextWithAuthInfo(context.Background(), info)
}

// mergeOrderBlocks is each TODO's merge block as the Home card's TODO list
// serves it, by number.
func mergeOrderBlocks(t *testing.T, h *mergeHarness) map[int64]map[string]any {
	t.Helper()
	views, err := h.service.Todos(context.Background(), h.repoID)
	require.NoError(t, err)
	blocks := map[int64]map[string]any{}
	for _, view := range views {
		raw, err := json.Marshal(view)
		require.NoError(t, err)
		var card struct {
			N     int64          `json:"n"`
			Merge map[string]any `json:"merge"`
		}
		require.NoError(t, json.Unmarshal(raw, &card))
		blocks[card.N] = card.Merge
	}
	return blocks
}

// C-J4-03, integration layer (spec §10.6.1-§10.6.3, mvp.md §4.2, rule 6):
// only the first unmerged item merges and every later item says "Merges
// after Tn". Real PostgreSQL, real git and the GitHub fake recording every
// request; the merge service composed as the install composes it. Owner
// Will (smithers-canary, GitHub rehearsal-owner) and Maintainer Ben have
// browser sessions, Member Alice has one, Ben also holds a delegated
// credential (via claude-code) and a run credential is minted. T1, T2 and
// T3 are in review with green required checks; T1's PR is ready, T2's and
// T3's are drafts (§12.5.1).
func TestTodoMergeOrderPostgres(t *testing.T) {
	h := newMergeHarness(t)
	ctx := context.Background()
	const repo = "rehearsal-owner/app"
	h.fake.RequireCheck("unit")
	green := func(head string) { h.fake.SetCheck(repo, head, "unit", "completed", "success") }
	t1, h1, pr1 := h.first("First")
	t2, h2, pr2 := h.todoInReview("Second", h.item(t1).CandidateHead)
	t3, h3, pr3 := h.todoInReview("Third", h.item(t2).CandidateHead)
	require.Equal(t, []int64{1, 2, 3}, []int64{t1, t2, t3}, "the literal Tn below name these TODOs")
	for _, head := range []string{h1, h2, h3} {
		green(head)
	}
	require.False(t, h.pull(pr1).Draft, "the first item's PR is ready")
	require.True(t, h.pull(pr2).Draft, "later items' PRs are drafts")
	require.True(t, h.pull(pr3).Draft, "later items' PRs are drafts")

	h.fake.SetCollaborator(8, "ben", "maintain")
	ben, benSession := h.person("ben", 8)
	h.exec(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES ($1,$2,'admin')`, h.repoID, ben)
	h.fake.SetCollaborator(9, "alice", "write")
	alice, aliceSession := h.person("alice", 9)
	h.exec(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES ($1,$2,'write')`, h.repoID, alice)
	benDelegated := mergeOrderCredential(t, h, ben, "ben-claude-code", "read:repository,write:repository,via:claude-code")
	require.Equal(t, middleware.CredentialDelegated, middleware.AuthInfoFromContext(benDelegated).CredentialKind())
	run := mergeOrderCredential(t, h, h.userID, "todo-run", "read:repository,write:repository")
	require.Equal(t, middleware.CredentialAgentRun, middleware.AuthInfoFromContext(run).CredentialKind())
	approvals := NewApprovalsService(h.q, WithConfirmationTodos(h.pool, h.service))

	presses := 0
	merge := func(as context.Context, user, n int64, head string) error {
		presses++
		_, err := h.service.MergeTodo(as, h.repoID, user, n, MythicalMergeInput{Head: head, Request: fmt.Sprintf("c-j4-03-%d", presses)})
		return err
	}
	// quiet asserts a refused request recorded no approval or fence on any
	// TODO and GitHub received no merge call.
	quiet := func(t *testing.T) {
		t.Helper()
		for _, n := range []int64{t1, t2, t3} {
			item := h.item(n)
			assert.Nil(t, mythicalChecksOf(item).Land, "T%d", n)
			assert.Empty(t, item.PendingOp, "T%d", n)
		}
		assert.Empty(t, h.merges(), "a refused request never reaches GitHub's merge")
	}
	conflict := func(code, message string) TodoControlError {
		return TodoControlError{Status: http.StatusConflict, Code: code, Class: "conflict", Message: message}
	}
	refusedPermission := TodoControlError{Status: http.StatusForbidden, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}

	// Step 9's service projection, before any merge: only T1 is ready.
	assert.Equal(t, map[int64]map[string]any{
		1: {"state": "ready", "on_github": true},
		2: {"state": "waiting", "reason": "order", "detail": "T1", "on_github": true},
		3: {"state": "waiting", "reason": "order", "detail": "T1", "on_github": true},
	}, mergeOrderBlocks(t, h))

	t.Run("step 1: a later item merges after T1", func(t *testing.T) {
		assert.Equal(t, conflict("order", "Merges after T1"), *refusalOf(t, merge(benSession, ben, t2, h2)))
		quiet(t)
	})

	t.Run("step 2: a stale head is refused", func(t *testing.T) {
		stale := h.item(t1).CandidateHead // the verified candidate, not the head GitHub serves
		require.NotEqual(t, h1, stale)
		var refusal *MythicalStaleHeadError
		require.ErrorAs(t, merge(benSession, ben, t1, stale), &refusal)
		assert.Equal(t, conflict("stale_head", "the pull request changed since you saw it"), refusal.TodoControlError)
		assert.Equal(t, h1, refusal.CurrentHead, "the PR head is reported, never substituted")
		quiet(t)
	})

	t.Run("step 3: only a maintainer's session merges", func(t *testing.T) {
		reads := len(h.fake.Reads())
		assert.Equal(t, refusedPermission, *refusalOf(t, merge(aliceSession, alice, t1, h1)), "a Member's session")
		assert.Equal(t, refusedPermission, *refusalOf(t, merge(run, h.userID, t1, h1)), "a run's credential")
		assert.Equal(t, refusedPermission, *refusalOf(t, merge(benDelegated, ben, t1, h1)), "a delegated credential never enters the merge")
		assert.Len(t, h.fake.Reads(), reads, "authorization refusals read nothing on GitHub")
		input := ConfirmationInput{Command: "merge", Subject: json.RawMessage(`{"kind":"todo","ref":"T1"}`), Payload: json.RawMessage(fmt.Sprintf(`{"reviewed_head_sha":%q}`, h1)), Key: "ben-delegated-merge"}
		_, err := approvals.RequestConfirmation(run, input)
		requireConfirmationCode(t, err, "permission")
		// Ben's delegated credential asks Ben for a Review & merge
		// confirmation: the 202 body is its id and state alone (§6.2.2).
		receipt, err := approvals.RequestConfirmation(benDelegated, input)
		require.NoError(t, err)
		body, err := json.Marshal(receipt)
		require.NoError(t, err)
		assert.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"pending"}`, receipt.ID), string(body))
		var member int64
		var kind, command, head, state string
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT member_id,kind,command,reviewed_head_sha,state FROM approvals WHERE id=$1`, receipt.ID).Scan(&member, &kind, &command, &head, &state))
		assert.Equal(t, []any{ben, "review_merge", "merge", h1, "pending"}, []any{member, kind, command, head, state}, "on Ben's confirmations topic")
		quiet(t)
	})

	t.Run("step 4: a failing required check is refused by name", func(t *testing.T) {
		h.fake.SetCheck(repo, h1, "unit", "completed", "failure")
		assert.Equal(t, conflict("checks", "unit"), *refusalOf(t, merge(benSession, ben, t1, h1)))
		quiet(t)
		green(h1)
	})

	t.Run("step 5: open stack attention blocks the merge", func(t *testing.T) {
		require.NoError(t, pgx.BeginFunc(ctx, h.service.store, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, h.repoID); err != nil {
				return err
			}
			return appendOrderAttention(ctx, tx, h.repoID, OrderAttentionEntry{Pull: pr3, Commit: h3, Text: "T3's PR was merged on GitHub out of order"})
		}))
		open, err := h.service.StackAttention(benSession, h.repoID, ben)
		require.NoError(t, err)
		require.Len(t, open, 1)
		assert.Equal(t, conflict("attention", fmt.Sprintf("Stack attention %s is open", open[0].ID)), *refusalOf(t, merge(benSession, ben, t1, h1)))
		quiet(t)
		require.NoError(t, h.service.OrderOK(benSession, h.repoID, open[0].ID, open[0].Revision))
		open, err = h.service.StackAttention(benSession, h.repoID, ben)
		require.NoError(t, err)
		require.Empty(t, open)
	})

	const sentence = "At least 1 approving review is required by reviewers with write access."
	t.Run("step 6: GitHub's refusal is shown in its own words", func(t *testing.T) {
		h.fake.RefuseNextMerge(repo, pr1, githubfake.Refusal{Status: http.StatusMethodNotAllowed, Message: sentence})
		require.NoError(t, merge(benSession, ben, t1, h1))
		key := fmt.Sprintf("c-j4-03-%d", presses)
		h.pass()
		calls := h.merges()
		require.Len(t, calls, 1)
		assert.Equal(t, http.StatusMethodNotAllowed, calls[0].Status)
		item := h.item(t1)
		assert.Empty(t, item.PendingOp, "a definitive refusal clears the fence")
		land := mythicalChecksOf(item).Land
		require.NotNil(t, land)
		require.NotNil(t, land.Refused)
		assert.Equal(t, []string{"github_refused", "github", sentence}, []string{land.Refused.Code, land.Refused.Class, land.Refused.Message})
		_, block := h.mergeCard(t1)
		assert.Equal(t, map[string]any{"state": "blocked", "reason": "github", "detail": sentence, "on_github": true}, block)
		var refusal *TodoGitHubRefusal
		_, err := h.service.MergeTodo(benSession, h.repoID, ben, t1, MythicalMergeInput{Head: h1, Request: key})
		require.ErrorAs(t, err, &refusal)
		assert.Equal(t, []string{"github", "github_refused", sentence}, []string{refusal.Class, refusal.Code, refusal.Message}, "GitHub's sentence verbatim, never a generic one")
		assert.Equal(t, "proposed", h.item(t1).State, "T1 stays in review")
		h.pass()
		assert.Len(t, h.merges(), 1, "a definitive refusal never retries itself")
	})

	t.Run("step 7: Ben's session merges T1 at H1", func(t *testing.T) {
		before := len(h.merges())
		require.NoError(t, merge(benSession, ben, t1, h1))
		land := h.land(t1)
		require.NotNil(t, land)
		assert.Nil(t, land.Refused)
		assert.Equal(t, []any{"ben", int64(8), h.item(t1).Generation, middleware.AuthInfoFromContext(benSession).SessionHash, h1},
			[]any{land.By, land.Account, land.Generation, land.Session, land.Head}, "one checks.Land: Ben, his session credential, H1")
		h.pass()
		calls := h.merges()[before:]
		require.Len(t, calls, 1)
		assert.Equal(t, fmt.Sprintf("/repos/%s/pulls/%d/merge", repo, pr1), calls[0].Path)
		assert.Equal(t, http.StatusOK, calls[0].Status)
		var sent struct {
			SHA    string `json:"sha"`
			Method string `json:"merge_method"`
		}
		require.NoError(t, json.Unmarshal(calls[0].Body, &sent))
		assert.Equal(t, []string{h1, "squash"}, []string{sent.SHA, sent.Method})
		state, block := h.mergeCard(t1)
		assert.Equal(t, "merged", state)
		assert.Equal(t, map[string]any{"state": "done", "on_github": true}, block)
		assert.Equal(t, "waiting", mergeOrderBlocks(t, h)[3]["state"])
		assert.Equal(t, "T2", mergeOrderBlocks(t, h)[3]["detail"], "T3 now merges after T2")
	})

	// Step 8 runs through the composed install in
	// TestTodoPreapprovalProductionRebaseComposed. Native rebase, real check
	// launches and HTTP stale-head refusal replace fixture-supplied candidates.

	writeMergeOrderEvidence(t, h, []int64{t1, t2, t3})
}

// writeMergeOrderEvidence keeps C-J4-03's integration evidence: GitHub's
// request log and the checks.Land and approvals rows.
func writeMergeOrderEvidence(t *testing.T, h *mergeHarness, todos []int64) {
	t.Helper()
	lands := map[string]any{}
	for _, n := range todos {
		lands[fmt.Sprintf("T%d", n)] = mythicalChecksOf(h.item(n)).Land
	}
	rows, err := h.pool.Query(context.Background(), `SELECT row_to_json(a)::text FROM approvals a ORDER BY created_at`)
	require.NoError(t, err)
	approvals := []json.RawMessage{}
	for rows.Next() {
		var row string
		require.NoError(t, rows.Scan(&row))
		approvals = append(approvals, json.RawMessage(row))
	}
	require.NoError(t, rows.Err())
	raw, err := json.MarshalIndent(map[string]any{"github_writes": h.fake.Writes(), "github_reads": h.fake.Reads(), "checks_land": lands, "approvals": approvals}, "", "  ")
	require.NoError(t, err)
	dir := filepath.Join("../../../..", ".artifacts/checks/C-J4-03", time.Now().UTC().Format("20060102T150405.000000000Z"))
	require.NoError(t, os.MkdirAll(dir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "integration.json"), raw, 0o600))
}
