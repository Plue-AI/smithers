package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// HeadCheckFacts answers ci[sha] as one required check, none when green.
func (g *fakeMythicalGitHub) HeadCheckFacts(_ context.Context, _ mythicalGitHubRepo, sha string) ([]mythicalHeadCheck, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if verdict, ok := g.ci[sha]; ok && verdict != mythicalCIGreen {
		return []mythicalHeadCheck{{Name: "ci", State: verdict, Required: true}}, nil
	}
	return []mythicalHeadCheck{}, nil
}

// ReviewDecision answers that main requires no review.
func (g *fakeMythicalGitHub) ReviewDecision(context.Context, mythicalGitHubRepo, int64) (string, error) {
	return "", nil
}

// mergePolicy is a committed factory projection: maintainers names the
// policy's maintainers, none naming every GitHub maintainer.
func mergePolicy(maintainers ...string) policyHost {
	github := map[string]any{}
	if len(maintainers) > 0 {
		github["maintainers"] = maintainers
	}
	raw, _ := json.Marshal(map[string]any{"on": []any{}, "github": github})
	return policyHost{string(raw)}
}

// mergeHarness is the install after setup, composed as production composes
// it (EnableTodoPublication: every outbound guard, MergeDecision and the
// App's lookup, send and settlement): the owner, GitHub account 7
// rehearsal-owner, signed in with a browser session; the App installed on
// rehearsal-owner/app; the stack active. GitHub is githubfake over a real
// bare repository with no branch protection until a test adds it; Smithers'
// side is real PostgreSQL and real git. A TODO reaches review through
// publication, never through SQL.
type mergeHarness struct {
	*publicationFixture
	q       *db.Queries
	session string
	// ctx is the owner's browser session.
	ctx context.Context
	// presses numbers each press's Idempotency-Key.
	presses int
}

func newMergeHarness(t *testing.T) *mergeHarness {
	t.Helper()
	f := newPublicationFixture(t, false)
	f.service.SetPolicyReader(mergePolicy())
	h := &mergeHarness{publicationFixture: f, q: db.New(f.pool)}
	digest := sha256.Sum256([]byte("owner-browser-session"))
	h.session = hex.EncodeToString(digest[:])
	h.exec(`INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,'smithers-canary',NOW() + interval '1 hour')`, h.session, f.userID)
	h.ctx = h.as(&middleware.AuthInfo{User: &db.User{ID: f.userID, Username: "smithers-canary"}, SessionHash: h.session})
	return h
}

func (h *mergeHarness) exec(sql string, args ...any) {
	h.t.Helper()
	_, err := h.pool.Exec(context.Background(), sql, args...)
	require.NoError(h.t, err)
}

func (h *mergeHarness) as(info *middleware.AuthInfo) context.Context {
	return middleware.ContextWithAuthInfo(context.Background(), info)
}

// press is a person's Review & merge of TODO n at head, a new request with
// its own Idempotency-Key.
func (h *mergeHarness) press(ctx context.Context, n int64, head string) error {
	h.presses++
	return h.pressAs(ctx, fmt.Sprintf("press-%d", h.presses), n, head)
}

// pressAs is a press with the Idempotency-Key key.
func (h *mergeHarness) pressAs(ctx context.Context, key string, n int64, head string) error {
	_, err := h.service.MergeTodo(ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head, Request: key})
	return err
}

// todoInReview files a TODO through FileTodo, makes its candidate a run's
// verified result on base and lets the stack publish it: the App pushes its
// branch and opens its pull request, and the TODO is in review. It answers
// the TODO's number, its pull request head and number.
func (h *mergeHarness) todoInReview(title, base string) (int64, string, int64) {
	h.t.Helper()
	slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))
	todo := h.todo(title, "Do "+title, base, slug+".md", title+"\n")
	h.wake()
	item := h.item(todo.Number.Int64)
	require.Equal(h.t, "proposed", item.State, item.Reason)
	require.Equal(h.t, "in_review", todoState(item))
	return item.Number.Int64, item.PRHead, item.PRNumber.Int64
}

// first is the first TODO in review on main.
func (h *mergeHarness) first(title string) (int64, string, int64) {
	return h.todoInReview(title, h.main)
}

func (h *mergeHarness) pass() { h.wake() }

func (h *mergeHarness) mergeCard(number int64) (string, map[string]any) {
	h.t.Helper()
	card, err := h.service.Todo(context.Background(), h.repoID, number)
	require.NoError(h.t, err)
	return card["state"].(string), card["merge"].(map[string]any)
}

// merges are GitHub's received merge requests.
func (h *mergeHarness) merges() []githubfake.Write {
	out := []githubfake.Write{}
	for _, write := range h.fake.Writes() {
		if write.Method == http.MethodPut && strings.HasSuffix(write.Path, "/merge") {
			out = append(out, write)
		}
	}
	return out
}

func (h *mergeHarness) operation(number int64) MythicalOutboundOp {
	h.t.Helper()
	item := h.item(number)
	if len(item.PendingOp) == 0 {
		return MythicalOutboundOp{}
	}
	op, err := decodeMythicalOutbound(item.PendingOp)
	require.NoError(h.t, err)
	return op
}

func (h *mergeHarness) land(number int64) *mythicalLand {
	return mythicalChecksOf(h.item(number)).Land
}

// push puts a person's commit on the TODO's branch on GitHub, as a push
// from their laptop would; the open pull request follows it.
func (h *mergeHarness) push(number int64, content string) string {
	h.t.Helper()
	branch := "refs/heads/" + mythicalChecksOf(h.item(number)).Branch
	h.git(h.work, "fetch", "-q", h.github, branch)
	h.git(h.work, "checkout", "-q", "FETCH_HEAD")
	commit := h.commit("person's push "+content, "PERSON.md", content)
	h.git(h.work, "push", "-q", h.github, commit+":"+branch)
	return commit
}

// unfenced asserts no approval or fence was recorded and GitHub received no
// merge.
func (h *mergeHarness) unfenced(number int64) {
	h.t.Helper()
	item := h.item(number)
	assert.Nil(h.t, mythicalChecksOf(item).Land)
	assert.Empty(h.t, item.PendingOp)
	assert.Empty(h.t, h.merges())
}

// refused asserts dispatch sent no merge, cleared the fence and kept the
// refusal on the approval.
func (h *mergeHarness) refused(number int64, code, message string) {
	h.t.Helper()
	assert.Empty(h.t, h.merges())
	item := h.item(number)
	assert.Empty(h.t, item.PendingOp, "the refusal clears the fence")
	land := mythicalChecksOf(item).Land
	require.NotNil(h.t, land)
	require.NotNil(h.t, land.Refused, "the refusal is kept on the approval")
	assert.Equal(h.t, []string{code, message}, []string{land.Refused.Code, land.Refused.Message})
}

// person signs a second Smithers user in with a browser session, linked to
// GitHub account id, and answers their id and request context.
func (h *mergeHarness) person(login string, id int64) (int64, context.Context) {
	h.t.Helper()
	var userID int64
	require.NoError(h.t, h.pool.QueryRow(context.Background(), `INSERT INTO users(username,lower_username,is_active) VALUES ($1,$1,true) RETURNING id`, login).Scan(&userID))
	h.exec(`INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id) VALUES ($1,$2,'github',$3)`, 100+id, userID, strconv.FormatInt(id, 10))
	digest := sha256.Sum256([]byte(login + "-browser-session"))
	session := hex.EncodeToString(digest[:])
	h.exec(`INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,$3,NOW() + interval '1 hour')`, session, userID, login)
	return userID, h.as(&middleware.AuthInfo{User: &db.User{ID: userID, Username: login}, SessionHash: session})
}

func refusalOf(t *testing.T, err error) *TodoControlError {
	t.Helper()
	var refusal *TodoControlError
	require.ErrorAs(t, err, &refusal)
	return refusal
}

// A browser-session owner merges a TODO on a default repository, one whose
// main has no branch protection (GitHub answers 404 for it): the press records
// one session approval for the generation and reviewed head with the fence,
// and the worker sends exactly one sha-bound squash merge through the App,
// with a token holding contents:write only and a commit message rendered
// from the TODO Smithers holds, never the pull request as edited on GitHub
// since. The TODO is Merged only once GitHub reports it and main has it.
func TestMythicalMergeTodoSquashesAtTheReviewedHead(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Add a greeting")
	state, merge := h.mergeCard(n)
	require.Equal(t, "in_review", state)
	require.Equal(t, map[string]any{"state": "ready", "on_github": true}, merge)

	require.NoError(t, h.press(h.ctx, n, strings.ToUpper(head)))
	land := h.land(n)
	require.NotNil(t, land)
	assert.Equal(t, []any{"rehearsal-owner", int64(7), h.item(n).Generation, h.session, head}, []any{land.By, land.Account, land.Generation, land.Session, land.Head})
	assert.WithinDuration(t, time.Now(), land.At, time.Minute)
	assert.Equal(t, MythicalOutboundOp{Kind: "merge", Target: strconv.FormatInt(pr, 10), Desired: head, Precondition: "open", State: "intended"}, h.operation(n))
	assert.Empty(t, h.merges(), "the press itself never calls GitHub's merge")
	state, merge = h.mergeCard(n)
	assert.Equal(t, "in_review", state)
	assert.Equal(t, map[string]any{"state": "merging", "reason": "merging", "on_github": true}, merge)

	// A GitHub writer edits the pull request after the review.
	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) {
		p.Title, p.Body = "[skip ci] Fixes #12", "Closes #12"
	})
	h.pass()
	merges := h.merges()
	require.Len(t, merges, 1)
	assert.Equal(t, fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pr), merges[0].Path)
	assert.Equal(t, http.StatusOK, merges[0].Status)
	assert.JSONEq(t, fmt.Sprintf(`{"sha":%q,"merge_method":"squash","commit_title":"Add a greeting (#%d)","commit_message":"TODO T%d, reviewed at %s."}`, head, pr, n, head), string(merges[0].Body))
	assert.Equal(t, map[string]string{"contents": "write"}, merges[0].Permissions, "the merge token holds only what the merge needs")
	landed := h.item(n)
	require.Equal(t, "landed", landed.State, landed.Reason)
	assert.Empty(t, landed.PendingOp)
	assert.Equal(t, h.pull(pr).MergeCommitSHA, landed.PRMergeCommit)
	state, merge = h.mergeCard(n)
	assert.Equal(t, "merged", state)
	assert.Equal(t, map[string]any{"state": "done", "on_github": true}, merge)
	h.pass()
	assert.Len(t, h.merges(), 1, "settlement and later passes never merge again")
}

