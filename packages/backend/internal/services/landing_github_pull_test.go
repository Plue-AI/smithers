package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const (
	pullTip       = "cccccccccccccccccccccccccccccccccccccccc"
	pullOther     = "dddddddddddddddddddddddddddddddddddddddd"
	pullWorkspace = "3f1f0c2e-8a4e-4a47-9a55-0a1c1f0b2d10"
)

type fakeLandingPulls struct {
	existing *landingGitHubPullRequest
	ahead    int
	creates  []landingGitHubPullCreate
	createFn func(landingGitHubPullCreate) (*landingGitHubPullRequest, error)
	findErr  error
}

func (f *fakeLandingPulls) Find(context.Context, string, string, string, string) (*landingGitHubPullRequest, error) {
	return f.existing, f.findErr
}
func (f *fakeLandingPulls) Create(_ context.Context, token, owner, repo string, input landingGitHubPullCreate) (*landingGitHubPullRequest, error) {
	f.creates = append(f.creates, input)
	if f.createFn != nil {
		return f.createFn(input)
	}
	pull := pullReceipt(41, input.Head, pullTip)
	f.existing = pull
	return pull, nil
}
func (f *fakeLandingPulls) AheadBy(context.Context, string, string, string, string, string) (int, error) {
	return f.ahead, nil
}

func pullReceipt(number int64, branch, sha string) *landingGitHubPullRequest {
	pull := &landingGitHubPullRequest{Number: number, HTMLURL: "https://github.com/acme/app/pull/41", State: "open"}
	pull.Head.Ref, pull.Head.SHA = branch, sha
	pull.Head.Repo = &struct {
		FullName string `json:"full_name"`
	}{FullName: "acme/app"}
	pull.Base.Ref = "main"
	return pull
}

type landingPullFixture struct {
	service  *LandingGitHubPullService
	pulls    *fakeLandingPulls
	github   map[string]string
	pushes   int
	remotes  int
	closed   int
	landing  db.GetLandingRequestWithChangeIDsByNumberRow
	tip      string
	remoteFn func() (landingGitHubRemotes, error)
}

func newLandingPullFixture(t *testing.T) *landingPullFixture {
	t.Helper()
	f := &landingPullFixture{pulls: &fakeLandingPulls{ahead: 2}, github: map[string]string{"refs/heads/main": pullOther}, tip: pullTip}
	repository := landingRepo(nil)
	f.landing = landingDBRequestWithChangeIDs(88, repository.ID, 12, 1, []string{"kxyz", "kwxy"})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return f.landing, nil
		},
	}
	rh := &mockLandingRepoHostClient{getChangeFn: func(_ context.Context, _, _, changeID string) (repohost.Change, error) {
		require.Equal(t, "kwxy", changeID)
		return repohost.Change{ChangeID: changeID, CommitID: f.tip}, nil
	}}
	f.service = &LandingGitHubPullService{
		landings: NewLandingService(q, rh),
		remotes: func(context.Context, *db.User, db.Repository, string, string) (landingGitHubRemotes, error) {
			f.remotes++
			if f.remoteFn != nil {
				return f.remoteFn()
			}
			return landingGitHubRemotes{githubOwner: "acme", githubRepo: "app", sourceURL: "https://smithers.example/o/demo.git",
				targetURL: "https://x-access-token:secret@github.com/acme/app.git", token: "secret", cleanup: func() { f.closed++ }}, nil
		},
		listRefs: func(_ context.Context, remote string) (map[string]string, error) {
			if strings.Contains(remote, "github.com") {
				copy := map[string]string{}
				for k, v := range f.github {
					copy[k] = v
				}
				return copy, nil
			}
			return map[string]string{"refs/heads/main": pullOther, repohost.WorkspaceSourceRef(pullWorkspace, pullTip): pullTip}, nil
		},
		push: func(_ context.Context, _, sourceRef, commitID, _, targetRef string) error {
			f.pushes++
			require.Equal(t, repohost.WorkspaceSourceRef(pullWorkspace, pullTip), sourceRef)
			require.Equal(t, "refs/heads/smithers/landing-12", targetRef)
			f.github[targetRef] = commitID
			return nil
		},
		github: f.pulls,
	}
	return f
}

