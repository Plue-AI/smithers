package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
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

// pull reads the pull request as GitHub serves it now.
func (h *mergeHarness) pull(number int64) githubfake.Pull {
	h.t.Helper()
	token, err := h.connections.CreateGitHubInstallationTokenForRepositoryOwner(context.Background(), h.userID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "read"})
	require.NoError(h.t, err)
	request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/repos/rehearsal-owner/app/pulls/%d", h.fake.URL, number), nil)
	require.NoError(h.t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := h.fake.Client().Do(request)
	require.NoError(h.t, err)
	defer response.Body.Close()
	var pull githubfake.Pull
	require.NoError(h.t, json.NewDecoder(response.Body).Decode(&pull))
	return pull
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

// A failure that settles nothing (GitHub answering 502, a read GitHub will
// not answer, main's protection unreadable) never loops forever: no merge
// GitHub has not received is sent once mythicalMergeExpiry has passed since
// the approval, and the fence clears with a receipt the person can act on.
// Unreadable protection is never taken for no protection.
func TestMythicalMergeTodoUnsettledMergeIsBounded(t *testing.T) {
	for _, tc := range []struct {
		name   string
		breaks func(h *mergeHarness, pr int64)
		sends  int
	}{
		{"merge answers 502", func(h *mergeHarness, pr int64) {
			h.fake.FailNextWrites(fmt.Sprintf("/repos/rehearsal-owner/app/pulls/%d/merge", pr), 100)
		}, 2},
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
			err := (&MythicalService{}).MergeDecision(context.Background(), tc.item, tc.op)
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
	var invalid *pkgerrors.APIError
	require.ErrorAs(t, err, &invalid)
	assert.Equal(t, http.StatusBadRequest, invalid.Status)
	assert.Equal(t, "invalid item id", invalid.Message)

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

	require.NoError(t, h.pressAs(h.ctx, "first", n, head), "a retry after the refusal answers the receipt")
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
	require.NoError(t, h.pressAs(h.ctx, "first", n, head), "an old request is answered, never renewed")
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