// GitHub reporting the merge is not enough: the TODO stays in review, still
// fenced, until main contains the merge commit.
func TestMythicalMergeTodoWaitsForMainToContainTheMerge(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Held")
	h.fake.HoldMain()
	require.NoError(t, h.press(h.ctx, n, head))
	h.pass()
	require.True(t, h.pull(pr).Merged)
	assert.Equal(t, "unknown", h.operation(n).State, "a sent merge keeps its fence until it settles")
	h.pass()
	state, merge := h.mergeCard(n)
	assert.Equal(t, "in_review", state, "a merge receipt alone is not completion")
	assert.Equal(t, "merging", merge["state"])
	assert.Equal(t, "merge", h.operation(n).Kind)

	h.fake.ReleaseMain()
	h.pass()
	state, _ = h.mergeCard(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
}

// A merge GitHub refuses clears the fence, keeps the approval with GitHub's
// words as its receipt and shows them; it is never retried by itself, the
// TODO's controls are no longer held by a fence, and the person's next press
// sends it again.
func TestMythicalMergeTodoRefusedByGitHubStaysVisibleAndRetryable(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Refused")
	const refusal = "Base branch was modified. Review and try the merge again."
	h.fake.RefuseNextMerge("rehearsal-owner/app", pr, githubfake.Refusal{Status: http.StatusMethodNotAllowed, Message: refusal})
	require.NoError(t, h.press(h.ctx, n, head))
	h.pass()
	require.Len(t, h.merges(), 1)
	assert.Equal(t, http.StatusMethodNotAllowed, h.merges()[0].Status)
	item := h.item(n)
	assert.Empty(t, item.PendingOp, "a definitive refusal clears the fence")
	land := mythicalChecksOf(item).Land
	require.NotNil(t, land.Refused)
	assert.Equal(t, []string{"github_refused", "github", refusal}, []string{land.Refused.Code, land.Refused.Class, land.Refused.Message})
	assert.Equal(t, head, land.Head)
	state, merge := h.mergeCard(n)
	assert.Equal(t, "in_review", state)
	assert.Equal(t, map[string]any{"state": "blocked", "reason": "github", "detail": refusal, "on_github": true}, merge)
	require.NoError(t, todoControlGuard(item, TodoControlInput{Op: "drop"}, todoControlFacts{}), "no fence holds Drop while a refusal stands")

	h.pass()
	assert.Len(t, h.merges(), 1, "a retained approval is not permission to retry")

	require.NoError(t, h.press(h.ctx, n, head))
	assert.Nil(t, h.land(n).Refused)
	h.pass()
	state, _ = h.mergeCard(n)
	assert.Equal(t, "merged", state)
	require.Len(t, h.merges(), 2)
	assert.Equal(t, http.StatusOK, h.merges()[1].Status)
}

// GitHub answering the merge 401, 403 or 404 (the App's token or permission
// refused, the pull request hidden) is definitive once GitHub reports the PR
// not merged: the fence clears with GitHub's words as the receipt, visible
// and retryable, never re-sent pass after pass.
func TestMythicalMergeTodoUnauthorizedMergeIsDefinitive(t *testing.T) {
	for _, tc := range []struct {
		status  int
		message string
	}{
		{http.StatusUnauthorized, "Bad credentials"},
		{http.StatusForbidden, "Resource not accessible by integration"},
		{http.StatusNotFound, "Not Found"},
	} {
		t.Run(strconv.Itoa(tc.status), func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.first("Unauthorized")
			h.fake.RefuseNextMerge("rehearsal-owner/app", pr, githubfake.Refusal{Status: tc.status, Message: tc.message})
			require.NoError(t, h.press(h.ctx, n, head))
			h.pass()
			require.Len(t, h.merges(), 1)
			assert.Equal(t, tc.status, h.merges()[0].Status)
			item := h.item(n)
			assert.Empty(t, item.PendingOp)
			refused := mythicalChecksOf(item).Land.Refused
			require.NotNil(t, refused)
			assert.Equal(t, []string{"github_refused", "github", tc.message}, []string{refused.Code, refused.Class, refused.Message})
			_, merge := h.mergeCard(n)
			assert.Equal(t, map[string]any{"state": "blocked", "reason": "github", "detail": tc.message, "on_github": true}, merge)
			h.pass()
			h.pass()
			assert.Len(t, h.merges(), 1, "never sent again by itself")

			require.NoError(t, h.press(h.ctx, n, head))
			h.pass()
			state, _ := h.mergeCard(n)
			assert.Equal(t, "merged", state)
		})
	}
}

// A failure before any send that settles nothing (a read GitHub will not
// answer, main's protection unreadable) never loops forever: a merge never
// sent is not sent once mythicalMergeExpiry has passed since the approval,
// and the fence clears with a receipt the person can act on. Unreadable
// protection is never taken for no protection. A sent merge is another
// matter (TestMythicalMergeTodoAttemptedMergeIsSettledOnlyByGitHub).
func TestMythicalMergeTodoUnsettledMergeIsBounded(t *testing.T) {
	for _, tc := range []struct {
		name   string
		breaks func(h *mergeHarness, pr int64)
		sends  int
	}{
		{"protection unreadable", func(h *mergeHarness, _ int64) {
			h.fake.SetInstallationPermission("administration", "")
		}, 0},
		{"pull request unreadable", func(h *mergeHarness, pr int64) {
			h.fake.FailNextReads(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), 100)
		}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.first("Bounded")
			require.NoError(t, h.press(h.ctx, n, head))
			tc.breaks(h, pr)
			h.pass()
			h.pass()
			assert.Len(t, h.merges(), tc.sends)
			assert.Equal(t, "merge", h.operation(n).Kind, "within the bound the fence waits")
			_, merge := h.mergeCard(n)
			assert.Equal(t, "merging", merge["state"])

			// The approval was recorded 11 minutes ago.
			h.exec(`UPDATE mythical_items SET checks = jsonb_set(checks, '{land,at}', to_jsonb($2::text)) WHERE repository_id = $1 AND number = $3`,
				h.repoID, time.Now().Add(-11*time.Minute).UTC().Format(time.RFC3339Nano), n)
			h.pass()
			assert.Len(t, h.merges(), tc.sends, "nothing is sent after the bound")
			item := h.item(n)
			assert.Empty(t, item.PendingOp, "the bound clears the fence")
			refused := mythicalChecksOf(item).Land.Refused
			require.NotNil(t, refused)
			assert.Equal(t, []string{"github", "github", "The merge did not complete within 10 minutes; press Merge again"}, []string{refused.Code, refused.Class, refused.Message})
			_, merge = h.mergeCard(n)
			assert.Equal(t, "blocked", merge["state"])
			h.pass()
			assert.Len(t, h.merges(), tc.sends)
		})
	}
}

// A send whose answer is lost is looked up before anything else: GitHub
// merged it, so it settles without a second merge request. The approver
// signing out as the answer is lost does not end the fence: only lookup
// says what became of a sent merge.
func TestMythicalMergeTodoLostAnswerSettlesByLookup(t *testing.T) {
	for _, signedOut := range []bool{false, true} {
		t.Run(fmt.Sprintf("approver signed out %t", signedOut), func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.first("Lost")
			path := fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pr)
			h.fake.LoseNextResponses(path, 1)
			require.NoError(t, h.press(h.ctx, n, head))
			if signedOut {
				h.fake.OnNextRequest(http.MethodPut, path, func() {
					h.exec(`DELETE FROM auth_sessions WHERE session_key = $1`, h.session)
				})
			}
			h.pass()
			require.Len(t, h.merges(), 1)
			assert.Equal(t, http.StatusBadGateway, h.merges()[0].Status)
			assert.Equal(t, "unknown", h.operation(n).State, "a sent merge whose answer is lost keeps its fence")
			h.pass()
			state, _ := h.mergeCard(n)
			assert.Equal(t, "merged", state)
			assert.Len(t, h.merges(), 1)
		})
	}
}

// Each live fact or authority that fails before send clears the fence with
// its refusal and sends no merge.
func TestMythicalMergeTodoDispatchRechecksBeforeSend(t *testing.T) {
	const ended = "The approving browser session has ended; sign in again to merge"
	for _, tc := range []struct {
		name, code, message string
		change              func(h *mergeHarness, n, pr int64, head string)
	}{
		{"head moved on GitHub", "stale_head", "the pull request changed since you saw it", func(h *mergeHarness, n, _ int64, _ string) {
			h.push(n, "moved\n")
		}},
		{"required check failed", "checks", "unit", func(h *mergeHarness, _, _ int64, head string) {
			h.fake.RequireCheck("unit")
			h.fake.SetCheck("rehearsal-owner/app", head, "unit", "completed", "failure")
		}},
		{"required check pending", "checks", "integration", func(h *mergeHarness, _, _ int64, head string) {
			h.fake.RequireCheck("unit")
			h.fake.RequireCheck("integration")
			h.fake.SetCheck("rehearsal-owner/app", head, "unit", "completed", "success")
		}},
		{"draft", "github", "PR is still draft on GitHub", func(h *mergeHarness, _, pr int64, _ string) {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.Draft = true })
		}},
		{"not mergeable", "github", "GitHub reports this PR is not mergeable", func(h *mergeHarness, _, pr int64, _ string) {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.MergeableState = "dirty" })
		}},
		{"still computing", "github", "GitHub is still computing mergeability", func(h *mergeHarness, _, pr int64, _ string) {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.MergeableState = "unknown" })
		}},
		{"closed", "state", "PR is closed on GitHub", func(h *mergeHarness, _, pr int64, _ string) {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.State = "closed" })
		}},
		{"retargeted away from main", "state", "PR no longer targets main on GitHub", func(h *mergeHarness, _, pr int64, _ string) {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.Base.Ref = "release" })
		}},
		{"session revoked", "unauthenticated", ended, func(h *mergeHarness, _, _ int64, _ string) {
			h.exec(`DELETE FROM auth_sessions WHERE session_key = $1`, h.session)
		}},
		{"person suspended", "unauthenticated", ended, func(h *mergeHarness, _, _ int64, _ string) {
			h.exec(`UPDATE users SET prohibit_login = true WHERE id = $1`, h.userID)
		}},
		{"person inactive", "unauthenticated", ended, func(h *mergeHarness, _, _ int64, _ string) {
			h.exec(`UPDATE users SET is_active = false WHERE id = $1`, h.userID)
		}},
		{"person deleted", "unauthenticated", ended, func(h *mergeHarness, _, _ int64, _ string) {
			h.exec(`UPDATE users SET deleted_at = NOW() WHERE id = $1`, h.userID)
		}},
		{"policy stops naming the person", "permission", "only a maintainer the factory's policy names may merge a TODO", func(h *mergeHarness, _, _ int64, _ string) {
			h.service.SetPolicyReader(mergePolicy("someone-else"))
		}},
		{"ownership moved", "permission", "Merge requires an owner or maintainer browser session", func(h *mergeHarness, _, _ int64, _ string) {
			h.exec(`WITH other AS (INSERT INTO users(username,lower_username) VALUES ('next','next') RETURNING id)
				UPDATE self_host_owners SET user_id = (SELECT id FROM other)`)
		}},
		{"GitHub account relinked", "permission", "The GitHub account that approved this merge is no longer this person's", func(h *mergeHarness, _, _ int64, _ string) {
			h.fake.SetCollaborator(8, "bea", "admin")
			h.exec(`UPDATE oauth_accounts SET provider_user_id = '8' WHERE user_id = $1`, h.userID)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.first("Recheck")
			require.NoError(t, h.press(h.ctx, n, head))
			tc.change(h, n, pr, head)
			h.pass()
			h.refused(n, tc.code, tc.message)
			_, merge := h.mergeCard(n)
			if tc.code == "unauthenticated" || tc.code == "permission" {
				assert.Equal(t, map[string]any{"state": "ready", "detail": tc.message, "on_github": true}, merge,
					"a refused approver blocks no other person's press, and the card says why theirs did not merge")
			} else {
				assert.Equal(t, map[string]any{"state": "blocked", "reason": tc.code, "detail": tc.message, "on_github": true}, merge)
			}
			h.pass()
			assert.Empty(t, h.merges())
		})
	}
}