func (f *landingPullFixture) open() (LandingGitHubPull, error) {
	return f.service.OpenLandingGitHubPull(context.Background(), &db.User{ID: 1}, "owner", "demo", 12, LandingGitHubPullInput{CommitID: pullTip, RunID: "run-7"})
}

func TestLandingGitHubPullOpensOnceAndReplaysTheSamePull(t *testing.T) {
	f := newLandingPullFixture(t)
	first, err := f.open()
	require.NoError(t, err)
	assert.True(t, first.Created)
	assert.Equal(t, LandingGitHubPull{LandingNumber: 12, Repository: "acme/app", Number: 41, URL: "https://github.com/acme/app/pull/41",
		State: "open", HeadRef: "smithers/landing-12", HeadSHA: pullTip, BaseRef: "main", Created: true}, first)
	require.Len(t, f.pulls.creates, 1)
	assert.Equal(t, "seed", f.pulls.creates[0].Title)
	assert.Equal(t, "main", f.pulls.creates[0].Base)
	assert.Equal(t, "seed body\n\n---\nSmithers landing #12 · run `run-7`", f.pulls.creates[0].Body)

	second, err := f.open()
	require.NoError(t, err)
	assert.False(t, second.Created)
	assert.Equal(t, first.Number, second.Number)
	assert.Equal(t, 1, f.pushes, "a retry never pushes again")
	assert.Len(t, f.pulls.creates, 1, "a retry never opens a second pull request")
	assert.Equal(t, 2, f.closed, "the disposable source credential is revoked every time")
}

func TestLandingGitHubPullRecoversALostPushAcknowledgement(t *testing.T) {
	f := newLandingPullFixture(t)
	f.github["refs/heads/smithers/landing-12"] = pullTip
	pull, err := f.open()
	require.NoError(t, err)
	assert.True(t, pull.Created)
	assert.Zero(t, f.pushes)
}

func TestLandingGitHubPullFindsAConcurrentlyOpenedPull(t *testing.T) {
	f := newLandingPullFixture(t)
	f.pulls.createFn = func(input landingGitHubPullCreate) (*landingGitHubPullRequest, error) {
		f.pulls.existing = pullReceipt(40, input.Head, pullTip)
		return nil, errLandingGitHubPullExists
	}
	pull, err := f.open()
	require.NoError(t, err)
	assert.Equal(t, int64(40), pull.Number)
	assert.False(t, pull.Created)
}

