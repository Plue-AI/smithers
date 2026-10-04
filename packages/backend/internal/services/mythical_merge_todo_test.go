package services

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
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

func openPolicy(t *testing.T) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"on": []any{}, "github": map[string]any{"mirror": "pull", "issues": "two-way",
		"changes": "send-upstream", "dailyTokens": 1_000_000_000_000}})
	require.NoError(t, err)
	return string(raw)
}

// fakeAppTokens mints installation tokens from the GitHub fake the way the
// install's App does: a JWT signed with the App's key, exchanged for one.
type fakeAppTokens struct {
	fake *githubfake.Server
	key  *rsa.PrivateKey
}

func (f fakeAppTokens) mint() (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{"iss": "42", "iat": time.Now().Add(-time.Minute).Unix(), "exp": time.Now().Add(5 * time.Minute).Unix()})
	unsigned := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	request, _ := http.NewRequest(http.MethodPost, f.fake.URL+"/app/installations/91/access_tokens", bytes.NewReader([]byte(`{}`)))
	request.Header.Set("Authorization", "Bearer "+unsigned+"."+base64.RawURLEncoding.EncodeToString(signature))
	response, err := f.fake.Client().Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	var token struct{ Token string }
	if err := json.NewDecoder(response.Body).Decode(&token); err != nil || token.Token == "" {
		return "", fmt.Errorf("installation token refused: %d", response.StatusCode)
	}
	return token.Token, nil
}

func (f fakeAppTokens) CreateGitHubInstallationTokenForRepositoryOwner(context.Context, int64, int64, string, string, map[string]string) (GitHubInstallationToken, error) {
	token, err := f.mint()
	return GitHubInstallationToken{Token: token}, err
}

// resolvedGitHub is the stack's real GitHub client against the fake, with
// the destination the install's repository binding resolves to.
type resolvedGitHub struct {
	*mythicalGitHubAPI
	gh mythicalGitHubRepo
}

func (g resolvedGitHub) Resolve(context.Context, db.Repository, string, int64) (mythicalGitHubRepo, error) {
	return g.gh, nil
}

// mergeHarness is an install whose owner (GitHub account 7, acme) is signed
// in with a browser session, its acme/app stack active, against the GitHub
// fake and real PostgreSQL. The outbound guards owned by other tickets are
// injected as allowing; the merge providers are the production ones.
type mergeHarness struct {
	t       *testing.T
	ctx     context.Context
	pool    *pgxpool.Pool
	q       *db.Queries
	fake    *githubfake.Server
	api     *mythicalGitHubAPI
	gh      mythicalGitHubRepo
	service *MythicalService
	repoID  int64
	userID  int64
	session string
	// lose drops Send's next answer after GitHub received it.
	lose bool
}