// The approver's authority is read again after GitHub's live facts,
// immediately before the merge is claimed and sent, with GitHub's
// permission read then and never remembered: a demotion on GitHub with no
// webhook and no time passing, or a sign-out or demotion while Smithers
// reads GitHub, sends no merge (§10.6.2b step 2).
func TestMythicalMergeTodoAuthorityIsReadAfterTheLiveFacts(t *testing.T) {
	const demoted = "only a maintainer of rehearsal-owner/app on GitHub may merge a TODO"
	protection := "/repos/rehearsal-owner/app/branches/main/protection"
	for _, tc := range []struct {
		name, code, message string
		act                 func(h *mergeHarness)
	}{
		{"demoted on GitHub before dispatch", "permission", demoted, func(h *mergeHarness) {
			h.fake.SetCollaborator(7, "rehearsal-owner", "read")
		}},
		{"signed out while GitHub is read", "unauthenticated", "The approving browser session has ended; sign in again to merge", func(h *mergeHarness) {
			h.fake.OnNextRequest(http.MethodGet, protection, func() {
				h.exec(`DELETE FROM auth_sessions WHERE session_key = $1`, h.session)
			})
		}},
		{"demoted while GitHub is read", "permission", demoted, func(h *mergeHarness) {
			h.fake.OnNextRequest(http.MethodGet, protection, func() { h.fake.SetCollaborator(7, "rehearsal-owner", "read") })
		}},
		{"signed out while GitHub answers the permission", "unauthenticated", "The approving browser session has ended; sign in again to merge", func(h *mergeHarness) {
			h.fake.OnNextRequest(http.MethodGet, "/repos/rehearsal-owner/app/collaborators/rehearsal-owner/permission", func() {
				h.exec(`DELETE FROM auth_sessions WHERE session_key = $1`, h.session)
			})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.first("Authority")
			require.NoError(t, h.press(h.ctx, n, head))
			tc.act(h)
			h.pass()
			h.refused(n, tc.code, tc.message)
		})
	}
}

// Main's protection enforced by GitHub when the merge is asked, after
// Smithers' own reads passed: GitHub's refusal is definitive, its words the
// receipt.
func TestMythicalMergeTodoGitHubEnforcesProtectionAtTheMerge(t *testing.T) {
	for _, tc := range []struct {
		name, message string
		act           func(h *mergeHarness, pr int64, head string)
	}{
		{"required check fails after the read", `Required status check "unit" is failing.`, func(h *mergeHarness, _ int64, head string) {
			h.fake.SetCheck("rehearsal-owner/app", head, "unit", "completed", "failure")
		}},
		{"conflict after the read", "Pull Request is not mergeable", func(h *mergeHarness, pr int64, _ string) {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.MergeableState = "dirty" })
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.first("Enforced")
			h.fake.RequireCheck("unit")
			h.fake.SetCheck("rehearsal-owner/app", head, "unit", "completed", "success")
			require.NoError(t, h.press(h.ctx, n, head))
			h.fake.OnNextRequest(http.MethodPut, fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pr), func() { tc.act(h, pr, head) })
			h.pass()
			require.Len(t, h.merges(), 1)
			assert.Equal(t, http.StatusMethodNotAllowed, h.merges()[0].Status)
			item := h.item(n)
			assert.Empty(t, item.PendingOp)
			refused := mythicalChecksOf(item).Land.Refused
			require.NotNil(t, refused)
			assert.Equal(t, []string{"github_refused", tc.message}, []string{refused.Code, refused.Message})
			assert.False(t, h.pull(pr).Merged)
		})
	}
}

// A failing check main does not require blocks nothing.
func TestMythicalMergeTodoOptionalCheckDoesNotBlock(t *testing.T) {
	h := newMergeHarness(t)
	n, head, _ := h.first("Optional")
	h.fake.RequireCheck("unit")
	h.fake.SetCheck("rehearsal-owner/app", head, "unit", "completed", "success")
	h.fake.SetCheck("rehearsal-owner/app", head, "lint", "completed", "failure")
	require.NoError(t, h.press(h.ctx, n, head))
	h.pass()
	state, _ := h.mergeCard(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
}

// The press is accepted only against GitHub's head read now: a head GitHub
// moved before Smithers synced it is 409 stale_head naming GitHub's head, a
// head GitHub cannot be asked about is 409 rechecking, and a pull request
// no longer based on main is refused. None records an approval.
func TestMythicalMergeTodoPressReadsGitHubsHead(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Fresh")
	h.fake.FailNextReads(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), 1)
	assert.Equal(t, TodoControlError{Status: 409, Code: "rechecking", Class: "conflict", Message: "Waiting for fresh GitHub merge facts"}, *refusalOf(t, h.press(h.ctx, n, head)))
	h.unfenced(n)

	moved := h.push(n, "moved\n")
	err := h.press(h.ctx, n, head)
	var stale *MythicalStaleHeadError
	require.ErrorAs(t, err, &stale)
	assert.Equal(t, "stale_head", stale.Code)
	assert.Equal(t, moved, stale.CurrentHead, "GitHub's head, never substituted")
	assert.Equal(t, head, h.item(n).PRHead, "Smithers had not synced it")
	h.unfenced(n)

	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.Base.Ref = "release" })
	h.git(h.github, "update-ref", "refs/heads/"+mythicalChecksOf(h.item(n)).Branch, head)
	assert.Equal(t, TodoControlError{Status: 409, Code: "state", Class: "conflict", Message: "PR no longer targets main on GitHub"}, *refusalOf(t, h.press(h.ctx, n, head)))
	h.unfenced(n)
}

// The card's evidence names the verified candidate, and its pull request
// head is the candidate's publication: another commit with the same tree.
// The app enables Merge on the served ready alone and sends the PR head it
// shows, so the server is what binds an approval to the published head: a
// press at the candidate the evidence names is 409 stale_head naming the
// PR head and records nothing; a press at the PR head is accepted.
func TestMythicalMergeTodoApprovesOnlyThePublishedHead(t *testing.T) {
	h := newMergeHarness(t)
	n, head, _ := h.first("Published")
	candidate := h.item(n).CandidateHead
	require.NotEqual(t, candidate, head, "the pull request head is a new commit, never the candidate itself")
	assert.Equal(t, h.hostTree(candidate), h.git(h.github, "rev-parse", head+"^{tree}"), "the publication carries the candidate's tree")
	card := h.card(n) // as GET /api/todos/{n} serves it
	assert.Equal(t, map[string]any{"state": "ready", "on_github": true}, card["merge"])
	assert.Equal(t, head, card["pr"].(map[string]any)["head"])
	assert.Equal(t, candidate, currentTodoEvidence(h.item(n)).Revision)

	var stale *MythicalStaleHeadError
	require.ErrorAs(t, h.press(h.ctx, n, candidate), &stale)
	assert.Equal(t, TodoControlError{Status: 409, Code: "stale_head", Class: "conflict", Message: "the pull request changed since you saw it"}, stale.TodoControlError)
	assert.Equal(t, head, stale.CurrentHead, "the published head is reported, never substituted")
	h.unfenced(n)

	require.NoError(t, h.press(h.ctx, n, head))
	land := h.land(n)
	require.NotNil(t, land)
	assert.Equal(t, head, land.Head)
	assert.Equal(t, "merge", h.operation(n).Kind)
}

// The press refuses, before any approval or fence, each row that fails and
// each person GitHub or the policy does not count a maintainer.
func TestMythicalMergeTodoRefusesBeforeApproval(t *testing.T) {
	h := newMergeHarness(t)
	first, firstHead, _ := h.first("One")
	second, secondHead, _ := h.todoInReview("Two", h.item(first).CandidateHead)
	queued, err := h.service.FileTodo(h.ctx, h.repoID, h.userID, MythicalTodoInput{Title: "Queued", Prompt: "Later", Request: "queued"})
	require.NoError(t, err)

	stale := refusalOf(t, h.press(h.ctx, first, strings.Repeat("c", 40)))
	assert.Equal(t, "stale_head", stale.Code)
	var current *MythicalStaleHeadError
	require.ErrorAs(t, h.press(h.ctx, first, strings.Repeat("c", 40)), &current)
	assert.Equal(t, firstHead, current.CurrentHead, "the current head is reported, never substituted")

	order := refusalOf(t, h.press(h.ctx, second, secondHead))
	assert.Equal(t, TodoControlError{Status: 409, Code: "order", Class: "conflict", Message: fmt.Sprintf("Merges after T%d", first)}, *order)
	_, merge := h.mergeCard(second)
	assert.Equal(t, map[string]any{"state": "waiting", "reason": "order", "detail": fmt.Sprintf("T%d", first), "on_github": true}, merge)
	assert.Equal(t, "state", refusalOf(t, h.press(h.ctx, queued.Number, firstHead)).Code)
	assert.Equal(t, "todo_not_found", refusalOf(t, h.press(h.ctx, 999, firstHead)).Code)
	for _, sha := range []string{"", "HEAD", strings.Repeat("a", 39), strings.Repeat("a", 41), strings.Repeat("g", 40)} {
		refusal := refusalOf(t, h.press(h.ctx, 999, sha))
		assert.Equal(t, TodoControlError{Status: 400, Code: "invalid_reviewed_head_sha", Class: "user", Message: "reviewed_head_sha must be a 40-character hexadecimal commit SHA"}, *refusal,
			"a malformed head is refused before the TODO is read")
	}

	require.NoError(t, h.press(h.ctx, first, firstHead))
	other := "another-browser"
	h.exec(`INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,'smithers-canary',NOW() + interval '1 hour')`, other, h.userID)
	otherCtx := h.as(&middleware.AuthInfo{User: &db.User{ID: h.userID}, SessionHash: other})
	assert.Equal(t, "merging", refusalOf(t, h.press(otherCtx, first, firstHead)).Code, "another press during the fence is refused")
	assert.Equal(t, h.session, h.land(first).Session)

	h.service.SetPolicyReader(mergePolicy("someone-else"))
	assert.Equal(t, TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: "only a maintainer the factory's policy names may merge a TODO"}, *refusalOf(t, h.press(h.ctx, second, secondHead)))
	h.service.SetPolicyReader(mergePolicy())
	h.exec(`DELETE FROM oauth_accounts WHERE user_id = $1`, h.userID)
	assert.Equal(t, "connect your GitHub account to merge a TODO", refusalOf(t, h.press(h.ctx, second, secondHead)).Message)

	h.service.outbound = MythicalOutboundProviders{}
	h.exec(`INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id) VALUES (2,$1,'github','7')`, h.userID)
	h.exec(`UPDATE mythical_items SET pending_op = NULL WHERE repository_id = $1`, h.repoID)
	unwired := refusalOf(t, h.press(h.ctx, first, firstHead))
	assert.Equal(t, "rechecking", unwired.Code, "no approval is recorded that no worker could send")
	assert.Equal(t, "Waiting for canonical App integration", unwired.Message)

	assert.Empty(t, h.merges())
	assert.Nil(t, h.land(second))
	assert.Empty(t, h.item(second).PendingOp)
}

func TestMythicalMergeRequiresSessionBeforeReads(t *testing.T) {
	for _, tc := range []struct {
		info *middleware.AuthInfo
		code string
	}{
		{nil, "unauthenticated"},
		{&middleware.AuthInfo{}, "unauthenticated"},
		{&middleware.AuthInfo{User: &db.User{ID: 7}}, "permission"},
		{&middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "session", IsTokenAuth: true}, "permission"},
		{&middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "repo:1"}, "permission"},
		{&middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenSource: middleware.TokenSourceOAuth2AccessToken}, "permission"},
		{&middleware.AuthInfo{User: &db.User{ID: 7, UserType: "bot"}, SessionHash: "session"}, "permission"},
		{&middleware.AuthInfo{User: &db.User{ID: 8}, SessionHash: "session"}, "permission"},
	} {
		ctx := middleware.ContextWithAuthInfo(context.Background(), tc.info)
		for _, merge := range []func() error{
			func() error {
				_, err := (&MythicalService{}).Merge(ctx, 1, 7, "invalid", MythicalMergeInput{})
				return err
			},
			func() error { _, err := (&MythicalService{}).MergeTodo(ctx, 1, 7, 1, MythicalMergeInput{}); return err },
		} {
			err := merge()
			require.IsType(t, &TodoControlError{}, err)
			assert.Equal(t, tc.code, err.(*TodoControlError).Code)
			assert.Equal(t, "permission", err.(*TodoControlError).Class)
		}
	}
}