func TestLandingGitHubPullRefusals(t *testing.T) {
	for _, tc := range []struct {
		name    string
		arrange func(*landingPullFixture)
		code    pkgerrors.Code
		text    string
		remotes int
	}{
		{name: "stale tip", arrange: func(f *landingPullFixture) { f.tip = pullOther }, code: pkgerrors.CodeConflict, text: "current tip"},
		{name: "closed landing", arrange: func(f *landingPullFixture) { f.landing.State = "closed" }, code: pkgerrors.CodeConflict, text: "not open"},
		{name: "missing installation", arrange: func(f *landingPullFixture) {
			f.remoteFn = func() (landingGitHubRemotes, error) {
				return landingGitHubRemotes{}, pkgerrors.BadRequest("github app is not installed for this repository")
			}
		}, code: pkgerrors.CodeBadRequest, text: "not installed", remotes: 1},
		{name: "missing push access", arrange: func(f *landingPullFixture) {
			f.remoteFn = func() (landingGitHubRemotes, error) {
				return landingGitHubRemotes{}, pkgerrors.Forbidden("Your GitHub account must have push access to acme/app")
			}
		}, code: pkgerrors.CodeForbidden, text: "push access", remotes: 1},
		{name: "moved branch", arrange: func(f *landingPullFixture) { f.github["refs/heads/smithers/landing-12"] = pullOther },
			code: pkgerrors.CodeConflict, text: "moved", remotes: 1},
		{name: "diverged mains", arrange: func(f *landingPullFixture) { f.pulls.ahead = 5 }, code: pkgerrors.CodeConflict, text: "refresh the Smithers mirror", remotes: 1},
		{name: "rewritten pull head", arrange: func(f *landingPullFixture) { f.pulls.existing = pullReceipt(41, "smithers/landing-12", pullOther) },
			code: pkgerrors.CodeConflict, text: "no longer carries", remotes: 1},
		{name: "GitHub permission", arrange: func(f *landingPullFixture) {
			f.pulls.findErr = landingGitHubStatusError(http.StatusForbidden, "acme", "app", "read pull requests")
		}, code: pkgerrors.CodeGitHubPermission, text: "GitHub access denied", remotes: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newLandingPullFixture(t)
			tc.arrange(f)
			_, err := f.open()
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, tc.code, apiErr.Code)
			assert.Contains(t, apiErr.Message, tc.text)
			assert.Equal(t, tc.remotes, f.remotes)
			assert.Empty(t, f.pulls.creates)
			if tc.name != "diverged mains" {
				assert.Zero(t, f.pushes)
			}
		})
	}
}

func TestLandingGitHubPullRefusesAnUnretainedTip(t *testing.T) {
	f := newLandingPullFixture(t)
	f.service.listRefs = func(_ context.Context, remote string) (map[string]string, error) {
		return map[string]string{"refs/heads/main": pullOther}, nil
	}
	_, err := f.open()
	require.ErrorContains(t, err, "not retained")
	assert.Zero(t, f.pushes)
}

type pullPushProver func(context.Context, int64, string, string) error

func (p pullPushProver) GitHubRepoPushAuthorized(ctx context.Context, userID int64, owner, repo string) error {
	return p(ctx, userID, owner, repo)
}

type pullTokens func(context.Context, int64, int64, string, string, map[string]string) (GitHubInstallationToken, error)

func (p pullTokens) CreateGitHubInstallationTokenForRepositoryOwner(ctx context.Context, userID, orgID int64, owner, repo string, permissions map[string]string) (GitHubInstallationToken, error) {
	return p(ctx, userID, orgID, owner, repo, permissions)
}

