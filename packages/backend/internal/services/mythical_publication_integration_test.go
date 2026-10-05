package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// publicationFixture is the install after setup: the owner signed in with
// GitHub, the App is installed on rehearsal-owner/app, and the repository's
// stack is active on the main both sides share. GitHub is githubfake over a
// real bare repository; Smithers' side is real PostgreSQL and real git.
type publicationFixture struct {
	*mythicalServiceFixture
	fake        *githubfake.Server
	github      string // GitHub's bare repository
	connections *RepoConnectionService
	credentials *GitHubAppCredentialStore
	main        string
	// installation is the App installation serving rehearsal-owner/app.
	installation int64
}

// publicationInstallations gives each fixture its own App installation id:
// installation tokens are cached process-wide by installation.
var publicationInstallations atomic.Int64

func newPublicationFixture(t *testing.T, private bool, issues ...int64) *publicationFixture {
	t.Helper()
	installation := 9100 + publicationInstallations.Add(1)
	f := newMythicalServiceFixture(t)
	ctx := context.Background()
	f.commit("✨ feat: journey", "JOURNEY.md", "Add a greeting to JOURNEY.md\n")
	main := f.publish()
	gitRoot := t.TempDir()
	github := filepath.Join(gitRoot, "rehearsal-owner", "app.git")
	f.git(f.root, "clone", "-q", "--bare", f.work, github)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	app := GitHubAppCredentials{ID: 42, Slug: "smithers-install", OwnerLogin: "rehearsal-owner", OwnerKind: "user", ClientID: "client",
		ClientSecret: "secret", WebhookSecret: "webhook", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	fake, err := githubfake.New(githubfake.Config{OAuthCode: "owner-code", GitRoot: gitRoot, AppID: app.ID, Slug: app.Slug, OwnerLogin: app.OwnerLogin, OwnerKind: app.OwnerKind,
		ClientID: app.ClientID, ClientSecret: app.ClientSecret, WebhookSecret: app.WebhookSecret, PrivateKeyPEM: app.PEM, ConversionCode: "manifest-code",
		Installations: []githubfake.Installation{{ID: installation, Repositories: []githubfake.Repository{{ID: 100, FullName: "rehearsal-owner/app", Private: private, Issues: issues}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", fake.URL)
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", fake.URL)
	// GitHub's side of setup: the App manifest converted and the owner's
	// OAuth grant exchanged (setup steps 2 and 3 run through the product in
	// the C-J1-04 rehearsal; here they are GitHub's state).
	for _, call := range []struct{ path, form string }{
		{"/app-manifests/manifest-code/conversions", ""},
		{"/login/oauth/access_token", url.Values{"code": {"owner-code"}, "client_id": {"client"}, "client_secret": {"secret"}, "redirect_uri": {"http://smithers.test/callback"}}.Encode()},
	} {
		response, err := fake.Client().Post(fake.URL+call.path, "application/x-www-form-urlencoded", strings.NewReader(call.form))
		require.NoError(t, err)
		require.Less(t, response.StatusCode, 300, call.path)
		require.NoError(t, response.Body.Close())
	}
	pool := f.pool.(*pgxpool.Pool)
	codec, err := webhook.NewSecretCodec("publication-sealing-key")
	require.NoError(t, err)
	credentials := NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, credentials.Save(ctx, app))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES ($1)`, f.userID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(id, user_id, provider, provider_user_id, profile_data) VALUES (1, $1, 'github', '7', '{"login":"rehearsal-owner"}')`, f.userID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE repositories SET mirror_destination = 'rehearsal-owner/app' WHERE id = $1`, f.repoID)
	require.NoError(t, err)
	// Only the stored token's decryption is a stand-in: the owner sign-in
	// suite proves sealing; every GitHub answer below comes from the fake.
	userRepos := NewGitHubUserReposService(db.New(pool), fakeOAuthTokenDecrypter{token: "ghu_githubfake_owner"})
	connections := NewRepoConnectionService(pool, credentials)
	connections.SetGitHubRepoAccessVerifier(userRepos)
	_, err = connections.ConnectRepo(ctx, f.userID, "rehearsal-owner", "app", "MIT")
	require.NoError(t, err)
	require.NoError(t, connections.ReconcileGitHubAppInstallations(ctx))
	f.service.SetOrchestration(NewMythicalGitHub(db.New(pool), connections, userRepos, connections), nil, nil)
	f.service.SetPublicURL("http://smithers.test")
	f.service.EnableTodoPublication(credentials, connections, NewBudgetTracker())
	_, err = f.service.RequestBootstrap(ctx, f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	require.Equal(t, "active", f.poll().State)
	return &publicationFixture{mythicalServiceFixture: f, fake: fake, github: github, connections: connections, credentials: credentials, main: main, installation: installation}
}

// todo files a TODO through FileTodo as the owner's browser session and
// makes its candidate the verified result of a run on base: a commit the
// host retains, as a finished run leaves it.
func (f *publicationFixture) todo(title, prompt, base, path, content string) db.MythicalItem {
	f.t.Helper()
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: f.userID}, SessionHash: "owner-session"})
	view, err := f.service.FileTodo(ctx, f.repoID, f.userID, MythicalTodoInput{Title: title, Prompt: prompt, Acceptance: []string{"JOURNEY.md greets"}, Request: title})
	require.NoError(f.t, err)
	f.git(f.work, "checkout", "-q", base)
	candidate := f.commit("candidate "+title, path, content)
	f.git(f.work, "push", "-q", f.hostDir, candidate+":"+repohost.MythicalReservedRefNS+"keep/"+candidate)
	q := db.New(f.pool)
	item, err := q.GetMythicalItemByNumber(context.Background(), f.repoID, view.Number)
	require.NoError(f.t, err)
	item.State, item.Attempt, item.CandidateBase, item.CandidateHead, item.CandidateVerified = "proposing", 1, base, candidate, true
	item, err = q.SaveMythicalItem(context.Background(), item)
	require.NoError(f.t, err)
	return item
}

// wake makes every item due and runs one claim of the stack worker.
func (f *publicationFixture) wake() {
	f.t.Helper()
	ctx := context.Background()
	_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, f.repoID)
	require.NoError(f.t, err)
	f.service.MainMoved(ctx, f.repoID)
	require.NoError(f.t, f.service.PollOnce(ctx))
}

func (f *publicationFixture) item(number int64) db.MythicalItem {
	f.t.Helper()
	item, err := db.New(f.pool).GetMythicalItemByNumber(context.Background(), f.repoID, number)
	require.NoError(f.t, err)
	return item
}

func (f *publicationFixture) card(number int64) map[string]any {
	f.t.Helper()
	card, err := f.service.Todo(context.Background(), f.repoID, number)
	require.NoError(f.t, err)
	raw, err := json.Marshal(card)
	require.NoError(f.t, err)
	var decoded map[string]any
	require.NoError(f.t, json.Unmarshal(raw, &decoded))
	return decoded
}

// githubRef reads a branch of GitHub's repository; empty when absent.
func (f *publicationFixture) githubRef(branch string) string {
	out, err := exec.Command("git", "--git-dir", f.github, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// writes lists GitHub writes as "METHOD path", in order. Token minting,
// fixture setup and Git protocol v2 reads (POST git-upload-pack) are not
// repository writes.
func (f *publicationFixture) writes() []string {
	var out []string
	for _, write := range f.fake.Writes() {
		if write.Path == "/login/oauth/access_token" || strings.HasPrefix(write.Path, "/app-manifests/") || strings.HasSuffix(write.Path, "/access_tokens") ||
			strings.HasSuffix(write.Path, "/git-upload-pack") {
			continue
		}
		out = append(out, write.Method+" "+write.Path)
	}
	return out
}

// labelWrites lists label writes as "path status body", in order.
func (f *publicationFixture) labelWrites() []string {
	var out []string
	for _, write := range f.fake.Writes() {
		if strings.HasSuffix(write.Path, "/labels") {
			out = append(out, write.Path+" "+strconv.Itoa(write.Status)+" "+string(write.Body))
		}
	}
	return out
}

func (f *publicationFixture) pullCreates() []map[string]any {
	var out []map[string]any
	for _, write := range f.fake.Writes() {
		if write.Method == http.MethodPost && write.Path == "/repos/rehearsal-owner/app/pulls" {
			var body map[string]any
			require.NoError(f.t, json.Unmarshal(write.Body, &body))
			body["status"] = write.Status
			out = append(out, body)
		}
	}
	return out
}

func TestTodoPublicationOpensReadyThenDraftPullRequests(t *testing.T) {
	f := newPublicationFixture(t, false)
	first := f.todo("Add a greeting to JOURNEY.md", "Say hello. Fixes #12.", f.main, "JOURNEY.md", "Hello from T1\n")
	f.wake()

	const firstBranch = "smithers/add-a-greeting-to-journey-md"
	item := f.item(first.Number.Int64)
	require.Equal(t, "proposed", item.State, item.Reason)
	assert.Equal(t, firstBranch, mythicalChecksOf(item).Branch)
	head := f.githubRef(firstBranch)
	require.Len(t, head, 40)
	assert.Equal(t, item.PRHead, head, "GitHub's branch is the recorded proposal")
	assert.Equal(t, f.main, f.git(f.github, "rev-parse", head+"^"), "one commit on main")
	assert.Equal(t, f.git(f.work, "rev-parse", first.CandidateHead+"^{tree}"), f.git(f.github, "rev-parse", head+"^{tree}"), "the verified candidate's tree")
	assert.Equal(t, []string{
		"POST /rehearsal-owner/app.git/git-receive-pack",
		"POST /repos/rehearsal-owner/app/pulls",
	}, f.writes(), "one push and one pull request; no review, merge or main write")
	creates := f.pullCreates()
	require.Len(t, creates, 1)
	assert.Equal(t, "Add a greeting to JOURNEY.md", creates[0]["title"])
	assert.Equal(t, firstBranch, creates[0]["head"])
	assert.Equal(t, "main", creates[0]["base"])
	assert.Equal(t, false, creates[0]["draft"], "the first item's pull request is ready for review")
	body := creates[0]["body"].(string)
	assert.Contains(t, body, "Say hello. Refs #12.", "no closing keyword reaches GitHub")
	assert.Contains(t, body, "Acceptance:\n- JOURNEY.md greets")
	assert.Contains(t, body, "1 file changed, 1 insertion(+), 1 deletion(-)")
	assert.True(t, strings.HasSuffix(body, "http://smithers.test/smithers-canary/smithers\n\nRequested by @smithers-canary"), body)
	card := f.card(first.Number.Int64)
	assert.Equal(t, "in_review", card["state"])
	assert.Equal(t, map[string]any{"number": float64(1), "url": "https://github.com/rehearsal-owner/app/pull/1", "head": head, "draft": false,
		"included_items": []any{float64(first.Number.Int64)}}, card["pr"])

	// Following an unchanged pull request writes nothing.
	f.wake()
	assert.Len(t, f.writes(), 2)
	assert.Equal(t, "proposed", f.item(first.Number.Int64).State)

	// The owner saves the Address teammates open (setup step 0): the next
	// pull request links there, not to the configured loopback origin.
	address := &InstallAddress{Configured: []string{"http://smithers.test"}}
	address.commit("0.0.0.0:4000", []string{"http://localhost:4000", "http://williams-mac-mini.local:4000"})
	f.service.SetPublicOrigin(address.Public)
	second := f.todo("Wave goodbye", "Say goodbye too", first.CandidateHead, "GOODBYE.md", "Bye from T2\n")
	f.wake()
	const secondBranch = "smithers/wave-goodbye"
	item = f.item(second.Number.Int64)
	require.Equal(t, "proposed", item.State, item.Reason)
	creates = f.pullCreates()
	require.Len(t, creates, 2)
	assert.Equal(t, secondBranch, creates[1]["head"])
	assert.Contains(t, creates[1]["body"], "http://williams-mac-mini.local:4000/smithers-canary/smithers\n\nRequested by @smithers-canary")
	assert.Equal(t, true, creates[1]["draft"], "a later item's pull request opens as a draft")
	assert.Contains(t, creates[1]["body"], "Includes [T1](https://github.com/rehearsal-owner/app/pull/1) until they merge")
	secondHead := f.githubRef(secondBranch)
	assert.Equal(t, f.main, f.git(f.github, "rev-parse", secondHead+"^"))
	assert.Equal(t, "Hello from T1", f.git(f.github, "show", secondHead+":JOURNEY.md"), "the prefix's change is included")
	card = f.card(second.Number.Int64)
	assert.Equal(t, "in_review", card["state"])
	assert.Equal(t, true, card["pr"].(map[string]any)["draft"])

	// A person marks the later pull request ready on GitHub: the card shows
	// GitHub's flag on the next read, and Smithers writes nothing back.
	token, err := f.connections.CreateGitHubInstallationTokenForRepositoryOwner(context.Background(), f.userID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "write"})
	require.NoError(t, err)
	mutation, _ := json.Marshal(map[string]any{"query": "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }",
		"variables": map[string]string{"id": "PR_rehearsal-owner/app_2"}})
	request, err := http.NewRequest(http.MethodPost, f.fake.URL+"/graphql", bytes.NewReader(mutation))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := f.fake.Client().Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	require.NoError(t, response.Body.Close())
	writes := len(f.writes())
	f.wake()
	assert.Equal(t, false, f.card(second.Number.Int64)["pr"].(map[string]any)["draft"])
	assert.Len(t, f.writes(), writes, "no corrective redraft")
}

func TestTodoPublicationNeverOverwritesForeignHead(t *testing.T) {
	f := newPublicationFixture(t, true)
	first := f.todo("Add a greeting to JOURNEY.md", "Say hello", f.main, "JOURNEY.md", "Hello from T1\n")
	// Alice pushes the branch from her laptop before Smithers publishes.
	f.git(f.work, "checkout", "-q", f.main)
	alice := f.commit("Alice's greeting", "JOURNEY.md", "Hi from Alice\n")
	f.git(f.work, "push", "-q", f.github, alice+":refs/heads/smithers/add-a-greeting-to-journey-md")
	f.wake()
	f.wake()

	assert.Equal(t, alice, f.githubRef("smithers/add-a-greeting-to-journey-md"), "a person's commit is never overwritten")
	assert.Empty(t, f.writes(), "no push and no pull request")
	item := f.item(first.Number.Int64)
	assert.Equal(t, "proposing", item.State)
	assert.Equal(t, alice, mythicalChecksOf(item).ForeignHead)
	assert.Contains(t, item.Reason, "someone else pushed to smithers/add-a-greeting-to-journey-md on GitHub")
	op, err := decodeMythicalOutbound(item.PendingOp)
	require.NoError(t, err)
	assert.Equal(t, "conflict", op.State)
	assert.Equal(t, "working", f.card(first.Number.Int64)["state"], "never In review without GitHub's pull request")
}

func TestTodoPublicationSettlesLostPushByLookup(t *testing.T) {
	f := newPublicationFixture(t, false)
	first := f.todo("Add a greeting to JOURNEY.md", "Say hello", f.main, "JOURNEY.md", "Hello from T1\n")
	f.fake.LoseNextResponses("/rehearsal-owner/app.git/git-receive-pack", 1)
	f.wake()

	const branch = "smithers/add-a-greeting-to-journey-md"
	item := f.item(first.Number.Int64)
	assert.Equal(t, "proposing", item.State)
	assert.Empty(t, item.PRHead)
	op, err := decodeMythicalOutbound(item.PendingOp)
	require.NoError(t, err)
	assert.Equal(t, MythicalOutboundOp{Kind: "push", Target: branch, Desired: op.Desired, Precondition: "", State: "unknown"}, op)
	assert.Equal(t, op.Desired, f.githubRef(branch), "GitHub took the push its answer lost")
	assert.Equal(t, "working", f.card(first.Number.Int64)["state"])

	f.wake() // lookup settles the push
	f.wake() // the pull request opens
	item = f.item(first.Number.Int64)
	require.Equal(t, "proposed", item.State, item.Reason)
	assert.Equal(t, op.Desired, item.PRHead)
	assert.Equal(t, []string{
		"POST /rehearsal-owner/app.git/git-receive-pack",
		"POST /repos/rehearsal-owner/app/pulls",
	}, f.writes(), "settled by lookup: no second push")
	assert.Equal(t, "in_review", f.card(first.Number.Int64)["state"])
}

func TestTodoPublicationGuardsRefuseBeforeEffects(t *testing.T) {
	f := newPublicationFixture(t, true)
	ctx := context.Background()
	first := f.todo("Add a greeting to JOURNEY.md", "Say hello", f.main, "JOURNEY.md", "Hello from T1\n")
	var other int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('former', 'former') RETURNING id`).Scan(&other))
	spent := NewBudgetTrackerWithLimits(1, time.Hour)
	allowed, _ := spent.Allow(f.installation)
	require.True(t, allowed)
	for _, tc := range []struct {
		name, reason        string
		breakSQL, repairSQL string
		budget              *BudgetTracker
	}{
		{name: "membership", reason: "no longer a member of this install",
			breakSQL: `UPDATE self_host_owners SET user_id = ` + strconv.FormatInt(other, 10), repairSQL: `UPDATE self_host_owners SET user_id = ` + strconv.FormatInt(f.userID, 10)},
		{name: "accepted generation", reason: "no verified candidate to publish",
			breakSQL:  `UPDATE mythical_items SET candidate_verified = false WHERE repository_id = ` + strconv.FormatInt(f.repoID, 10),
			repairSQL: `UPDATE mythical_items SET candidate_verified = true WHERE repository_id = ` + strconv.FormatInt(f.repoID, 10)},
		{name: "budget", reason: "GitHub budget for rehearsal-owner/app is spent", budget: spent},
		{name: "installation", reason: "",
			breakSQL: `DELETE FROM github_app_installation_repositories`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.breakSQL != "" {
				_, err := f.pool.Exec(ctx, tc.breakSQL)
				require.NoError(t, err)
			}
			if tc.budget != nil {
				f.service.publication.budget = tc.budget
			}
			f.wake()
			item := f.item(first.Number.Int64)
			assert.Equal(t, "proposing", item.State)
			assert.Empty(t, item.PendingOp, "no intent is recorded")
			if tc.reason != "" {
				assert.Contains(t, item.Reason, tc.reason)
			}
			assert.Empty(t, f.writes(), "refused before any GitHub write")
			assert.Empty(t, f.githubRef("smithers/add-a-greeting-to-journey-md"))
			if tc.repairSQL != "" {
				_, err := f.pool.Exec(ctx, tc.repairSQL)
				require.NoError(t, err)
			}
			if tc.budget != nil {
				f.service.publication.budget = NewBudgetTracker()
			}
			if tc.name == "installation" {
				require.NoError(t, f.connections.ReconcileGitHubAppInstallations(ctx))
			}
		})
	}
	// Recovered guards publish exactly once.
	f.wake()
	item := f.item(first.Number.Int64)
	require.Equal(t, "proposed", item.State, item.Reason)
	assert.Equal(t, []string{
		"POST /rehearsal-owner/app.git/git-receive-pack",
		"POST /repos/rehearsal-owner/app/pulls",
	}, f.writes())
	creates := f.pullCreates()
	require.Len(t, creates, 1)
	assert.Equal(t, false, creates[0]["draft"], "the first item is ready even where drafts are unavailable")
}

// The guards read persisted facts only; each refusal names its fact.
func TestTodoPublicationGuardFacts(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	item := f.todo("Add a greeting to JOURNEY.md", "Say hello", f.main, "JOURNEY.md", "Hello from T1\n")
	s := f.service
	run := func(sql string) {
		t.Helper()
		_, err := f.pool.Exec(ctx, sql, f.repoID)
		require.NoError(t, err)
	}
	require.NoError(t, s.stackLease(ctx, item, "push"), "an idle active stack")
	run(`UPDATE mythical_stacks SET running = true, lease_expires_at = NOW() - interval '1 second' WHERE repository_id = $1`)
	require.EqualError(t, s.stackLease(ctx, item, "push"), "the stack's lease expired")
	run(`UPDATE mythical_stacks SET lease_expires_at = NOW() + interval '1 minute' WHERE repository_id = $1`)
	require.NoError(t, s.stackLease(ctx, item, "push"), "a live claim")
	run(`UPDATE mythical_stacks SET state = 'frozen', running = false WHERE repository_id = $1`)
	require.EqualError(t, s.stackLease(ctx, item, "push"), "the repository's stack is frozen")
	run(`UPDATE mythical_stacks SET state = 'active' WHERE repository_id = $1`)

	require.NoError(t, s.acceptedGeneration(ctx, item, "push"))
	stale := item
	stale.Version--
	require.EqualError(t, s.acceptedGeneration(ctx, stale, "open"), "the TODO changed while its GitHub operation was prepared")
	run(`UPDATE mythical_items SET state = 'cancelled', version = version WHERE repository_id = $1`)
	dropped, err := db.New(f.pool).GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.EqualError(t, s.acceptedGeneration(ctx, dropped, "push"), "the TODO is cancelled")
	require.NoError(t, s.acceptedGeneration(ctx, dropped, "close"), "a dropped TODO's pull request still closes")

	require.NoError(t, s.canonicalApp(ctx, item, "push"))
	unconfigured := &MythicalService{store: f.pool, publication: &mythicalPublication{connections: f.connections}}
	require.ErrorIs(t, unconfigured.canonicalApp(ctx, item, "push"), ErrGitHubAppNotConfigured)
	require.NoError(t, s.currentMembership(ctx, item, "push"))
	require.NoError(t, s.githubBudget(ctx, item, "push"))
	unbudgeted := &MythicalService{store: f.pool, publication: &mythicalPublication{connections: f.connections}}
	require.EqualError(t, unbudgeted.githubBudget(ctx, item, "push"), "GitHub's budgeted transport is unavailable")
}

// Where drafts are unavailable, a later TODO's pull request opens ready,
// names the TODO it waits for and carries smithers:waiting before the TODO
// shows In review. A refused label write is retried; it never reopens.
func TestTodoPublicationLabelsLaterPullWhereDraftsAreUnavailable(t *testing.T) {
	f := newPublicationFixture(t, true)
	first := f.todo("Add a greeting to JOURNEY.md", "Say hello", f.main, "JOURNEY.md", "Hello from T1\n")
	f.wake()
	require.Equal(t, "proposed", f.item(first.Number.Int64).State)
	second := f.todo("Wave goodbye", "Say goodbye too", first.CandidateHead, "GOODBYE.md", "Bye from T2\n")
	f.fake.FailNextWrites("/repos/rehearsal-owner/app/issues/2/labels", 1)
	f.wake()
	item := f.item(second.Number.Int64)
	assert.Equal(t, "proposing", item.State, "an unlabeled pull request is not yet in review")
	assert.NotEmpty(t, item.PendingOp)
	assert.Equal(t, "working", f.card(second.Number.Int64)["state"])

	f.wake()
	item = f.item(second.Number.Int64)
	require.Equal(t, "proposed", item.State, item.Reason)
	creates := f.pullCreates()
	require.Len(t, creates, 2, "one pull request per TODO; a refused label never reopens one")
	assert.Equal(t, "Add a greeting to JOURNEY.md", creates[0]["title"])
	assert.Equal(t, false, creates[0]["draft"])
	assert.Equal(t, "[waits for T1] Wave goodbye", creates[1]["title"])
	assert.Equal(t, false, creates[1]["draft"], "drafts are unavailable: the later pull request opens ready")
	waiting := `{"labels":["smithers:waiting"]}`
	assert.Equal(t, []string{
		"/repos/rehearsal-owner/app/issues/2/labels 502 " + waiting,
		"/repos/rehearsal-owner/app/issues/2/labels 200 " + waiting,
	}, f.labelWrites(), "only the later pull request is labeled")
	card := f.card(second.Number.Int64)
	assert.Equal(t, "in_review", card["state"])
	assert.Equal(t, []any{float64(first.Number.Int64), float64(second.Number.Int64)}, card["pr"].(map[string]any)["included_items"],
		"the card includes what the pull request body includes")
	assert.Equal(t, []any{float64(first.Number.Int64)}, f.card(first.Number.Int64)["pr"].(map[string]any)["included_items"])

	writes := len(f.writes())
	f.wake()
	assert.Len(t, f.writes(), writes, "following both pull requests writes nothing")
}

// A person's push found while settling a push whose answer was lost is held
// exactly like one found before the push: kept, named and told once.
func TestTodoPublicationHoldsForeignPushFoundOnRecovery(t *testing.T) {
	f := newPublicationFixture(t, false, 12)
	ctx := context.Background()
	first := f.todo("Add a greeting to JOURNEY.md", "Say hello", f.main, "JOURNEY.md", "Hello from T1\n")
	// The TODO is linked to issue 12, where a person reads its holds.
	_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET issue_number = 12 WHERE id = $1`, first.ID)
	require.NoError(t, err)
	f.fake.LoseNextResponses("/rehearsal-owner/app.git/git-receive-pack", 1)
	f.wake()
	const branch = "smithers/add-a-greeting-to-journey-md"
	require.Len(t, f.githubRef(branch), 40, "GitHub took the push its answer lost")

	// Alice pushes over it before Smithers looks again.
	f.git(f.work, "checkout", "-q", f.main)
	alice := f.commit("Alice's greeting", "JOURNEY.md", "Hi from Alice\n")
	f.git(f.work, "push", "-q", "--force", f.github, alice+":refs/heads/"+branch)
	for range 3 {
		f.wake()
	}

	assert.Equal(t, alice, f.githubRef(branch), "a person's commit is never overwritten")
	item := f.item(first.Number.Int64)
	assert.Equal(t, "proposing", item.State)
	assert.Equal(t, "someone else pushed to "+branch+" on GitHub; Smithers will not overwrite it and a person decides", item.Reason)
	checks := mythicalChecksOf(item)
	assert.Equal(t, alice, checks.ForeignHead)
	assert.Nil(t, checks.Notice)
	assert.Equal(t, []string{"foreign_push:" + alice}, checks.Noticed)
	op, err := decodeMythicalOutbound(item.PendingOp)
	require.NoError(t, err)
	assert.Equal(t, "conflict", op.State)
	assert.Equal(t, []string{
		"POST /rehearsal-owner/app.git/git-receive-pack",
		"POST /repos/rehearsal-owner/app/issues/12/comments",
	}, f.writes(), "one push and one notice: no second push and no pull request")
	assert.Equal(t, "working", f.card(first.Number.Int64)["state"])
}

// The App token can write any branch: only the TODO's own recorded
// smithers/<slug> branch is ever pushed, whatever a stored slot names.
func TestTodoPublicationPushesOnlyTheRecordedTodoBranch(t *testing.T) {
	for _, target := range []string{"main", "smithers/someone-else"} {
		t.Run(target, func(t *testing.T) {
			f := newPublicationFixture(t, false)
			ctx := context.Background()
			first := f.todo("Add a greeting to JOURNEY.md", "Say hello", f.main, "JOURNEY.md", "Hello from T1\n")
			before := f.githubRef(target)
			slot, err := json.Marshal(MythicalOutboundOp{Kind: "push", Target: target, Desired: first.CandidateHead, Precondition: before, State: "intended"})
			require.NoError(t, err)
			recorded := mythicalChecks{Branch: "smithers/add-a-greeting-to-journey-md"}
			_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET pending_op = $2, checks = $3 WHERE id = $1`, first.ID, string(slot), string(recorded.encode()))
			require.NoError(t, err)
			f.wake()
			f.wake()

			assert.Equal(t, before, f.githubRef(target), "the branch is untouched")
			assert.Empty(t, f.writes(), "nothing is pushed")
			op, err := decodeMythicalOutbound(f.item(first.Number.Int64).PendingOp)
			require.NoError(t, err)
			assert.Equal(t, target, op.Target, "the slot stays for a person to see")
		})
	}
}