// MergeReady's PostgreSQL rows, each failing alone, in row order.
func TestMythicalMergeReadyRows(t *testing.T) {
	head := strings.Repeat("a", 40)
	ready := db.MythicalItem{Source: "todo", State: "proposed", PRNumber: pgtype.Int8{Int64: 1, Valid: true}, PRState: "open", PRHead: head,
		CandidateVerified: true, Checks: mythicalChecks{Todo: true}.encode()}
	require.NoError(t, mythicalMergeReady(ready, 0, head, false))
	issue := ready
	issue.Source, issue.IssueNumber, issue.Checks = "issue", pgtype.Int8{Int64: 4, Valid: true}, mythicalChecks{AutoTodo: "todoSince"}.encode()
	require.NoError(t, mythicalMergeReady(issue, 0, head, false), "an issue TODO merges the same way")
	fenced := ready
	fenced.PendingOp = json.RawMessage(`{"kind":"merge","target":"1","desired":"` + head + `","precondition":"open","state":"intended"}`)
	require.NoError(t, mythicalMergeReady(fenced, 0, head, true), "dispatch rechecks under its own fence")
	for _, tc := range []struct {
		name, code, message string
		before              int64
		change              func(*db.MythicalItem)
	}{
		{"not a TODO", "state", "only a TODO can merge", 0, func(i *db.MythicalItem) { i.Checks = nil }},
		{"closed", "state", "PR is closed on GitHub", 0, func(i *db.MythicalItem) { i.PRState = "closed" }},
		{"queued", "state", "only a TODO in review can merge", 0, func(i *db.MythicalItem) { i.State = "queued" }},
		{"no PR", "state", "only a TODO in review can merge", 0, func(i *db.MythicalItem) { i.PRNumber = pgtype.Int8{} }},
		{"paused", "state", "only a TODO in review can merge", 0, func(i *db.MythicalItem) { i.PausedAt = pgtype.Timestamptz{Time: time.Unix(1, 0), Valid: true} }},
		{"open wait", "state", "only a TODO in review can merge", 0, func(i *db.MythicalItem) {
			i.Checks = mythicalChecks{Todo: true, Waits: []TodoWait{{ID: "w", Kind: "question"}}}.encode()
		}},
		{"foreign head", "state", "only a TODO in review can merge", 0, func(i *db.MythicalItem) { i.Checks = mythicalChecks{Todo: true, ForeignHead: head}.encode() }},
		{"after T3", "order", "Merges after T3", 3, func(*db.MythicalItem) {}},
		{"fenced", "merging", "A merge is in flight", 0, func(i *db.MythicalItem) { i.PendingOp = fenced.PendingOp }},
		{"push pending", "rechecking", "Waiting for the TODO's pull request push to settle", 0, func(i *db.MythicalItem) {
			i.PendingOp = json.RawMessage(`{"kind":"push","target":"smithers/x","desired":"` + head + `","state":"intended"}`)
		}},
		{"fenced and unverified", "merging", "A merge is in flight", 0, func(i *db.MythicalItem) {
			i.PendingOp, i.CandidateVerified = fenced.PendingOp, false
		}},
		{"unverified", "rechecking", "Waiting for the TODO's accepted pull request head", 0, func(i *db.MythicalItem) { i.CandidateVerified = false }},
		{"no head", "rechecking", "Waiting for the TODO's accepted pull request head", 0, func(i *db.MythicalItem) { i.PRHead = "" }},
		{"stale", "stale_head", "the pull request changed since you saw it", 0, func(i *db.MythicalItem) { i.PRHead = strings.Repeat("b", 40) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			item := ready
			tc.change(&item)
			refusal := refusalOf(t, mythicalMergeReady(item, tc.before, head, false))
			assert.Equal(t, TodoControlError{Status: 409, Code: tc.code, Class: "conflict", Message: tc.message}, *refusal)
		})
	}
}

// MergeDecision sends nothing for an approval that is not exactly the
// fence's: each guard refuses alone, before any read.
func TestMythicalMergeDecisionRefusesAMismatchedApproval(t *testing.T) {
	head := strings.Repeat("a", 40)
	op := MythicalOutboundOp{Kind: "merge", Target: "1", Desired: head, Precondition: "open", State: "intended"}
	land := mythicalLand{By: "rehearsal-owner", Account: 7, Generation: 1, Session: "session", Head: head}
	approved := func(change func(*mythicalLand)) db.MythicalItem {
		next := land
		change(&next)
		return db.MythicalItem{Generation: 1, Checks: mythicalChecks{Todo: true, Land: &next}.encode()}
	}
	refused := &mythicalMergeRefusal{Code: "github_refused", Class: "github", Message: "no"}
	for _, tc := range []struct {
		name string
		item db.MythicalItem
		op   MythicalOutboundOp
	}{
		{"another operation", approved(func(*mythicalLand) {}), MythicalOutboundOp{Kind: "push", Target: "1", Desired: head, State: "intended"}},
		{"no approval", db.MythicalItem{Generation: 1, Checks: mythicalChecks{Todo: true}.encode()}, op},
		{"no session", approved(func(l *mythicalLand) { l.Session = "" }), op},
		{"already refused", approved(func(l *mythicalLand) { l.Refused = refused }), op},
		{"another head", approved(func(l *mythicalLand) { l.Head = strings.Repeat("b", 40) }), op},
		{"another generation", approved(func(l *mythicalLand) { l.Generation = 2 }), op},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// No store, GitHub or session exists: a guard that let this
			// through would fail on a read instead of refusing.
			_, err := (&MythicalService{}).MergeDecision(context.Background(), tc.item, tc.op)
			assert.Equal(t, TodoControlError{Status: 409, Code: "rechecking", Class: "conflict", Message: "The merge approval no longer matches this TODO; review it again"}, *refusalOf(t, err))
		})
	}
}