func TestLandingGitHubPullCredentialsAreResolvedAtDispatch(t *testing.T) {
	q := &mirrorCredentialStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore(), sources: []db.ListRepositoryGitHubSourcesRow{{GithubOwner: "acme", GithubRepo: "app"}}}
	repository := landingRepo(nil)
	actor := &db.User{ID: 7}
	proved := false
	tokens := pullTokens(func(_ context.Context, userID, _ int64, owner, repo string, permissions map[string]string) (GitHubInstallationToken, error) {
		require.True(t, proved, "push access is proven before an installation token is minted")
		require.Equal(t, int64(1), userID)
		require.Equal(t, "acme/app", owner+"/"+repo)
		// No landing token may carry workflows: GitHub then refuses a push
		// that adds or edits .github/workflows, so an agent-written workflow
		// cannot run with the customer's secrets before a human merges.
		require.NotContains(t, permissions, "workflows")
		if permissions["contents"] == "write" {
			require.Equal(t, map[string]string{"contents": "write"}, permissions, "the git push token holds contents:write only")
			return GitHubInstallationToken{InstallationID: 5, Token: "ghs_push"}, nil
		}
		require.Equal(t, map[string]string{"contents": "read", "pull_requests": "write"}, permissions)
		return GitHubInstallationToken{InstallationID: 5, Token: "ghs_pulls"}, nil
	})
	prover := pullPushProver(func(_ context.Context, userID int64, owner, repo string) error {
		require.Equal(t, int64(7), userID)
		proved = true
		return nil
	})
	s := NewLandingGitHubPullService(nil, q, tokens, prover, "https://forge.example", nil)
	remotes, err := s.remotes(context.Background(), actor, repository, "owner", "demo")
	require.NoError(t, err)
	target, err := url.Parse(remotes.targetURL)
	require.NoError(t, err)
	password, _ := target.User.Password()
	assert.Equal(t, "ghs_push", password)
	assert.Equal(t, "ghs_pulls", remotes.token, "pull request calls use a token that cannot push")
	assert.Equal(t, "/acme/app.git", target.Path)
	source, err := url.Parse(remotes.sourceURL)
	require.NoError(t, err)
	assert.Equal(t, "forge.example", source.Host)
	require.Len(t, q.created, 1)
	assert.Contains(t, q.created[0].Scopes, "read:repository")
	remotes.close()
	assert.Len(t, q.deleted, 1)

	denied := NewLandingGitHubPullService(nil, q, tokens, pullPushProver(func(context.Context, int64, string, string) error {
		return errors.New("no")
	}), "https://forge.example", nil)
	proved = false
	_, err = denied.remotes(context.Background(), actor, repository, "owner", "demo")
	require.ErrorContains(t, err, "push access")

	missing := NewLandingGitHubPullService(nil, q, pullTokens(func(context.Context, int64, int64, string, string, map[string]string) (GitHubInstallationToken, error) {
		return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
	}), prover, "https://forge.example", nil)
	_, err = missing.remotes(context.Background(), actor, repository, "owner", "demo")
	require.ErrorContains(t, err, "not installed")
	assert.Len(t, q.created, 1, "no source credential is minted without an installation")
}

func TestLandingGitHubAPIMapsGitHubAnswers(t *testing.T) {
	var created bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer ghs_installation", r.Header.Get("Authorization"))
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/repos/acme/app/pulls":
			require.Equal(t, "acme:smithers/landing-12", r.URL.Query().Get("head"))
			require.Equal(t, "all", r.URL.Query().Get("state"))
			if !created {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"number": 41, "html_url": "u", "state": "closed", "merged_at": "2026-09-24T00:00:00Z",
				"head": map[string]any{"ref": "smithers/landing-12", "sha": pullTip, "repo": map[string]any{"full_name": "acme/app"}}, "base": map[string]any{"ref": "main"}}})
		case r.Method == http.MethodPost && r.URL.Path == "/repos/acme/app/pulls":
			created = true
			w.WriteHeader(http.StatusUnprocessableEntity)
		case r.URL.Path == "/repos/acme/app/compare/main..."+pullTip:
			_, _ = w.Write([]byte(`{"ahead_by":2}`))
		case r.URL.Path == "/repos/acme/denied/pulls":
			w.WriteHeader(http.StatusForbidden)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	api := &landingGitHubAPI{client: server.Client(), baseURL: func() string { return server.URL }}
	ctx := context.Background()
	pull, err := api.Find(ctx, "ghs_installation", "acme", "app", "smithers/landing-12")
	require.NoError(t, err)
	assert.Nil(t, pull)
	ahead, err := api.AheadBy(ctx, "ghs_installation", "acme", "app", "main", pullTip)
	require.NoError(t, err)
	assert.Equal(t, 2, ahead)
	_, err = api.Create(ctx, "ghs_installation", "acme", "app", landingGitHubPullCreate{Head: "smithers/landing-12", Base: "main"})
	require.ErrorIs(t, err, errLandingGitHubPullExists)
	pull, err = api.Find(ctx, "ghs_installation", "acme", "app", "smithers/landing-12")
	require.NoError(t, err)
	require.NotNil(t, pull)
	assert.NotNil(t, pull.MergedAt)
	_, err = api.Find(ctx, "ghs_installation", "acme", "denied", "smithers/landing-12")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeGitHubPermission, apiErr.Code)
}