func newMergeHarness(t *testing.T) *mergeHarness {
	t.Helper()
	ctx := context.Background()
	pool := newProductTestPool(t)
	h := &mergeHarness{t: t, pool: pool, q: db.New(pool)}
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,is_active) VALUES ('acme','acme',true) RETURNING id`).Scan(&h.userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'app','app') RETURNING id`, h.userID).Scan(&h.repoID))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, h.userID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id) VALUES (1,$1,'github','7')`, h.userID)
	require.NoError(t, err)
	digest := sha256.Sum256([]byte("owner-browser-session"))
	h.session = hex.EncodeToString(digest[:])
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,'acme',NOW() + interval '1 hour')`, h.session, h.userID)
	require.NoError(t, err)
	_, err = h.q.RequestMythicalBootstrap(ctx, h.repoID, h.userID, 100, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state = 'active' WHERE repository_id = $1`, h.repoID)
	require.NoError(t, err)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	h.fake, err = githubfake.New(githubfake.Config{AppID: 42, Slug: "smithers-test", OwnerLogin: "acme", ClientID: "Iv1.fake", ClientSecret: "secret",
		PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})),
		Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(h.fake.Close)
	tokens := fakeAppTokens{fake: h.fake, key: key}
	transport := &landingGitHubAPI{client: h.fake.Client(), baseURL: func() string { return h.fake.URL }}
	h.api = &mythicalGitHubAPI{credentials: outboundTestCredentials{}, api: transport, text: &gitHubIssueTextAPI{api: transport}, tokens: tokens}
	read, err := tokens.mint()
	require.NoError(t, err)
	h.gh = mythicalGitHubRepo{Owner: "acme", Name: "app", Token: read}

	h.service = NewMythicalService(pool, nil)
	h.service.SetOrchestration(resolvedGitHub{h.api, h.gh}, nil, nil)
	h.service.SetPolicyReader(policyHost{openPolicy(t)})
	allow := func(context.Context, db.MythicalItem, string) error { return nil }
	h.service.outbound = MythicalOutboundProviders{CanonicalApp: allow, StackLease: allow, Budget: allow, Membership: allow, Authorization: allow, AcceptedGeneration: allow,
		MergeDecision: h.service.MergeDecision, Lookup: (*mythicalItemStep).appLookup, Settle: (*mythicalItemStep).appSettle,
		Send: func(st *mythicalItemStep, ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) error {
			err := st.appSend(ctx, item, op)
			if h.lose {
				h.lose = false
				return errors.New("GitHub's answer was lost")
			}
			return err
		}}
	h.ctx = h.as(&middleware.AuthInfo{User: &db.User{ID: h.userID, Username: "acme"}, SessionHash: h.session})
	return h
}

func (h *mergeHarness) as(info *middleware.AuthInfo) context.Context {
	return middleware.ContextWithAuthInfo(context.Background(), info)
}

// todoInReview files a TODO through FileTodo, opens its PR on GitHub as the
// App does and records it in review at generation 1: the state T-STK-01's
// lifecycle leaves a TODO in, which is dark on main.
func (h *mergeHarness) todoInReview(title string) (int64, string, int64) {
	h.t.Helper()
	view, err := h.service.FileTodo(h.ctx, h.repoID, h.userID, MythicalTodoInput{Title: title, Prompt: "Do " + title, Request: "request-" + title})
	require.NoError(h.t, err)
	pull, err := h.api.CreatePull(context.Background(), h.gh, title, "smithers/"+strings.ToLower(title), "main", "Do "+title, false)
	require.NoError(h.t, err)
	_, err = h.pool.Exec(context.Background(), `UPDATE mythical_items SET state = 'proposed', pr_number = $2, pr_url = $3, pr_state = 'open', pr_head = $4,
		candidate_verified = true, generation = 1, checks = checks || jsonb_build_object('review', jsonb_build_object('head', $4::text, 'verdict', 'approve'))
		WHERE repository_id = $1 AND number = $5`, h.repoID, pull.Number, pull.URL, pull.HeadSHA, view.Number)
	require.NoError(h.t, err)
	return view.Number, pull.HeadSHA, pull.Number
}

func (h *mergeHarness) item(number int64) db.MythicalItem {
	h.t.Helper()
	item, err := h.q.GetMythicalItemByNumber(context.Background(), h.repoID, number)
	require.NoError(h.t, err)
	return item
}

func (h *mergeHarness) card(number int64) (string, map[string]any) {
	h.t.Helper()
	card, err := h.service.Todo(context.Background(), h.repoID, number)
	require.NoError(h.t, err)
	return card["state"].(string), card["merge"].(map[string]any)
}

// pass runs one claimed stack pass over the items, as the worker does when
// the repository's main has not moved locally.
func (h *mergeHarness) pass() {
	h.t.Helper()
	ctx := context.Background()
	_, err := h.q.RequestMythicalStack(ctx, h.repoID)
	require.NoError(h.t, err)
	claims, err := h.q.ClaimMythicalStacks(ctx, 1, 600)
	require.NoError(h.t, err)
	require.Len(h.t, claims, 1)
	h.service.advanceItems(ctx, &mythicalRun{row: claims[0]})
	require.NoError(h.t, h.service.finish(ctx, claims[0], mythicalOutcome{state: "active", clearPending: true}))
}

// merges are GitHub's received merge requests: path, status and body.
func (h *mergeHarness) merges() []githubfake.Write {
	out := []githubfake.Write{}
	for _, write := range h.fake.Writes() {
		if write.Method == http.MethodPut && strings.HasSuffix(write.Path, "/merge") {
			out = append(out, write)
		}
	}
	return out
}

func (h *mergeHarness) pull(number int64) mythicalPull {
	h.t.Helper()
	pull, err := h.api.Pull(context.Background(), h.gh, number)
	require.NoError(h.t, err)
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

func refusalOf(t *testing.T, err error) *TodoControlError {
	t.Helper()
	var refusal *TodoControlError
	require.ErrorAs(t, err, &refusal)
	return refusal
}

// A browser-session owner merges a TODO filed through /api/todos: the press
// records one session approval for the generation and reviewed head with
// the fence, the worker sends exactly one sha-bound squash merge through the
// App, and the TODO is Merged only once GitHub reports it and main has it.
func TestMythicalMergeTodoSquashesAtTheReviewedHead(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.todoInReview("First")
	state, merge := h.card(n)
	require.Equal(t, "in_review", state)
	require.Equal(t, map[string]any{"state": "ready", "on_github": true}, merge)

	_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: strings.ToUpper(head)})
	require.NoError(t, err)
	item := h.item(n)
	assert.Equal(t, &mythicalLand{By: "acme", Account: 7, Generation: 1, Session: h.session, Head: head}, mythicalChecksOf(item).Land)
	assert.Equal(t, MythicalOutboundOp{Kind: "merge", Target: strconv.FormatInt(pr, 10), Desired: head, Precondition: "open", State: "intended"}, h.operation(n))
	assert.Empty(t, h.merges(), "the press itself never calls GitHub's merge")
	state, merge = h.card(n)
	assert.Equal(t, "in_review", state)
	assert.Equal(t, map[string]any{"state": "merging", "reason": "merging", "on_github": true}, merge)

	// The same session pressing the same head again is the same request.
	_, err = h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
	require.NoError(t, err)
	assert.Equal(t, item.Version, h.item(n).Version)

	h.pass()
	merges := h.merges()
	require.Len(t, merges, 1)
	assert.Equal(t, fmt.Sprintf("/repos/acme/app/pulls/%d/merge", pr), merges[0].Path)
	assert.Equal(t, http.StatusOK, merges[0].Status)
	assert.JSONEq(t, `{"sha":"`+head+`","merge_method":"squash"}`, string(merges[0].Body))
	landed := h.item(n)
	require.Equal(t, "landed", landed.State, landed.Reason)
	assert.Empty(t, landed.PendingOp)
	assert.Equal(t, h.pull(pr).MergeCommit, landed.PRMergeCommit)
	state, merge = h.card(n)
	assert.Equal(t, "merged", state)
	assert.Equal(t, map[string]any{"state": "done", "on_github": true}, merge)
	h.pass()
	assert.Len(t, h.merges(), 1, "settlement and later passes never merge again")
}

// GitHub reporting the merge is not enough: the TODO stays in review, still
// fenced, until main contains the merge commit.
func TestMythicalMergeTodoWaitsForMainToContainTheMerge(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.todoInReview("Held")
	h.fake.HoldMain()
	_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
	require.NoError(t, err)
	h.pass()
	require.True(t, h.pull(pr).Merged)
	assert.Equal(t, "unknown", h.operation(n).State, "a sent merge keeps its fence until it settles")
	h.pass()
	state, merge := h.card(n)
	assert.Equal(t, "in_review", state, "a merge receipt alone is not completion")
	assert.Equal(t, "merging", merge["state"])
	assert.Equal(t, "merge", h.operation(n).Kind)

	h.fake.ReleaseMain()
	h.pass()
	state, _ = h.card(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
}

// A merge GitHub refuses clears the fence, keeps the approval with GitHub's
// words as its receipt and shows them; it is never retried by itself. The
// person's next press sends it again.
func TestMythicalMergeTodoRefusedByGitHubStaysVisibleAndRetryable(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.todoInReview("Refused")
	const refusal = "Base branch was modified. Review and try the merge again."
	h.fake.RefuseNextMerge("acme/app", pr, githubfake.Refusal{Status: http.StatusMethodNotAllowed, Message: refusal})
	_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
	require.NoError(t, err)
	h.pass()
	require.Len(t, h.merges(), 1)
	assert.Equal(t, http.StatusMethodNotAllowed, h.merges()[0].Status)
	item := h.item(n)
	assert.Empty(t, item.PendingOp, "a definitive refusal clears the fence")
	land := mythicalChecksOf(item).Land
	require.NotNil(t, land)
	require.NotNil(t, land.Refused)
	assert.Equal(t, mythicalMergeRefusal{Code: "github_refused", Class: "github", Message: refusal, At: land.Refused.At}, *land.Refused)
	assert.Equal(t, head, land.Head)
	state, merge := h.card(n)
	assert.Equal(t, "in_review", state)
	assert.Equal(t, map[string]any{"state": "blocked", "reason": "github", "detail": refusal, "on_github": true}, merge)

	h.pass()
	assert.Len(t, h.merges(), 1, "a retained approval is not permission to retry")

	_, err = h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
	require.NoError(t, err)
	assert.Nil(t, mythicalChecksOf(h.item(n)).Land.Refused)
	h.pass()
	state, _ = h.card(n)
	assert.Equal(t, "merged", state)
	require.Len(t, h.merges(), 2)
	assert.Equal(t, http.StatusOK, h.merges()[1].Status)
}

// A send whose answer is lost is looked up before anything else: GitHub
// merged it, so it settles without a second merge request.
func TestMythicalMergeTodoLostAnswerSettlesByLookup(t *testing.T) {
	h := newMergeHarness(t)
	n, head, _ := h.todoInReview("Lost")
	h.lose = true
	_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
	require.NoError(t, err)
	h.pass()
	assert.Equal(t, "unknown", h.operation(n).State)
	h.pass()
	state, _ := h.card(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
}

// Each live fact or authority that fails before send clears the fence with
// its refusal and sends no merge.
func TestMythicalMergeTodoDispatchRechecksBeforeSend(t *testing.T) {
	for _, tc := range []struct {
		name, code, message string
		change              func(h *mergeHarness, pr int64, head string)
	}{
		{"head moved on GitHub", "stale_head", "the pull request changed since you saw it", func(h *mergeHarness, pr int64, _ string) {
			h.fake.UpdatePull("acme/app", pr, func(p *githubfake.Pull) { p.Head.SHA = strings.Repeat("b", 40) })
		}},
		{"required check failed", "checks", "unit", func(h *mergeHarness, _ int64, head string) {
			h.fake.RequireCheck("unit")
			h.fake.SetCheck("acme/app", head, "unit", "completed", "failure")
		}},
		{"required check pending", "checks", "integration", func(h *mergeHarness, _ int64, head string) {
			h.fake.RequireCheck("unit")
			h.fake.RequireCheck("integration")
			h.fake.SetCheck("acme/app", head, "unit", "completed", "success")
		}},
		{"draft", "github", "PR is still draft on GitHub", func(h *mergeHarness, pr int64, _ string) {
			h.fake.UpdatePull("acme/app", pr, func(p *githubfake.Pull) { p.Draft = true })
		}},
		{"not mergeable", "github", "GitHub reports this PR is not mergeable", func(h *mergeHarness, pr int64, _ string) {
			h.fake.UpdatePull("acme/app", pr, func(p *githubfake.Pull) { p.MergeableState = "dirty" })
		}},
		{"still computing", "github", "GitHub is still computing mergeability", func(h *mergeHarness, pr int64, _ string) {
			h.fake.UpdatePull("acme/app", pr, func(p *githubfake.Pull) { p.MergeableState = "unknown" })
		}},
		{"closed", "state", "PR is closed on GitHub", func(h *mergeHarness, pr int64, _ string) {
			h.fake.UpdatePull("acme/app", pr, func(p *githubfake.Pull) { p.State = "closed" })
		}},
		{"session revoked", "unauthenticated", "The approving browser session has ended; sign in again to merge", func(h *mergeHarness, _ int64, _ string) {
			_, err := h.pool.Exec(context.Background(), `DELETE FROM auth_sessions WHERE session_key = $1`, h.session)
			require.NoError(h.t, err)
		}},
		{"policy stops naming the person", "permission", "only a maintainer the factory's policy names may merge a TODO", func(h *mergeHarness, _ int64, _ string) {
			h.service.SetPolicyReader(policyHost{mythicalPolicy("")})
		}},
		{"ownership moved", "permission", "Merge requires an owner or maintainer browser session", func(h *mergeHarness, _ int64, _ string) {
			_, err := h.pool.Exec(context.Background(), `WITH other AS (INSERT INTO users(username,lower_username) VALUES ('next','next') RETURNING id)
				UPDATE self_host_owners SET user_id = (SELECT id FROM other)`)
			require.NoError(h.t, err)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.todoInReview("Recheck")
			_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
			require.NoError(t, err)
			tc.change(h, pr, head)
			h.pass()
			assert.Empty(t, h.merges())
			item := h.item(n)
			assert.Empty(t, item.PendingOp)
			land := mythicalChecksOf(item).Land
			require.NotNil(t, land)
			require.NotNil(t, land.Refused)
			assert.Equal(t, tc.code, land.Refused.Code)
			assert.Equal(t, tc.message, land.Refused.Message)
			_, merge := h.card(n)
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

// A failing check main does not require blocks nothing.
func TestMythicalMergeTodoOptionalCheckDoesNotBlock(t *testing.T) {
	h := newMergeHarness(t)
	n, head, _ := h.todoInReview("Optional")
	h.fake.RequireCheck("unit")
	h.fake.SetCheck("acme/app", head, "unit", "completed", "success")
	h.fake.SetCheck("acme/app", head, "lint", "completed", "failure")
	_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
	require.NoError(t, err)
	h.pass()
	state, _ := h.card(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
}

// The press refuses, before any approval or fence, each row that fails and
// each person GitHub or the policy does not count a maintainer.
func TestMythicalMergeTodoRefusesBeforeApproval(t *testing.T) {
	h := newMergeHarness(t)
	first, firstHead, _ := h.todoInReview("One")
	second, secondHead, _ := h.todoInReview("Two")
	queued, err := h.service.FileTodo(h.ctx, h.repoID, h.userID, MythicalTodoInput{Title: "Queued", Prompt: "Later", Request: "queued"})
	require.NoError(t, err)

	refuse := func(ctx context.Context, number int64, head string) *TodoControlError {
		t.Helper()
		_, err := h.service.MergeTodo(ctx, h.repoID, h.userID, number, MythicalMergeInput{Head: head})
		return refusalOf(t, err)
	}
	stale := refuse(h.ctx, first, strings.Repeat("c", 40))
	assert.Equal(t, "stale_head", stale.Code)
	var current *MythicalStaleHeadError
	_, err = h.service.MergeTodo(h.ctx, h.repoID, h.userID, first, MythicalMergeInput{Head: strings.Repeat("c", 40)})
	require.ErrorAs(t, err, &current)
	assert.Equal(t, firstHead, current.CurrentHead, "the current head is reported, never substituted")

	order := refuse(h.ctx, second, secondHead)
	assert.Equal(t, TodoControlError{Status: 409, Code: "order", Class: "conflict", Message: fmt.Sprintf("Merges after T%d", first)}, *order)
	_, merge := h.card(second)
	assert.Equal(t, map[string]any{"state": "waiting", "reason": "order", "detail": fmt.Sprintf("T%d", first), "on_github": true}, merge)
	assert.Equal(t, "state", refuse(h.ctx, queued.Number, firstHead).Code)
	assert.Equal(t, "todo_not_found", refuse(h.ctx, 999, firstHead).Code)
	assert.Equal(t, "invalid_reviewed_head_sha", refuse(h.ctx, first, "HEAD").Code)

	_, err = h.service.MergeTodo(h.ctx, h.repoID, h.userID, first, MythicalMergeInput{Head: firstHead})
	require.NoError(t, err)
	_, err = h.pool.Exec(context.Background(), `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ('another-browser',$1,'acme',NOW() + interval '1 hour')`, h.userID)
	require.NoError(t, err)
	other := h.as(&middleware.AuthInfo{User: &db.User{ID: h.userID}, SessionHash: "another-browser"})
	assert.Equal(t, "merging", refuse(other, first, firstHead).Code, "another press during the fence is refused")
	assert.Equal(t, h.session, mythicalChecksOf(h.item(first)).Land.Session)

	h.service.SetPolicyReader(policyHost{mythicalPolicy("")})
	assert.Equal(t, TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: "only a maintainer the factory's policy names may merge a TODO"}, *refuse(h.ctx, second, secondHead))
	h.service.SetPolicyReader(policyHost{openPolicy(t)})
	_, err = h.pool.Exec(context.Background(), `DELETE FROM oauth_accounts WHERE user_id = $1`, h.userID)
	require.NoError(t, err)
	assert.Equal(t, "connect your GitHub account to merge a TODO", refuse(h.ctx, second, secondHead).Message)

	h.service.outbound = MythicalOutboundProviders{}
	_, err = h.pool.Exec(context.Background(), `INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id) VALUES (2,$1,'github','7')`, h.userID)
	require.NoError(t, err)
	_, err = h.pool.Exec(context.Background(), `UPDATE mythical_items SET pending_op = NULL WHERE repository_id = $1`, h.repoID)
	require.NoError(t, err)
	unwired := refuse(h.ctx, first, firstHead)
	assert.Equal(t, "rechecking", unwired.Code, "no approval is recorded that no worker could send")
	assert.Equal(t, "Waiting for canonical App integration", unwired.Message)

	assert.Empty(t, h.merges())
	assert.Nil(t, mythicalChecksOf(h.item(second)).Land)
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

func TestMythicalMergeMalformedSHABeforeReads(t *testing.T) {
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "session"})
	for _, sha := range []string{"", "HEAD", strings.Repeat("a", 39), strings.Repeat("a", 41), strings.Repeat("g", 40)} {
		_, err := (&MythicalService{}).Merge(ctx, 1, 7, "00000000-0000-4000-8000-000000000001", MythicalMergeInput{Head: sha})
		require.IsType(t, &TodoControlError{}, err)
		assert.Equal(t, 400, err.(*TodoControlError).Status)
		assert.Equal(t, "invalid_reviewed_head_sha", err.(*TodoControlError).Code)
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

// person signs a second Smithers user in with a browser session, linked to
// GitHub account id, and answers their request context.
func (h *mergeHarness) person(login string, id int64) (int64, context.Context) {
	h.t.Helper()
	ctx := context.Background()
	var userID int64
	require.NoError(h.t, h.pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,is_active) VALUES ($1,$1,true) RETURNING id`, login).Scan(&userID))
	_, err := h.pool.Exec(ctx, `INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id) VALUES ($1,$2,'github',$3)`, 100+id, userID, strconv.FormatInt(id, 10))
	require.NoError(h.t, err)
	digest := sha256.Sum256([]byte(login + "-browser-session"))
	session := hex.EncodeToString(digest[:])
	_, err = h.pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,$3,NOW() + interval '1 hour')`, session, userID, login)
	require.NoError(h.t, err)
	return userID, h.as(&middleware.AuthInfo{User: &db.User{ID: userID, Username: login}, SessionHash: session})
}

// unfenced asserts the press recorded no approval or fence and GitHub
// received no merge.
func (h *mergeHarness) unfenced(number int64) {
	h.t.Helper()
	item := h.item(number)
	assert.Nil(h.t, mythicalChecksOf(item).Land)
	assert.Empty(h.t, item.PendingOp)
	assert.Empty(h.t, h.merges())
}

// The press and the worker apply one authority rule: a person the worker
// would refuse is refused at the press, before any approval or fence, so a
// 202 never hides a merge that cannot happen.
func TestMythicalMergeTodoAuthorityIsOneRuleAtPressAndDispatch(t *testing.T) {
	t.Run("maintainer who is not the install owner", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, _ := h.todoInReview("Maintainer")
		h.fake.SetCollaborator(8, "bea", "maintain")
		bea, ctx := h.person("bea", 8)
		_, err := h.service.Merge(ctx, h.repoID, bea, uuidString(h.item(n).ID), MythicalMergeInput{Head: head})
		assert.Equal(t, TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: "Merge requires an owner or maintainer browser session"}, *refusalOf(t, err))
		h.unfenced(n)
		h.pass()
		assert.Empty(t, h.merges())
	})
	t.Run("session filed before keys were hashed", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, _ := h.todoInReview("Legacy")
		const raw = "6f1d1f4e-7a3c-4c5e-9d55-3b8f0d2c1a90"
		_, err := h.pool.Exec(context.Background(), `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,'acme',NOW() + interval '1 hour')`, raw, h.userID)
		require.NoError(t, err)
		digest := sha256.Sum256([]byte(raw))
		legacy := h.as(&middleware.AuthInfo{User: &db.User{ID: h.userID, Username: "acme"}, SessionHash: hex.EncodeToString(digest[:])})
		_, err = h.service.MergeTodo(legacy, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
		assert.Equal(t, TodoControlError{Status: 401, Code: "unauthenticated", Class: "permission", Message: "The approving browser session has ended; sign in again to merge"}, *refusalOf(t, err),
			"dispatch could never find this session, so the press refuses it")
		h.unfenced(n)
	})
	t.Run("expired session", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, _ := h.todoInReview("Expired")
		_, err := h.pool.Exec(context.Background(), `UPDATE auth_sessions SET expires_at = NOW() - interval '1 second' WHERE session_key = $1`, h.session)
		require.NoError(t, err)
		_, err = h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
		assert.Equal(t, "unauthenticated", refusalOf(t, err).Code)
		h.unfenced(n)
	})
}

// GitHub no longer counting the person a maintainer refuses the press, and,
// when it changes after the press, the dispatch: no merge is sent, the fence
// clears and the card says why.
func TestMythicalMergeTodoGitHubDemotion(t *testing.T) {
	const demoted = "only a maintainer of acme/app on GitHub may merge a TODO"
	for _, permission := range []string{"read", "triage", "none"} {
		t.Run("at the press/"+permission, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.todoInReview("Demoted")
			h.fake.SetCollaborator(7, "acme", permission)
			_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
			assert.Equal(t, TodoControlError{Status: 403, Code: "permission", Class: "permission", Message: demoted}, *refusalOf(t, err))
			h.unfenced(n)
		})
	}
	t.Run("at dispatch", func(t *testing.T) {
		h := newMergeHarness(t)
		clock := time.Now()
		h.api.text.now = func() time.Time { return clock }
		n, head, _ := h.todoInReview("Later")
		_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
		require.NoError(t, err)
		h.fake.SetCollaborator(7, "acme", "read")
		clock = clock.Add(gitHubMaintainerTTL + time.Second)
		h.pass()
		assert.Empty(t, h.merges())
		item := h.item(n)
		assert.Empty(t, item.PendingOp)
		require.NotNil(t, mythicalChecksOf(item).Land.Refused)
		assert.Equal(t, mythicalMergeRefusal{Code: "permission", Class: "permission", Message: demoted, At: mythicalChecksOf(item).Land.Refused.At}, *mythicalChecksOf(item).Land.Refused)
		_, merge := h.card(n)
		assert.Equal(t, map[string]any{"state": "ready", "detail": demoted, "on_github": true}, merge)

		h.fake.SetCollaborator(7, "acme", "admin")
		clock = clock.Add(gitHubMaintainerTTL + time.Second)
		_, err = h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
		require.NoError(t, err, "promoted again, the next press merges")
		h.pass()
		state, _ := h.card(n)
		assert.Equal(t, "merged", state)
		assert.Len(t, h.merges(), 1)
	})
}

// The repository door names the item by id within its repository; a
// malformed id, an unknown one or another repository's item is refused
// before any approval.
func TestMythicalMergeRepositoryDoor(t *testing.T) {
	h := newMergeHarness(t)
	n, head, pr := h.todoInReview("Door")
	id := uuidString(h.item(n).ID)

	_, err := h.service.Merge(h.ctx, h.repoID, h.userID, "not-a-uuid", MythicalMergeInput{Head: head})
	var invalid *pkgerrors.APIError
	require.ErrorAs(t, err, &invalid)
	assert.Equal(t, http.StatusBadRequest, invalid.Status)
	assert.Equal(t, "invalid item id", invalid.Message)

	_, err = h.service.Merge(h.ctx, h.repoID, h.userID, "00000000-0000-4000-8000-000000000001", MythicalMergeInput{Head: head})
	assert.Equal(t, TodoControlError{Status: 404, Code: "todo_not_found", Class: "user", Message: "TODO not found"}, *refusalOf(t, err))

	var other int64
	require.NoError(t, h.pool.QueryRow(context.Background(), `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'other','other') RETURNING id`, h.userID).Scan(&other))
	_, err = h.service.Merge(h.ctx, other, h.userID, id, MythicalMergeInput{Head: head})
	assert.Equal(t, "todo_not_found", refusalOf(t, err).Code, "another repository's item is not found through this door")
	h.unfenced(n)

	view, err := h.service.Merge(h.ctx, h.repoID, h.userID, strings.ToUpper(id), MythicalMergeInput{Head: head})
	require.NoError(t, err)
	assert.Equal(t, n, view.Number)
	assert.Equal(t, "merge", h.operation(n).Kind)
	h.pass()
	merges := h.merges()
	require.Len(t, merges, 1)
	assert.Equal(t, fmt.Sprintf("/repos/acme/app/pulls/%d/merge", pr), merges[0].Path)
	state, _ := h.card(n)
	assert.Equal(t, "merged", state)
}

// A new generation voids the approval (§10.6.2c): dispatch sends nothing,
// clears the fence and keeps why; a press at the new generation merges.
func TestMythicalMergeTodoNewGenerationVoidsTheApproval(t *testing.T) {
	h := newMergeHarness(t)
	n, head, _ := h.todoInReview("Regenerated")
	_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
	require.NoError(t, err)
	_, err = h.pool.Exec(context.Background(), `UPDATE mythical_items SET generation = 2 WHERE repository_id = $1 AND number = $2`, h.repoID, n)
	require.NoError(t, err)
	h.pass()
	assert.Empty(t, h.merges())
	item := h.item(n)
	assert.Empty(t, item.PendingOp)
	land := mythicalChecksOf(item).Land
	require.NotNil(t, land.Refused)
	assert.Equal(t, int64(1), land.Generation)
	assert.Equal(t, "rechecking", land.Refused.Code)
	assert.Equal(t, "The merge approval no longer matches this TODO; review it again", land.Refused.Message)
	_, merge := h.card(n)
	assert.Equal(t, map[string]any{"state": "ready", "on_github": true}, merge, "the old generation's approval blocks nothing")

	_, err = h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
	require.NoError(t, err)
	assert.Equal(t, int64(2), mythicalChecksOf(h.item(n)).Land.Generation)
	h.pass()
	state, _ := h.card(n)
	assert.Equal(t, "merged", state)
	assert.Len(t, h.merges(), 1)
}

// Presses racing each other record exactly one approval and fence: another
// session is refused as merging, the same session is answered again.
func TestMythicalMergeTodoConcurrentPressesRecordOneFence(t *testing.T) {
	for _, sameSession := range []bool{false, true} {
		t.Run(fmt.Sprintf("same session %t", sameSession), func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.todoInReview("Race")
			second := h.ctx
			if !sameSession {
				digest := sha256.Sum256([]byte("owner-second-browser"))
				key := hex.EncodeToString(digest[:])
				_, err := h.pool.Exec(context.Background(), `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,'acme',NOW() + interval '1 hour')`, key, h.userID)
				require.NoError(t, err)
				second = h.as(&middleware.AuthInfo{User: &db.User{ID: h.userID, Username: "acme"}, SessionHash: key})
			}
			before := h.item(n).Version
			start := make(chan struct{})
			errs := make(chan error, 2)
			for _, ctx := range []context.Context{h.ctx, second} {
				go func() {
					<-start
					_, err := h.service.MergeTodo(ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
					errs <- err
				}()
			}
			close(start)
			var refused []string
			for range 2 {
				if err := <-errs; err != nil {
					refused = append(refused, refusalOf(t, err).Code)
				}
			}
			if sameSession {
				assert.Empty(t, refused, "the same press is answered again")
			} else {
				assert.Equal(t, []string{"merging"}, refused)
			}
			item := h.item(n)
			assert.Equal(t, before+1, item.Version, "one approval and fence written")
			assert.Equal(t, "merge", h.operation(n).Kind)
			h.pass()
			assert.Len(t, h.merges(), 1)
		})
	}
}

// Main's required reviews (row 9) as real GitHub reports them: after
// required checks and before draft and mergeability, unmet reviews refuse
// as review_required and send no merge.
func TestMythicalMergeTodoRequiredReviews(t *testing.T) {
	const unmet = "Required reviews are not satisfied on GitHub"
	t.Run("unmet, then approved", func(t *testing.T) {
		h := newMergeHarness(t)
		n, head, pr := h.todoInReview("Reviewed")
		h.fake.RequireReviews(1)
		_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
		require.NoError(t, err)
		h.pass()
		assert.Empty(t, h.merges())
		item := h.item(n)
		assert.Empty(t, item.PendingOp)
		assert.Equal(t, "review_required", mythicalChecksOf(item).Land.Refused.Code)
		_, merge := h.card(n)
		assert.Equal(t, map[string]any{"state": "blocked", "reason": "review_required", "detail": unmet, "on_github": true}, merge)

		h.fake.Review("acme/app", pr, "bea", "APPROVED")
		_, err = h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
		require.NoError(t, err)
		h.pass()
		state, _ := h.card(n)
		assert.Equal(t, "merged", state)
		require.Len(t, h.merges(), 1)
		assert.Equal(t, http.StatusOK, h.merges()[0].Status)
	})
	for _, tc := range []struct {
		name, code, message string
		change              func(h *mergeHarness, pr int64, head string)
	}{
		{"changes requested", "review_required", unmet, func(h *mergeHarness, pr int64, _ string) {
			h.fake.Review("acme/app", pr, "bea", "APPROVED")
			h.fake.Review("acme/app", pr, "cy", "CHANGES_REQUESTED")
		}},
		{"required check first", "checks", "unit", func(h *mergeHarness, _ int64, head string) {
			h.fake.RequireCheck("unit")
			h.fake.SetCheck("acme/app", head, "unit", "completed", "failure")
		}},
		{"reviews before draft", "review_required", unmet, func(h *mergeHarness, pr int64, _ string) {
			h.fake.UpdatePull("acme/app", pr, func(p *githubfake.Pull) { p.Draft = true })
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, pr := h.todoInReview("Order")
			h.fake.RequireReviews(1)
			tc.change(h, pr, head)
			_, err := h.service.MergeTodo(h.ctx, h.repoID, h.userID, n, MythicalMergeInput{Head: head})
			require.NoError(t, err)
			h.pass()
			assert.Empty(t, h.merges())
			refused := mythicalChecksOf(h.item(n)).Land.Refused
			require.NotNil(t, refused)
			assert.Equal(t, []string{tc.code, tc.message}, []string{refused.Code, refused.Message})
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
		return mythicalPull{Number: 1, State: "open", HeadSHA: head, MergeableState: state}
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