// A fence naming a pull request that is not the TODO's sends nothing, even
// one GitHub serves at the very head the person reviewed.
func TestMythicalMergeTodoFenceNamesTheTodosPullRequest(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Named")
	h.git(h.github, "update-ref", "refs/heads/smithers/other", head)
	token, err := h.connections.CreateGitHubInstallationTokenForRepositoryOwner(context.Background(), h.userID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "write"})
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPost, h.fake.URL+"/repos/rehearsal-owner/app/pulls", strings.NewReader(`{"title":"Other","head":"smithers/other","base":"main"}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := h.fake.Client().Do(request)
	require.NoError(t, err)
	var other githubfake.Pull
	require.NoError(t, json.NewDecoder(response.Body).Decode(&other))
	require.NoError(t, response.Body.Close())
	require.Equal(t, head, other.Head.SHA, "another pull request at the reviewed head")

	require.NoError(t, h.press(h.ctx, n, head))
	h.exec(`UPDATE mythical_items SET pending_op = jsonb_set(pending_op, '{target}', to_jsonb($2::text)) WHERE repository_id = $1 AND number = $3`, h.repoID, strconv.FormatInt(other.Number, 10), n)
	h.pass()
	h.pass()
	assert.Empty(t, h.merges())
	assert.False(t, h.pull(other.Number).Merged)
	assert.False(t, h.pull(pr).Merged)
}

// Recovery consumes the real HTTP GitHub fake and its containment endpoint.
// The same PR receipt remains proposed until main actually includes it.
func TestMythicalMergeRecoveryWaitsForMain(t *testing.T) {
	for _, tc := range []struct {
		status string
		state  string
		ahead  int
	}{
		{"diverged", "proposed", 1}, {"behind", "landed", 0},
	} {
		t.Run(tc.status, func(t *testing.T) {
			gh := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/pulls/19":                    answer(200, map[string]any{"number": 19, "state": "closed", "merged_at": "2026-10-04T12:00:00Z", "merge_commit_sha": "merge-commit", "head": map[string]string{"sha": "head"}}),
				"GET /repos/o/r/compare/main...merge-commit": answer(200, map[string]any{"status": tc.status, "ahead_by": tc.ahead}),
			}}
			st := mythicalItemStep{s: &MythicalService{github: gh.api(t)}, r: &mythicalRun{row: db.MythicalStack{ActorUserID: pgtype.Int8{Int64: 1, Valid: true}}}, gh: &stackRepo, now: time.Unix(100, 0)}
			item := db.MythicalItem{State: "proposed", PRNumber: pgtype.Int8{Int64: 19, Valid: true}, PRHead: "head"}
			next := st.merge(context.Background(), item)
			require.NotNil(t, next)
			require.Equal(t, tc.state, next.State)
			require.Len(t, gh.calls, 3)
			for _, call := range gh.calls {
				require.True(t, strings.HasPrefix(call, "GET "), call)
			}
		})
	}
}

// The press and the worker apply one authority rule: a person the worker
// would refuse is refused at the press, before any approval or fence, so a
// 202 never hides a merge that cannot happen.
func TestMythicalMergeTodoAuthorityIsOneRuleAtPressAndDispatch(t *testing.T) {
	const ended = "The approving browser session has ended; sign in again to merge"
	t.Run("maintainer who is not the install owner", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, _ := h.first("Maintainer")
		h.fake.SetCollaborator(8, "bea", "maintain")
		bea, ctx := h.person("bea", 8)
		_, err := h.service.Merge(ctx, h.repoID, bea, uuidString(h.item(n).ID), MythicalMergeInput{Head: head, Request: "bea-1"})
		assert.Equal(t, TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}, *refusalOf(t, err))
		h.unfenced(n)
		h.pass()
		assert.Empty(t, h.merges())
	})
	t.Run("session filed before keys were hashed", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, _ := h.first("Legacy")
		const raw = "6f1d1f4e-7a3c-4c5e-9d55-3b8f0d2c1a90"
		h.exec(`INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,'smithers-canary',NOW() + interval '1 hour')`, raw, h.userID)
		digest := sha256.Sum256([]byte(raw))
		legacy := h.as(&middleware.AuthInfo{User: &db.User{ID: h.userID, Username: "smithers-canary"}, SessionHash: hex.EncodeToString(digest[:])})
		assert.Equal(t, TodoControlError{Status: 401, Code: "unauthenticated", Class: "permission", Message: ended}, *refusalOf(t, h.press(legacy, n, head)),
			"dispatch could never find this session, so the press refuses it")
		h.unfenced(n)
	})
	for _, tc := range []struct{ name, change string }{
		{"expired session", `UPDATE auth_sessions SET expires_at = NOW() - interval '1 second'`},
		{"suspended person", `UPDATE users SET prohibit_login = true`},
		{"inactive person", `UPDATE users SET is_active = false`},
		{"deleted person", `UPDATE users SET deleted_at = NOW()`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.first("Ended")
			h.exec(tc.change)
			assert.Equal(t, TodoControlError{Status: 401, Code: "unauthenticated", Class: "permission", Message: ended}, *refusalOf(t, h.press(h.ctx, n, head)))
			h.unfenced(n)
		})
	}
}

// GitHub not counting the person a maintainer refuses the press: no
// approval, no fence, no merge; promoted again, the next press is accepted.
func TestMythicalMergeTodoGitHubDemotionAtThePress(t *testing.T) {
	const demoted = "only a maintainer of rehearsal-owner/app on GitHub may merge a TODO"
	for _, permission := range []string{"read", "triage", "none"} {
		t.Run(permission, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.first("Demoted")
			h.fake.SetCollaborator(7, "rehearsal-owner", permission)
			assert.Equal(t, TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: demoted}, *refusalOf(t, h.press(h.ctx, n, head)))
			h.unfenced(n)

			h.fake.SetCollaborator(7, "rehearsal-owner", "admin")
			require.NoError(t, h.press(h.ctx, n, head), "promoted again, the next press is accepted at once")
			h.pass()
			state, _ := h.mergeCard(n)
			assert.Equal(t, "merged", state)
		})
	}
}

// The repository door names the item by id within its repository. It is
// the same request as the numbered door, in the same order: the person's
// authority before the id is parsed or the item read, then a malformed id,
// an unknown one or another repository's item.
func TestMythicalMergeRepositoryDoor(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Door")
	id := uuidString(h.item(n).ID)

	h.fake.SetCollaborator(8, "bea", "maintain")
	bea, beaCtx := h.person("bea", 8)
	for _, other := range []string{"not-a-uuid", "00000000-0000-4000-8000-000000000001", id} {
		_, err := h.service.Merge(beaCtx, h.repoID, bea, other, MythicalMergeInput{Head: head, Request: "bea-" + other})
		assert.Equal(t, TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}, *refusalOf(t, err),
			"a person without the authority learns nothing about items")
	}

	_, err := h.service.Merge(h.ctx, h.repoID, h.userID, "not-a-uuid", MythicalMergeInput{Head: head, Request: "door-1"})
	assert.Equal(t, TodoControlError{Status: 400, Code: "invalid_todo", Class: "user", Message: "Invalid TODO id"}, *refusalOf(t, err),
		"the numbered door's refusal of a malformed target, naming this door's form")

	_, err = h.service.Merge(h.ctx, h.repoID, h.userID, "00000000-0000-4000-8000-000000000001", MythicalMergeInput{Head: head, Request: "door-2"})
	assert.Equal(t, TodoControlError{Status: 404, Code: "todo_not_found", Class: "user", Message: "TODO not found"}, *refusalOf(t, err))

	var other int64
	require.NoError(t, h.pool.QueryRow(context.Background(), `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'other','other') RETURNING id`, h.userID).Scan(&other))
	_, err = h.service.Merge(h.ctx, other, h.userID, id, MythicalMergeInput{Head: head, Request: "door-3"})
	assert.Equal(t, "todo_not_found", refusalOf(t, err).Code, "another repository's item is not found through this door")
	h.unfenced(n)

	view, err := h.service.Merge(h.ctx, h.repoID, h.userID, strings.ToUpper(id), MythicalMergeInput{Head: head, Request: "door-4"})
	require.NoError(t, err)
	assert.Equal(t, n, view.Number)
	assert.Equal(t, "merge", h.operation(n).Kind)
	h.pass()
	merges := h.merges()
	require.Len(t, merges, 1)
	assert.Equal(t, fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pr), merges[0].Path)
	state, _ := h.mergeCard(n)
	assert.Equal(t, "merged", state)
}

// A new generation voids the approval (§10.6.2c): dispatch sends nothing,
// clears the fence and keeps why; a press at the new generation merges.
func TestMythicalMergeTodoNewGenerationVoidsTheApproval(t *testing.T) {
	h := newMergeHarness(t)
	n, head, _ := h.first("Regenerated")
	require.NoError(t, h.press(h.ctx, n, head))
	h.exec(`UPDATE mythical_items SET generation = generation + 1 WHERE repository_id = $1 AND number = $2`, h.repoID, n)
	h.pass()
	h.refused(n, "rechecking", "The merge approval no longer matches this TODO; review it again")
	_, merge := h.mergeCard(n)
	assert.Equal(t, map[string]any{"state": "ready", "on_github": true}, merge, "the old generation's approval blocks nothing")

	require.NoError(t, h.press(h.ctx, n, head))
	assert.Equal(t, h.item(n).Generation, h.land(n).Generation)
	h.pass()
	state, _ := h.mergeCard(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
}

// Presses racing each other record exactly one approval and fence: another
// session's press is refused as merging; the same session repeating the same
// request (its Idempotency-Key) is answered with its receipt.
func TestMythicalMergeTodoConcurrentPressesRecordOneFence(t *testing.T) {
	for _, sameRequest := range []bool{false, true} {
		t.Run(fmt.Sprintf("same request %t", sameRequest), func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.first("Race")
			second, keys := h.ctx, []string{"race", "race"}
			if !sameRequest {
				digest := sha256.Sum256([]byte("owner-second-browser"))
				key := hex.EncodeToString(digest[:])
				h.exec(`INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,'smithers-canary',NOW() + interval '1 hour')`, key, h.userID)
				second, keys = h.as(&middleware.AuthInfo{User: &db.User{ID: h.userID, Username: "smithers-canary"}, SessionHash: key}), []string{"race-1", "race-2"}
			}
			before := h.item(n).Version
			start := make(chan struct{})
			errs := make(chan error, 2)
			for i, ctx := range []context.Context{h.ctx, second} {
				go func() {
					<-start
					errs <- h.pressAs(ctx, keys[i], n, head)
				}()
			}
			close(start)
			var refused []string
			for range 2 {
				if err := <-errs; err != nil {
					refused = append(refused, refusalOf(t, err).Code)
				}
			}
			if sameRequest {
				assert.Empty(t, refused, "the same request is answered again")
			} else {
				assert.Equal(t, []string{"merging"}, refused)
			}
			assert.Equal(t, before+1, h.item(n).Version, "one approval and fence written")
			assert.Len(t, mythicalChecksOf(h.item(n)).MergeRequests, 1)
			assert.Equal(t, "merge", h.operation(n).Kind)
			h.pass()
			assert.Len(t, h.merges(), 1)
		})
	}
}

// The Idempotency-Key names a press (§6.2.1). The same request again
// answers its receipt and never records another approval: during the fence,
// after GitHub refused it, after a new generation, after the merge. The
// same key for another head, another TODO or another operation is
// idempotency_mismatch. A renewed approval needs a new key. A person whose
// authority is gone is refused before any receipt is disclosed.
func TestMythicalMergeTodoIdempotencyKeyNamesThePress(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Keyed")
	assert.Equal(t, TodoControlError{Status: 400, Code: "idempotency_key_required", Class: "user", Message: "Idempotency-Key is required"}, *refusalOf(t, h.pressAs(h.ctx, "", n, head)))
	h.unfenced(n)

	h.fake.RefuseNextMerge("rehearsal-owner/app", pr, githubfake.Refusal{Status: http.StatusMethodNotAllowed, Message: "Base branch was modified."})
	require.NoError(t, h.pressAs(h.ctx, "first", n, head))
	fenced := h.item(n)
	require.NoError(t, h.pressAs(h.ctx, "first", n, head), "a retry during the fence answers the receipt")
	assert.Equal(t, fenced.Version, h.item(n).Version)
	h.pass()
	refused := h.item(n)
	require.NotNil(t, mythicalChecksOf(refused).Land.Refused)

	retained := TodoControlError{Status: 409, Code: "github_refused", Class: "github", Message: "Base branch was modified."}
	assert.Equal(t, retained, *refusalOf(t, h.pressAs(h.ctx, "first", n, head)), "a retry after the refusal answers that refusal")
	assert.Equal(t, refused.Version, h.item(n).Version, "and records no fresh approval")
	assert.Empty(t, h.item(n).PendingOp)
	assert.NotNil(t, h.land(n).Refused)

	h.fake.SetCollaborator(7, "rehearsal-owner", "read")
	assert.Equal(t, "permission", refusalOf(t, h.pressAs(h.ctx, "first", n, head)).Code, "authority first: no receipt for a person who lost it")
	h.fake.SetCollaborator(7, "rehearsal-owner", "admin")

	mismatch := TodoControlError{Status: 409, Code: "idempotency_mismatch", Class: "conflict", Message: "Idempotency-Key was already used for a different request"}
	assert.Equal(t, mismatch, *refusalOf(t, h.pressAs(h.ctx, "first", n, strings.Repeat("c", 40))), "another head")
	second, secondHead, _ := h.todoInReview("Second", h.item(n).CandidateHead)
	quiet := h.item(n)
	assert.Equal(t, mismatch, *refusalOf(t, h.pressAs(h.ctx, "first", second, secondHead)), "another TODO")
	_, err := h.service.FileTodo(h.ctx, h.repoID, h.userID, MythicalTodoInput{Title: "Filed", Prompt: "Later", Request: "first"})
	assert.Equal(t, mismatch, *refusalOf(t, err), "another operation: filing a TODO")
	_, err = h.service.FileTodo(h.ctx, h.repoID, h.userID, MythicalTodoInput{Title: "Filed", Prompt: "Later", Request: "filed"})
	require.NoError(t, err)
	assert.Equal(t, mismatch, *refusalOf(t, h.pressAs(h.ctx, "filed", n, head)), "another operation: a key that filed a TODO")
	assert.Equal(t, quiet.Version, h.item(n).Version, "no refusal wrote the TODO")
	assert.Nil(t, h.land(second))

	h.exec(`UPDATE mythical_items SET generation = generation + 1 WHERE repository_id = $1 AND number = $2`, h.repoID, n)
	regenerated := h.item(n)
	assert.Equal(t, retained, *refusalOf(t, h.pressAs(h.ctx, "first", n, head)), "an old request is answered, never renewed")
	assert.Equal(t, regenerated.Version, h.item(n).Version)
	assert.Equal(t, refused.Generation, h.land(n).Generation)

	require.NoError(t, h.pressAs(h.ctx, "renewed", n, head))
	assert.Equal(t, regenerated.Generation, h.land(n).Generation)
	assert.Nil(t, h.land(n).Refused)
	assert.Equal(t, []mythicalMergeRequest{
		{Session: h.session, Request: "first", Generation: refused.Generation, Head: head},
		{Session: h.session, Request: "renewed", Generation: regenerated.Generation, Head: head},
	}, mythicalChecksOf(h.item(n)).MergeRequests)
	h.pass()
	state, _ := h.mergeCard(n)
	assert.Equal(t, "merged", state)
	require.NoError(t, h.pressAs(h.ctx, "renewed", n, head), "after the merge the request is still answered")
	assert.Len(t, h.merges(), 2)
}

// Main's required reviews (row 9) as real GitHub reports them: after
// required checks and before draft and mergeability, unmet reviews refuse
// as review_required and send no merge.
func TestMythicalMergeTodoRequiredReviews(t *testing.T) {
	const unmet = "Required reviews are not satisfied on GitHub"
	t.Run("unmet, then approved", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, pr := h.first("Reviewed")
		h.fake.RequireReviews(1)
		require.NoError(t, h.press(h.ctx, n, head))
		h.pass()
		h.refused(n, "review_required", unmet)
		_, merge := h.mergeCard(n)
		assert.Equal(t, map[string]any{"state": "blocked", "reason": "review_required", "detail": unmet, "on_github": true}, merge)

		h.fake.Review("rehearsal-owner/app", pr, "bea", "APPROVED")
		require.NoError(t, h.press(h.ctx, n, head))
		h.pass()
		state, _ := h.mergeCard(n)
		assert.Equal(t, "merged", state)
		require.Len(t, h.merges(), 1)
		assert.Equal(t, http.StatusOK, h.merges()[0].Status)
	})
	for _, tc := range []struct {
		name, code, message string
		change              func(h *mergeHarness, pr int64, head string)
	}{
		{"changes requested", "review_required", unmet, func(h *mergeHarness, pr int64, _ string) {
			h.fake.Review("rehearsal-owner/app", pr, "bea", "APPROVED")
			h.fake.Review("rehearsal-owner/app", pr, "cy", "CHANGES_REQUESTED")
		}},
		{"required check first", "checks", "unit", func(h *mergeHarness, _ int64, head string) {
			h.fake.RequireCheck("unit")
			h.fake.SetCheck("rehearsal-owner/app", head, "unit", "completed", "failure")
		}},
		{"reviews before draft", "review_required", unmet, func(h *mergeHarness, pr int64, _ string) {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.Draft = true })
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.first("Order")
			h.fake.RequireReviews(1)
			tc.change(h, pr, head)
			require.NoError(t, h.press(h.ctx, n, head))
			h.pass()
			h.refused(n, tc.code, tc.message)
		})
	}
}

// rereadGitHub answers each Pull and HeadCheckFacts call from its next
// scripted fact, counting the calls.
type rereadGitHub struct {
	*fakeMythicalGitHub
	pulls  []mythicalPull
	checks [][]mythicalHeadCheck
	reads  map[string]int
}

func (g *rereadGitHub) Pull(context.Context, mythicalGitHubRepo, int64) (mythicalPull, error) {
	g.reads["pull"]++
	return g.pulls[min(g.reads["pull"], len(g.pulls))-1], nil
}

func (g *rereadGitHub) HeadCheckFacts(context.Context, mythicalGitHubRepo, string) ([]mythicalHeadCheck, error) {
	g.reads["checks"]++
	return g.checks[min(g.reads["checks"], len(g.checks))-1], nil
}

func (g *rereadGitHub) ReviewDecision(context.Context, mythicalGitHubRepo, int64) (string, error) {
	g.reads["reviews"]++
	return "", nil
}

// GitHub still computing mergeability is read once more, and rows 8-9 are
// evaluated again against that second read, its checks included.
func TestMythicalMergeLiveRereadsEveryRow(t *testing.T) {
	head := strings.Repeat("a", 40)
	pull := func(state string) mythicalPull {
		return mythicalPull{Number: 1, State: "open", HeadSHA: head, BaseRef: "main", MergeableState: state}
	}
	green := []mythicalHeadCheck{{Name: "unit", State: mythicalCIGreen, Required: true}}
	red := []mythicalHeadCheck{{Name: "unit", State: mythicalCIRed, Required: true}}
	for _, tc := range []struct {
		name   string
		pulls  []mythicalPull
		checks [][]mythicalHeadCheck
		code   string
		// reviews is how many review decisions were read: a red check
		// refuses before reviews are read.
		reviews int
	}{
		{"checks turn red", []mythicalPull{pull("unknown"), pull("clean")}, [][]mythicalHeadCheck{green, red}, "checks", 1},
		{"mergeable on the second read", []mythicalPull{pull("unknown"), pull("clean")}, [][]mythicalHeadCheck{green}, "", 2},
		{"still computing", []mythicalPull{pull("unknown"), pull("")}, [][]mythicalHeadCheck{green}, "github", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gh := &rereadGitHub{fakeMythicalGitHub: &fakeMythicalGitHub{}, pulls: tc.pulls, checks: tc.checks, reads: map[string]int{}}
			err := (&MythicalService{github: gh}).mergeLive(context.Background(), stackRepo, 1, head)
			assert.Equal(t, map[string]int{"pull": 2, "checks": 2, "reviews": tc.reviews}, gh.reads, "the second read is evaluated again")
			if tc.code == "" {
				require.NoError(t, err)
				return
			}
			assert.Equal(t, tc.code, refusalOf(t, err).Code)
		})
	}
}

// passAsync runs one claimed stack pass in the background, as the worker
// does, and answers when it ends.
func (h *mergeHarness) passAsync() <-chan error {
	h.t.Helper()
	h.exec(`UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, h.repoID)
	h.service.MainMoved(context.Background(), h.repoID)
	done := make(chan error, 1)
	go func() { done <- h.service.PollOnce(context.Background()) }()
	return done
}