// The mythical stack pushes agent-written commits like a landing: its push
// token holds contents:write only and its API token cannot push, so neither
// carries workflows.
func TestMythicalGitHubTokensNeverCarryWorkflows(t *testing.T) {
	q := &mirrorCredentialStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore(), sources: []db.ListRepositoryGitHubSourcesRow{{GithubOwner: "acme", GithubRepo: "app"}}}
	var minted []map[string]string
	tokens := pullTokens(func(_ context.Context, _, _ int64, _, _ string, permissions map[string]string) (GitHubInstallationToken, error) {
		minted = append(minted, permissions)
		if permissions["contents"] == "write" {
			return GitHubInstallationToken{Token: "ghs_push"}, nil
		}
		return GitHubInstallationToken{Token: "ghs_api"}, nil
	})
	prover := pullPushProver(func(context.Context, int64, string, string) error { return nil })
	gh, err := NewMythicalGitHub(q, tokens, prover, nil).Resolve(context.Background(), landingRepo(nil), "owner", 7)
	require.NoError(t, err)
	assert.Equal(t, []map[string]string{
		{"contents": "write"},
		{"contents": "read", "issues": "read", "pull_requests": "write"},
	}, minted)
	target, err := url.Parse(gh.GitURL)
	require.NoError(t, err)
	password, _ := target.User.Password()
	assert.Equal(t, "ghs_push", password)
	assert.Equal(t, "ghs_api", gh.Token, "API calls use a token that cannot push")
}

type bookmarkedLandingRepoHost struct{ *mockLandingRepoHostClient }

func (bookmarkedLandingRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetChangeID: "main-tip"}}, "", nil
}

// A landing from a workspace that ran outsider-started work never reaches
// GitHub with a protected path; main's projection adds its own entries.
func TestLandingGitHubPullRefusesOutsiderProtectedPaths(t *testing.T) {
	for name, tc := range map[string]struct {
		files   []string
		refused string
	}{
		"workflow":   {[]string{"src/a.ts", ".github/workflows/extra.yml"}, ".github/workflows/extra.yml"},
		"agents":     {[]string{"apps/app/AGENTS.md"}, "apps/app/AGENTS.md"},
		"configured": {[]string{"infra/keys/prod.pem"}, "infra/keys/prod.pem"},
		"action":     {[]string{"src/a.ts", "tools/inner/util.js"}, "tools/inner/util.js"},
		"ordinary":   {[]string{"src/a.ts"}, ""},
		"unstacked":  {[]string{"src/a.ts"}, "unstacked"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newLandingPullFixture(t)
			q := f.service.landings.queries.(*mockLandingQuerier)
			rh := f.service.landings.repoHost.(*mockLandingRepoHostClient)
			q.outsiderLanding = true
			parents := map[string]string{"kxyz": "main-tip", "kwxy": "kxyz"}
			// Each case's main is its own commit, so no case reads another's
			// cached list.
			mainCommit := "main-commit-" + name
			rh.getChangeFn = func(_ context.Context, _, _, changeID string) (repohost.Change, error) {
				if changeID == "main-tip" {
					return repohost.Change{ChangeID: changeID, CommitID: mainCommit}, nil
				}
				return repohost.Change{ChangeID: changeID, CommitID: f.tip, ParentChangeIDs: []string{parents[changeID]}}, nil
			}
			rh.getChangeFilesFn = func(context.Context, string, string, string) ([]repohost.ChangeFile, error) {
				files := make([]repohost.ChangeFile, 0, len(tc.files))
				for _, path := range tc.files {
					files = append(files, repohost.ChangeFile{Path: path})
				}
				return files, nil
			}
			rh.getFileAtChangeFn = func(_ context.Context, _, _, revision, path string) (repohost.FileContent, error) {
				require.Equal(t, mainCommit, revision, "the list comes from the target's commit, never the landing")
				if path == factoryProjectionPath {
					return repohost.FileContent{Content: `{"github":{"protectedPaths":["infra/keys"]}}`}, nil
				}
				if content, ok := workflowTrustFixture[path]; ok {
					return repohost.FileContent{Content: content}, nil
				}
				return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
			}
			rh.listDirectoryFn = func(_ context.Context, _, _, revision, prefix, _ string, _ int) ([]repohost.TreeEntry, error) {
				require.Equal(t, mainCommit, revision)
				var entries []repohost.TreeEntry
				seen := map[string]bool{}
				for file := range workflowTrustFixture {
					if !strings.HasPrefix(file, prefix+"/") {
						continue
					}
					child, rest, nested := strings.Cut(strings.TrimPrefix(file, prefix+"/"), "/")
					entry := repohost.TreeEntry{Path: prefix + "/" + child, Kind: "file"}
					if nested && rest != "" {
						entry.Kind = "dir"
					}
					if !seen[entry.Path] {
						seen[entry.Path] = true
						entries = append(entries, entry)
					}
				}
				if len(entries) == 0 {
					return nil, &repohost.StatusError{StatusCode: 404}
				}
				return entries, nil
			}
			if tc.refused == "unstacked" {
				parents["kxyz"] = "elsewhere"
			}
			f.service.landings = NewLandingService(q, bookmarkedLandingRepoHost{rh})
			_, err := f.open()
			if tc.refused == "" {
				require.NoError(t, err)
				return
			}
			if tc.refused == "unstacked" {
				require.ErrorContains(t, err, "not stacked on main")
			} else {
				require.ErrorContains(t, err, "protected paths: "+tc.refused)
			}
			assert.Zero(t, f.pushes, "nothing reaches GitHub")
			assert.Empty(t, f.pulls.creates)
		})
	}
}