// holdTodo takes TODO n's row lock when GitHub is next asked for pull
// request pr, as a writer of the TODO would, so the dispatch claim that
// follows waits for release.
func (h *mergeHarness) holdTodo(n, pr int64) (release func()) {
	return h.holdRow(pr, `SELECT 1 FROM mythical_items WHERE id = $1 FOR UPDATE`, h.item(n).ID)
}

// holdRow runs lock, a statement locking one row, in a transaction of its
// own when GitHub is next asked for pull request pr (dispatch's first read),
// so the dispatch claim waits for release on that row.
func (h *mergeHarness) holdRow(pr int64, lock string, args ...any) (release func()) {
	held := make(chan pgx.Tx, 1)
	h.fake.OnNextRequest(http.MethodGet, fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), func() {
		tx, err := h.pool.(*pgxpool.Pool).Begin(context.Background())
		if err == nil {
			_, err = tx.Exec(context.Background(), lock, args...)
		}
		if err != nil {
			panic(err)
		}
		held <- tx
	})
	var once sync.Once
	release = func() {
		once.Do(func() {
			select {
			case tx := <-held:
				require.NoError(h.t, tx.Rollback(context.Background()))
			default:
			}
		})
	}
	// A failed test still frees the lock, so its database can close.
	h.t.Cleanup(release)
	return release
}

// waitForTheClaim waits until a statement of this test's database waits on
// a lock: the dispatch claim behind holdTodo.
func (h *mergeHarness) waitForTheClaim() {
	h.t.Helper()
	for deadline := time.Now().Add(2 * time.Minute); ; {
		var waiting int
		require.NoError(h.t, h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&waiting))
		if waiting > 0 {
			return
		}
		require.False(h.t, time.Now().After(deadline), "the dispatch never reached its claim")
		time.Sleep(20 * time.Millisecond)
	}
}

// approvedAt moves TODO n's approval time: the clock of mythicalMergeExpiry.
func (h *mergeHarness) approvedAt(n int64, at time.Time) {
	h.t.Helper()
	h.exec(`UPDATE mythical_items SET checks = jsonb_set(checks, '{land,at}', to_jsonb($2::text)) WHERE repository_id = $1 AND number = $3`,
		h.repoID, at.UTC().Format(time.RFC3339Nano), n)
}

// A sign-out, a suspension or an owner change committed before the dispatch
// claim sends nothing (§10.6.2b step 2): the claim takes the TODO's row, then
// reads the session, the person and the owner with locks those revocations
// wait on, so one committed while the claim waited is seen.
func TestMythicalMergeTodoRevocationBeforeTheClaimSendsNothing(t *testing.T) {
	const ended = "The approving browser session has ended; sign in again to merge"
	for _, tc := range []struct {
		name, revoke, code, message string
	}{
		{"signed out", `DELETE FROM auth_sessions WHERE user_id = $1`, "unauthenticated", ended},
		{"suspended", `UPDATE users SET prohibit_login = true WHERE id = $1`, "unauthenticated", ended},
		{"owner changed", `WITH other AS (INSERT INTO users(username,lower_username) VALUES ('next','next') RETURNING id)
			UPDATE self_host_owners SET user_id = (SELECT id FROM other) WHERE user_id = $1`, "permission", "Merge requires an owner or maintainer browser session"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.first("Claimed")
			require.NoError(t, h.press(h.ctx, n, head))
			release := h.holdTodo(n, pr)
			done := h.passAsync()
			h.waitForTheClaim()
			h.exec(tc.revoke, h.userID)
			release()
			require.NoError(t, <-done)
			h.refused(n, tc.code, tc.message)
		})
	}
}

// A write in flight when the claim takes its locks is serialized with it:
// the claim waits for the write, and reads what it committed. A revocation
// is refused; a change of where the merge goes or through what leaves the
// fence for the next pass.
func TestMythicalMergeTodoRevocationInFlightAtTheClaimSendsNothing(t *testing.T) {
	for _, tc := range []struct {
		name, revoke, code string
	}{
		{"signing out", `DELETE FROM auth_sessions WHERE user_id = $1`, "unauthenticated"},
		{"suspending", `UPDATE users SET prohibit_login = true WHERE id = $1`, "unauthenticated"},
		{"changing the owner", `UPDATE self_host_owners SET user_id = (SELECT id FROM users WHERE username = 'next') WHERE user_id = $1`, "permission"},
		{"unlinking the GitHub account", `DELETE FROM oauth_accounts WHERE user_id = $1`, "permission"},
		{"removing the connection", `DELETE FROM repo_connections WHERE user_id = $1`, ""},
		{"uninstalling the App from the repository", `DELETE FROM github_app_installation_repositories WHERE owner_login_lower = 'rehearsal-owner' AND repo_name_lower = 'app' AND $1::bigint > 0`, ""},
		{"replacing the App", `UPDATE github_app SET id = id + 1 WHERE singleton AND $1::bigint > 0`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.first("Serialized")
			h.exec(`INSERT INTO users(username,lower_username) VALUES ('next','next')`)
			require.NoError(t, h.press(h.ctx, n, head))
			revocation, err := h.pool.(*pgxpool.Pool).Begin(context.Background())
			require.NoError(t, err)
			defer func() { _ = revocation.Rollback(context.Background()) }()
			_, err = revocation.Exec(context.Background(), tc.revoke, h.userID)
			require.NoError(t, err)
			done := h.passAsync()
			h.waitForTheClaim()
			require.NoError(t, revocation.Commit(context.Background()))
			require.NoError(t, <-done)
			assert.Empty(t, h.merges())
			refused := h.land(n).Refused
			if tc.code == "" {
				assert.Nil(t, refused)
				assert.Equal(t, "intended", h.operation(n).State, "the fence stays for the next pass")
				return
			}
			require.NotNil(t, refused)
			assert.Equal(t, tc.code, refused.Code)
		})
	}
}

// mythicalMergeExpiry is read at the claim, against the time then: an
// approval that expires while GitHub is read, or while the claim waits,
// is not sent.
func TestMythicalMergeTodoExpiryIsReadAtTheClaim(t *testing.T) {
	const unfinished = "The merge did not complete within 10 minutes; press Merge again"
	t.Run("during the live reads", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, _ := h.first("Expiring")
		require.NoError(t, h.press(h.ctx, n, head))
		h.fake.OnNextRequest(http.MethodGet, "/repos/rehearsal-owner/app/branches/main/protection", func() { time.Sleep(12 * time.Second) })
		h.approvedAt(n, time.Now().Add(-mythicalMergeExpiry+10*time.Second))
		h.pass()
		h.refused(n, "github", unfinished)
	})
	t.Run("while the claim waits", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, pr := h.first("Expiring")
		require.NoError(t, h.press(h.ctx, n, head))
		release := h.holdTodo(n, pr)
		deadline := time.Now().Add(15 * time.Second)
		h.approvedAt(n, deadline.Add(-mythicalMergeExpiry))
		done := h.passAsync()
		h.waitForTheClaim()
		time.Sleep(time.Until(deadline) + time.Second)
		release()
		require.NoError(t, <-done)
		h.refused(n, "github", unfinished)
	})
}

// A merge whose request was sent is never sent again and never ended by
// the bound or by its approver's refusal: only what GitHub then shows
// settles it. Here the request times out, GitHub shows the pull request
// still open, then completes the merge: one merge request, and Merged only
// once main contains the commit.
func TestMythicalMergeTodoAttemptedMergeIsSettledOnlyByGitHub(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Delayed")
	h.fake.HoldMain()
	h.fake.DelayNextMerge("rehearsal-owner/app", pr)
	require.NoError(t, h.press(h.ctx, n, head))
	h.pass()
	require.Len(t, h.merges(), 1)
	assert.Equal(t, http.StatusBadGateway, h.merges()[0].Status)
	assert.Equal(t, "unknown", h.operation(n).State, "a send is recorded before the request leaves")

	h.pass()
	assert.Len(t, h.merges(), 1, "GitHub shows it open: not sent again")
	h.approvedAt(n, time.Now().Add(-mythicalMergeExpiry-time.Minute))
	h.pass()
	h.exec(`DELETE FROM auth_sessions WHERE session_key = $1`, h.session)
	h.pass()
	assert.Len(t, h.merges(), 1)
	assert.Equal(t, "unknown", h.operation(n).State, "neither the bound nor a sign-out ends a sent merge")
	_, merge := h.mergeCard(n)
	assert.Equal(t, "merging", merge["state"])

	h.fake.CompleteDelayedMerges()
	h.pass()
	state, merge := h.mergeCard(n)
	assert.Equal(t, "in_review", state, "GitHub merged it; main does not contain it yet")
	assert.Equal(t, "merging", merge["state"])
	h.fake.ReleaseMain()
	h.pass()
	state, _ = h.mergeCard(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
	assert.Nil(t, h.land(n).Refused)
}

// What GitHub shows ends a sent merge it never completed: the pull request
// closed, or moved to a head the sha-bound request can no longer merge.
func TestMythicalMergeTodoAttemptedMergeEndsOnGitHubsOutcome(t *testing.T) {
	for _, tc := range []struct {
		name, code, message string
		change              func(h *mergeHarness, n, pr int64)
	}{
		{"closed", "state", "PR is closed on GitHub", func(h *mergeHarness, _, pr int64) {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.State = "closed" })
		}},
		{"moved", "stale_head", "the pull request changed since you saw it", func(h *mergeHarness, n, _ int64) { h.push(n, "moved\n") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.first("Unanswered")
			h.fake.FailNextWrites(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pr), 1)
			require.NoError(t, h.press(h.ctx, n, head))
			h.pass()
			h.pass()
			require.Len(t, h.merges(), 1)
			assert.Equal(t, "unknown", h.operation(n).State)
			tc.change(h, n, pr)
			h.pass()
			assert.Len(t, h.merges(), 1)
			item := h.item(n)
			assert.Empty(t, item.PendingOp)
			refused := mythicalChecksOf(item).Land.Refused
			require.NotNil(t, refused)
			assert.Equal(t, []string{tc.code, tc.message}, []string{refused.Code, refused.Message})
		})
	}
}

// GitHub answering 405 because the pull request is already merged (a
// person merged it first) is no refusal: the TODO settles Merged by lookup
// once main contains the commit.
func TestMythicalMergeTodoMergedBeforeItsRequest(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Raced")
	h.fake.HoldMain()
	require.NoError(t, h.press(h.ctx, n, head))
	h.fake.OnNextRequest(http.MethodPut, fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pr), func() { h.fake.MergeAsPerson("rehearsal-owner/app", pr) })
	h.pass()
	require.Len(t, h.merges(), 1)
	assert.Equal(t, http.StatusMethodNotAllowed, h.merges()[0].Status)
	assert.Nil(t, h.land(n).Refused, "no refusal is shown")
	_, merge := h.mergeCard(n)
	assert.Equal(t, "merging", merge["state"])
	h.fake.ReleaseMain()
	h.pass()
	state, _ := h.mergeCard(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
}

// The retarget race, as the lead ruled (§10.6.2b): GitHub's merge takes no
// base, so the base is read at the press and again immediately before the
// claim, and a merge GitHub nonetheless made into another branch never
// shows Merged: its fence clears with a receipt naming the branch, the TODO
// is closed as a pull request closed on GitHub is, later TODOs are not held
// behind it, and the owner's log records it.
func TestMythicalMergeTodoRetargetRace(t *testing.T) {
	t.Run("retargeted before the claim", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, pr := h.first("Retargeted")
		require.NoError(t, h.press(h.ctx, n, head))
		h.fake.OnNextRequest(http.MethodGet, "/repos/rehearsal-owner/app/collaborators/rehearsal-owner/permission", func() {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.Base.Ref = "release" })
		})
		h.pass()
		h.refused(n, "state", "PR no longer targets main on GitHub")
	})
	t.Run("merged into another branch", func(t *testing.T) {
		h := newMergeHarness(t)
		var logs bytes.Buffer
		h.service.logger = slog.New(slog.NewJSONHandler(&logs, nil))
		n, head, pr := h.first("Elsewhere")
		second, _, _ := h.todoInReview("Behind", h.item(n).CandidateHead)
		require.NoError(t, h.press(h.ctx, n, head))
		h.fake.OnNextRequest(http.MethodPut, fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pr), func() {
			h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.Base.Ref = "release" })
		})
		h.pass()
		require.Len(t, h.merges(), 1)
		assert.Equal(t, http.StatusOK, h.merges()[0].Status, "GitHub merged it into release")
		item := h.item(n)
		assert.Empty(t, item.PendingOp, "the fence clears")
		assert.NotEqual(t, "landed", item.State, "never Merged")
		refused := mythicalChecksOf(item).Land.Refused
		require.NotNil(t, refused)
		const elsewhere = "GitHub merged the pull request into release, not main"
		assert.Equal(t, []string{"github", elsewhere}, []string{refused.Code, refused.Message})
		state, merge := h.mergeCard(n)
		assert.NotEqual(t, "merged", state)
		assert.Equal(t, map[string]any{"state": "blocked", "reason": "github", "detail": elsewhere, "on_github": true}, merge)
		var drop *TodoControlError
		if errors.As(todoControlGuard(item, TodoControlInput{Op: "drop"}, todoControlFacts{}), &drop) {
			assert.NotEqual(t, "merging", drop.Code, "no fence holds Drop")
		}
		_, merge = h.mergeCard(second)
		assert.NotEqual(t, "order", merge["reason"], "later TODOs are not held behind it")
		assert.Contains(t, logs.String(), `"msg":"mythical.merge_off_main"`)
		assert.Contains(t, logs.String(), `"base":"release"`)
		h.pass()
		assert.Len(t, h.merges(), 1)
		assert.NotEqual(t, "landed", h.item(n).State)
	})
}

// The squash commit title is the TODO's stored title, so CI-skip directives
// in it are made plain, as closing keywords are.
func TestMythicalMergeCommitNeutralizesDirectives(t *testing.T) {
	head := strings.Repeat("a", 40)
	for title, want := range map[string]string{
		"Add a greeting":                            "Add a greeting (#7)",
		"Fixes #12 greet":                           "Refs #12 greet (#7)",
		"Greet [skip ci]":                           "Greet (skip ci) (#7)",
		"[CI SKIP] greet [no ci]":                   "(CI SKIP) greet (no ci) (#7)",
		"Greet [ skip actions ] and [actions skip]": "Greet (skip actions) and (actions skip) (#7)",
		"Greet skip-checks: true":                   "Greet skip-checks true (#7)",
		"Greet\n\nskip-checks:true":                 "Greet skip-checks true (#7)",
	} {
		item := db.MythicalItem{Number: pgtype.Int8{Int64: 3, Valid: true}, Title: pgtype.Text{String: title, Valid: true}}
		commit := mythicalMergeCommit(item, 7, head)
		assert.Equal(t, want, commit.Title, title)
		assert.Equal(t, "TODO T3, reviewed at "+head+".", commit.Message)
	}
}

// The claim takes every lock it needs (the stack, the TODO, the session,
// the person, the owner) before it reads the time: an approval or a session
// that expires while the claim waits on the owner's row or the stack's is
// not sent.
func TestMythicalMergeTodoClaimReadsTheTimeAfterItsLocks(t *testing.T) {
	const ended = "The approving browser session has ended; sign in again to merge"
	const unfinished = "The merge did not complete within 10 minutes; press Merge again"
	for _, lock := range []struct {
		name, sql string
		repo      bool
	}{
		{"owner row", `SELECT 1 FROM self_host_owners WHERE singleton FOR UPDATE`, false},
		{"stack row", `SELECT 1 FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, true},
	} {
		for _, deadline := range []struct {
			name, code, message string
			expire              func(h *mergeHarness, n int64, at time.Time)
		}{
			{"approval", "github", unfinished, func(h *mergeHarness, n int64, at time.Time) { h.approvedAt(n, at.Add(-mythicalMergeExpiry)) }},
			{"session", "unauthenticated", ended, func(h *mergeHarness, _ int64, at time.Time) {
				h.exec(`UPDATE auth_sessions SET expires_at = $2 WHERE session_key = $1`, h.session, at)
			}},
		} {
			t.Run(lock.name+" across the "+deadline.name+"'s expiry", func(t *testing.T) {
				h := newMergeHarness(t)
				n, head, pr := h.first("Locked")
				require.NoError(t, h.press(h.ctx, n, head))
				var args []any
				if lock.repo {
					args = append(args, h.repoID)
				}
				release := h.holdRow(pr, lock.sql, args...)
				at := time.Now().Add(15 * time.Second)
				deadline.expire(h, n, at)
				done := h.passAsync()
				h.waitForTheClaim()
				time.Sleep(time.Until(at) + time.Second)
				release()
				require.NoError(t, <-done)
				h.refused(n, deadline.code, deadline.message)
			})
		}
	}
}

// A worker that stops after its claim committed and before the request
// left: recovery never sends it, never ends it by the bound, and the stack
// waits behind it; GitHub showing the pull request closed (or at another
// head) ends it.
func TestMythicalMergeTodoStopBetweenTheClaimAndTheRequest(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Stopped")
	second, _, _ := h.todoInReview("Behind", h.item(n).CandidateHead)
	require.NoError(t, h.press(h.ctx, n, head))
	prepare := h.service.outbound.PrepareMerge
	h.service.outbound.PrepareMerge = func(st *mythicalItemStep, ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) (mythicalMergeDispatch, error) {
		dispatch, err := prepare(st, ctx, item, op)
		dispatch.send = func(context.Context, db.MythicalItem) error {
			return errors.New("the worker stopped before the request left")
		}
		return dispatch, err
	}
	h.pass()
	h.service.outbound.PrepareMerge = prepare
	assert.Empty(t, h.merges())
	assert.Equal(t, "unknown", h.operation(n).State, "the claim committed")

	h.approvedAt(n, time.Now().Add(-mythicalMergeExpiry-time.Minute))
	h.pass()
	h.pass()
	assert.Empty(t, h.merges(), "a claimed merge is never sent by recovery")
	assert.Equal(t, "unknown", h.operation(n).State, "nor ended by the bound")
	_, merge := h.mergeCard(n)
	assert.Equal(t, map[string]any{"state": "merging", "reason": "merging", "on_github": true}, merge)
	_, merge = h.mergeCard(second)
	assert.Equal(t, "order", merge["reason"], "the stack waits behind it")

	h.fake.UpdatePull("rehearsal-owner/app", pr, func(p *githubfake.Pull) { p.State = "closed" })
	h.pass()
	h.refused(n, "state", "PR is closed on GitHub")
}

// A merge request GitHub accepted and has not completed is bound to the
// head it named: a head that moves before Smithers looks ends the merge and
// GitHub's later completion merges nothing; a head moved and restored
// before Smithers looks keeps it, and GitHub's completion is the one merge.
func TestMythicalMergeTodoDelayedRequestIsHeadBound(t *testing.T) {
	t.Run("moved", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, pr := h.first("Moved")
		h.fake.DelayNextMerge("rehearsal-owner/app", pr)
		require.NoError(t, h.press(h.ctx, n, head))
		h.pass()
		moved := h.push(n, "moved\n")
		h.pass()
		item := h.item(n)
		assert.Empty(t, item.PendingOp, "the head moved: the sent merge ends")
		refused := mythicalChecksOf(item).Land.Refused
		require.NotNil(t, refused)
		assert.Equal(t, []string{"stale_head", "the pull request changed since you saw it"}, []string{refused.Code, refused.Message})
		h.fake.CompleteDelayedMerges()
		h.pass()
		pull := h.pull(pr)
		assert.False(t, pull.Merged, "the request named the reviewed head; GitHub merges nothing")
		assert.Equal(t, moved, pull.Head.SHA)
		assert.NotEqual(t, "landed", h.item(n).State)
		assert.Len(t, h.merges(), 1)
	})
	t.Run("restored", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, pr := h.first("Restored")
		h.fake.DelayNextMerge("rehearsal-owner/app", pr)
		require.NoError(t, h.press(h.ctx, n, head))
		h.pass()
		h.push(n, "moved\n")
		h.git(h.github, "update-ref", "refs/heads/"+mythicalChecksOf(h.item(n)).Branch, head)
		h.pass()
		assert.Equal(t, "unknown", h.operation(n).State, "open at the reviewed head: still the sent merge")
		h.fake.CompleteDelayedMerges()
		h.pass()
		state, _ := h.mergeCard(n)
		assert.Equal(t, "merged", state)
		assert.Len(t, h.merges(), 1)
	})
}

// movingPolicy is the owner's committed policy while main moves under it:
// set commits another projection.
type movingPolicy struct {
	mu      sync.Mutex
	current policyHost
}

func (m *movingPolicy) set(p policyHost) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.current = p
}

func (m *movingPolicy) now() policyHost {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.current
}

func (m *movingPolicy) ListBookmarks(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
	return m.now().ListBookmarks(ctx, owner, repo, cursor, limit)
}

func (m *movingPolicy) GetFileAtChange(ctx context.Context, owner, repo, change, path string) (repohost.FileContent, error) {
	return m.now().GetFileAtChange(ctx, owner, repo, change, path)
}

func (m *movingPolicy) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	return m.now().GetBookmark(ctx, owner, repo, name)
}

func (m *movingPolicy) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	return m.now().GetFileAtCommit(ctx, owner, repo, commit, path)
}

// mythicalClaimFirstLock is the claim's first lock: the repository's row.
const mythicalClaimFirstLock = `FROM repositories WHERE id = $1 FOR SHARE`

// heldAtTheClaim holds the repository's row, the claim's first lock, from
// the moment GitHub is next asked for pull request pr (dispatch's first
// read), so the claim waits before it takes any lock. commit runs change in
// that transaction and commits it: a change committed while the claim
// waits.
func (h *mergeHarness) heldAtTheClaim(pr int64) (commit func(change func(pgx.Tx))) {
	held := make(chan pgx.Tx, 1)
	h.fake.OnNextRequest(http.MethodGet, fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d", pr), func() {
		tx, err := h.pool.(*pgxpool.Pool).Begin(context.Background())
		if err == nil {
			_, err = tx.Exec(context.Background(), `SELECT 1 FROM repositories WHERE id = $1 FOR NO KEY UPDATE`, h.repoID)
		}
		if err != nil {
			panic(err)
		}
		held <- tx
	})
	var once sync.Once
	finish := func(change func(pgx.Tx)) {
		once.Do(func() {
			select {
			case tx := <-held:
				defer func() { _ = tx.Rollback(context.Background()) }()
				if change != nil {
					change(tx)
					require.NoError(h.t, tx.Commit(context.Background()))
				}
			default:
			}
		})
	}
	// A failed test still frees the lock, so its database can close.
	h.t.Cleanup(func() { finish(nil) })
	return finish
}

// waitForTheStatement waits until a statement containing text waits on a
// lock in this test's database.
func (h *mergeHarness) waitForTheStatement(text string) {
	h.t.Helper()
	h.waitForLocks(1, text)
}

// waitForLocks waits until at least n statements containing text wait on a
// lock in this test's database.
func (h *mergeHarness) waitForLocks(n int, text string) {
	h.t.Helper()
	for deadline := time.Now().Add(30 * time.Second); ; {
		var waiting int
		require.NoError(h.t, h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND strpos(query, $1) > 0`, text).Scan(&waiting))
		if waiting >= n {
			return
		}
		require.False(h.t, time.Now().After(deadline), "%d statements never waited on %q", n, text)
		time.Sleep(20 * time.Millisecond)
	}
}