// The landing credential names its workspace, and each landing it opens
// records that workspace.
func TestLandingRecordsTheWorkspaceItsCredentialServes(t *testing.T) {
	q := &mockLandingQuerier{}
	s := NewLandingService(q, &mockLandingRepoHostClient{})
	scopes := boxHostLandingTokenScopes(7, "3F2B6C1E-0000-4000-8000-000000000001")
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{IsTokenAuth: true, RawScopes: scopes})
	require.NoError(t, s.recordLandingSource(ctx, 12))
	require.NoError(t, s.recordLandingSource(context.Background(), 13))
	assert.Equal(t, map[int64]string{12: "3f2b6c1e-0000-4000-8000-000000000001"}, q.landingSourceWorkspaces)
}

func (h bookmarkedLandingRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := h.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}

func TestLandingGitHubConditionalReadPreservesStatusHeadersAndCachedFact(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "Bearer token", r.Header.Get("Authorization"))
		require.Equal(t, "/repos/acme/app/pulls?state=all&per_page=50", r.URL.RequestURI())
		w.Header().Set("ETag", `"pulls-v1"`)
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "80")
		w.Header().Set("X-RateLimit-Reset", "2000")
		if r.Header.Get("If-None-Match") == `"pulls-v1"` {
			w.WriteHeader(304)
			return
		}
		_, _ = w.Write([]byte(`[{"number":7}]`))
	}))
	defer server.Close()
	api := &landingGitHubAPI{client: server.Client(), baseURL: func() string { return server.URL }}
	var out []struct{ Number int }
	status, header, err := api.requestHeaders(context.Background(), "token", "GET", "/repos/acme/app/pulls?state=all&per_page=50", "", nil, &out)
	require.NoError(t, err)
	require.Equal(t, 200, status)
	require.Equal(t, 7, out[0].Number)
	require.Equal(t, "80", header.Get("X-RateLimit-Remaining"))
	status, header, err = api.requestHeaders(context.Background(), "token", "GET", "/repos/acme/app/pulls?state=all&per_page=50", header.Get("ETag"), nil, &out)
	require.NoError(t, err)
	require.Equal(t, 304, status)
	require.Equal(t, 7, out[0].Number)
	require.Equal(t, "80", header.Get("X-RateLimit-Remaining"))
	require.Equal(t, 2, calls)
}