// Every local fact the merge rests on is read again under the claim's
// locks (§10.6.2b): a change committed while the claim waits on its first
// lock sends nothing. A revocation is its refusal; a change of where the
// merge goes or through what is none: the fence stays and the next pass
// decides again. A changed TODO is decided by the pass that follows at once.
func TestMythicalMergeTodoEveryLocalFactIsReadUnderTheClaimsLocks(t *testing.T) {
	const ended = "The approving browser session has ended; sign in again to merge"
	const notOwner = "Merge requires an owner or maintainer browser session"
	const moved = "The GitHub account that approved this merge is no longer this person's"
	sql := func(statement string, args func(h *mergeHarness) []any) func(*mergeHarness, pgx.Tx) {
		return func(h *mergeHarness, tx pgx.Tx) {
			_, err := tx.Exec(context.Background(), statement, args(h)...)
			require.NoError(h.t, err, statement)
		}
	}
	person := func(h *mergeHarness) []any { return []any{h.userID} }
	repository := func(h *mergeHarness) []any { return []any{h.repoID} }
	for _, tc := range []struct {
		name   string
		change func(*mergeHarness, pgx.Tx)
		// code and message are the refusal; none leaves the fence.
		code, message string
	}{
		// The claim's save loses its race, so the next pass runs at once
		// (#3433) and refuses an approval of the TODO's older generation.
		{"TODO changed", sql(`UPDATE mythical_items SET generation = generation + 1, version = version + 1 WHERE repository_id = $1`, repository),
			"rechecking", "The merge approval no longer matches this TODO; review it again"},
		{"signed out", sql(`DELETE FROM auth_sessions WHERE user_id = $1`, person), "unauthenticated", ended},
		{"suspended", sql(`UPDATE users SET prohibit_login = true WHERE id = $1`, person), "unauthenticated", ended},
		{"owner changed", sql(`WITH next AS (INSERT INTO users(username,lower_username) VALUES ('next','next') RETURNING id)
			UPDATE self_host_owners SET user_id = (SELECT id FROM next) WHERE user_id = $1`, person), "permission", notOwner},
		{"GitHub account unlinked", sql(`DELETE FROM oauth_accounts WHERE user_id = $1`, person), "permission", moved},
		{"GitHub account linked to another person", sql(`WITH next AS (INSERT INTO users(username,lower_username) VALUES ('next','next') RETURNING id)
			UPDATE oauth_accounts SET user_id = (SELECT id FROM next) WHERE user_id = $1`, person), "permission", moved},
		{"another GitHub account linked", sql(`UPDATE oauth_accounts SET provider_user_id = '8' WHERE user_id = $1`, person), "permission", moved},
		{"policy no longer names them", func(h *mergeHarness, _ pgx.Tx) {
			h.service.policy.(*movingPolicy).set(mergePolicy("someone-else"))
		}, "permission", "only a maintainer the factory's policy names may merge a TODO"},
		{"stack account changed", sql(`WITH next AS (INSERT INTO users(username,lower_username) VALUES ('next','next') RETURNING id)
			UPDATE mythical_stacks SET actor_user_id = (SELECT id FROM next) WHERE repository_id = $1`, repository), "", ""},
		{"destination changed", sql(`UPDATE repositories SET mirror_destination = 'rehearsal-owner/elsewhere' WHERE id = $1`, repository), "", ""},
		{"connection removed", sql(`DELETE FROM repo_connections WHERE user_id = $1`, person), "", ""},
		{"App uninstalled from the repository", sql(`DELETE FROM github_app_installation_repositories WHERE owner_login_lower = 'rehearsal-owner' AND repo_name_lower = 'app' AND $1::bigint > 0`, person), "", ""},
		{"App replaced", sql(`UPDATE github_app SET id = id + 1 WHERE singleton AND $1::bigint > 0`, person), "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			h.service.SetPolicyReader(&movingPolicy{current: mergePolicy()})
			n, head, pr := h.first("Reread")
			require.NoError(t, h.press(h.ctx, n, head))
			commit := h.heldAtTheClaim(pr)
			done := h.passAsync()
			h.waitForTheStatement(mythicalClaimFirstLock)
			commit(func(tx pgx.Tx) { tc.change(h, tx) })
			require.NoError(t, <-done)
			if tc.code != "" {
				h.refused(n, tc.code, tc.message)
				return
			}
			assert.Empty(t, h.merges())
			assert.Equal(t, "intended", h.operation(n).State, "the fence stays for the next pass")
			assert.Nil(t, h.land(n).Refused)
		})
	}
}

// GitHub's facts cannot be locked: a claim more than
// mythicalMergeFactsBound after the decision's last read of GitHub sends
// nothing, and the next pass reads GitHub again. Here the approver is
// demoted on GitHub while the claim waits longer than the bound.
func TestMythicalMergeTodoGitHubsFactsAreBoundedAtTheClaim(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Bounded")
	require.NoError(t, h.press(h.ctx, n, head))
	release := h.holdTodo(n, pr)
	done := h.passAsync()
	h.waitForTheClaim()
	h.fake.SetCollaborator(7, "rehearsal-owner", "read")
	time.Sleep(mythicalMergeFactsBound + time.Second)
	release()
	require.NoError(t, <-done)
	assert.Empty(t, h.merges(), "GitHub's facts were older than the bound: nothing is sent")
	assert.Equal(t, "intended", h.operation(n).State)
	assert.Nil(t, h.land(n).Refused, "no refusal: the next pass reads GitHub again")
	h.pass()
	h.refused(n, "permission", "only a maintainer of rehearsal-owner/app on GitHub may merge a TODO")
}

// The merge's destination is resolved and its token minted before the
// claim records the send (§10.6.2b): a mint that fails records nothing as
// sent and refuses nothing, and the next pass sends the one merge.
func TestMythicalMergeTodoFailedMintRecordsNothingSent(t *testing.T) {
	h := newMergeHarness(t)
	n, head, _ := h.first("Minted")
	require.NoError(t, h.press(h.ctx, n, head))
	h.fake.OnNextRequest(http.MethodGet, "/repos/rehearsal-owner/app/collaborators/rehearsal-owner/permission", func() {
		// GitHub's last authority read: the merge's token is minted next,
		// and GitHub fails the mint.
		invalidateCachedInstallationToken(h.installation)
		h.fake.FailNextWrites(fmt.Sprintf("/app/installations/%d/access_tokens", h.installation), 1)
	})
	h.pass()
	assert.Empty(t, h.merges())
	assert.Equal(t, "intended", h.operation(n).State, "nothing is recorded as sent")
	assert.Nil(t, h.land(n).Refused, "a failed mint refuses nothing")
	h.pass()
	require.Len(t, h.merges(), 1)
	assert.Equal(t, http.StatusOK, h.merges()[0].Status)
}

// A run's projection and the merge claim take the stack's row before the
// TODO's: a projection that arrives while the claim waits for the stack
// completes after the claim, and PostgreSQL ends neither as a deadlock.
func TestMythicalMergeTodoProjectionDuringTheClaimDoesNotDeadlock(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.first("Projected")
	require.NoError(t, h.press(h.ctx, n, head))
	const stackLock = `FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`
	release := h.holdRow(pr, `SELECT 1 `+stackLock, h.repoID)
	done := h.passAsync()
	h.waitForTheStatement(stackLock)
	item := h.item(n)
	projection, err := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Generation: item.Generation, Attempt: item.Attempt, Phase: "request"})
	require.NoError(t, err)
	projected := make(chan error, 1)
	go func() {
		projected <- h.service.ProjectFlowRuntime(context.Background(), flowdispatch.ProjectionUpdate{State: jobs.StateRunning,
			Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "run-projected", Projection: projection}})
	}()
	h.waitForLocks(2, "")
	release()
	require.NoError(t, <-projected, "the projection is not ended as a deadlock")
	require.NoError(t, <-done)
	require.Len(t, h.merges(), 1, "the claim is not ended as a deadlock: one merge")
	assert.Equal(t, "run-projected", h.item(n).RequestRunID, "the projection's write is kept")
}
