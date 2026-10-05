package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/repository"
)

// installSync is an install's repository engine (the real receive handler,
// with the install main policy on) beside a GitHub fixture repository served
// over smart HTTP, as the GitHub sync sees them.
type installSync struct {
	f      *gitFixture
	client *repohost.Client
	github string // GitHub's bare repository
	server *httptest.Server
}

func newInstallSync(t *testing.T, install bool) *installSync {
	t.Helper()
	ffi := strings.TrimSpace(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	local, err := repository.OpenLocal(repository.Config{StoragePath: t.TempDir(), AuthToken: "install-sync-engine", FFILibraryPath: ffi, InstallMainMirror: install})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	s := &installSync{f: f, client: local.Client(), github: f.bare("github.git")}
	require.Equal(t, install, s.client.InstallMainMirror())
	backend := &cgi.Handler{Path: mustLookPath(t, "git"), Args: []string{"http-backend"}, Dir: root,
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull}}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/github.git/" + strings.TrimPrefix(r.URL.Path, "/smithersai/smithers.git/")
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(s.server.Close)
	return s
}

// receive sends one ref update of the work repository's objects straight to
// the engine's receive handler with the given credential kind.
func (s *installSync) receive(ctx context.Context, kind middleware.CredentialKind, owner, repo, old, next, ref string) error {
	revs := next + "\n"
	if old != strings.Repeat("0", 40) {
		revs += "^" + old + "\n"
	}
	cmd := exec.Command("git", "-C", s.f.work, "pack-objects", "--revs", "--stdout", "-q")
	cmd.Stdin = strings.NewReader(revs)
	pack, err := cmd.Output()
	if err != nil {
		return err
	}
	line := old + " " + next + " " + ref + "\x00report-status\n"
	var body bytes.Buffer
	fmt.Fprintf(&body, "%04x%s0000", len(line)+4, line)
	body.Write(pack)
	return s.client.ProxyReceivePack(ctx, owner, repo, &body, io.Discard, repohost.ReceivePackMetadata{PusherLogin: "github", PusherCredential: kind})
}

func (s *installSync) main(t *testing.T, owner, repo, name string) string {
	t.Helper()
	bookmark, found, err := repohost.LookupBookmark(context.Background(), s.client, owner, repo, name)
	require.NoError(t, err)
	if !found {
		return ""
	}
	return bookmark.TargetCommitID
}

// On an install the main pull is the GitHub sync: through the real receive
// handler with the install policy on, a GitHub fast-forward of main reaches
// the mirror, and a GitHub rewrite is refused, recorded as force_push for a
// retry, and leaves main where it was. The engine refuses the platform's
// write the pull presented before this change, and a sync rewrite of main.
func TestInstallMainPullFastForwardsThroughTheInstallEngine(t *testing.T) {
	ctx := context.Background()
	s := newInstallSync(t, true)
	const owner, repo = "smithers-canary", "smithers"
	require.NoError(t, s.client.InitRepo(ctx, owner, repo, "main", false))
	base := s.f.commit("base", "a.txt", "a")
	zero := strings.Repeat("0", 40)
	// The import's sync seeds main; nothing else may write it.
	require.NoError(t, s.receive(ctx, middleware.CredentialSync, owner, repo, zero, base, "refs/heads/main"))
	next := s.f.commit("merged on GitHub", "b.txt", "b")
	s.f.git(s.f.work, "push", "-q", s.github, next+":refs/heads/main")

	var refused *repohost.StatusError
	err := s.receive(ctx, middleware.CredentialPlatform, owner, repo, base, next, "refs/heads/main")
	require.True(t, errors.As(err, &refused) && refused.StatusCode == http.StatusForbidden, "the platform kind is not the sync: %v", err)
	require.Equal(t, base, s.main(t, owner, repo, "main"))

	service := NewGitHubMainPullService(newFakeMainPullStore(), s.client, &fixtureTokens{}, nil)
	service.gitHubGitBaseURL = func() string { return s.server.URL }
	service.UseInstallPolicy()
	out := service.pull(ctx, db.GithubMainPull{RepositoryID: 19})
	require.Equal(t, "synced", out.state, out.err)
	assert.Equal(t, next, out.smithersHead)
	assert.Equal(t, next, s.main(t, owner, repo, "main"), "GitHub's fast-forward reached the install mirror")

	// GitHub rewrites main: the pull refuses it visibly and retries later;
	// the engine itself refuses the sync's rewrite.
	s.f.git(s.f.work, "checkout", "-q", "-b", "rewrite", base)
	rewrite := s.f.commit("rewritten on GitHub", "c.txt", "c")
	s.f.git(s.f.work, "push", "-q", "--force", s.github, rewrite+":refs/heads/main")
	for attempt := 0; attempt < 2; attempt++ {
		out = service.pull(ctx, db.GithubMainPull{RepositoryID: 19})
		assert.Equal(t, "failed", out.state)
		assert.Equal(t, "force_push", out.err)
		require.NotNil(t, out.forcePush)
		assert.Equal(t, GitHubMainForcePush{Old: next, New: rewrite}, *out.forcePush)
		assert.Equal(t, next, s.main(t, owner, repo, "main"))
	}
	err = s.receive(ctx, middleware.CredentialSync, owner, repo, next, rewrite, "refs/heads/main")
	require.True(t, errors.As(err, &refused) && refused.StatusCode == http.StatusForbidden, "the sync's rewrite of install main: %v", err)
	assert.Equal(t, next, s.main(t, owner, repo, "main"))
}

// Hosted keeps the platform's reviewed write of main through the same engine.
func TestHostedMainPullStillPresentsThePlatformWrite(t *testing.T) {
	ctx := context.Background()
	s := newInstallSync(t, false)
	const owner, repo = "smithers-canary", "smithers"
	require.NoError(t, s.client.InitRepo(ctx, owner, repo, "main", false))
	base := s.f.commit("base", "a.txt", "a")
	require.NoError(t, s.receive(ctx, middleware.CredentialPerson, owner, repo, strings.Repeat("0", 40), base, "refs/heads/main"))
	next := s.f.commit("merged on GitHub", "b.txt", "b")
	s.f.git(s.f.work, "push", "-q", s.github, next+":refs/heads/main")
	service := NewGitHubMainPullService(newFakeMainPullStore(), s.client, &fixtureTokens{}, nil)
	service.gitHubGitBaseURL = func() string { return s.server.URL }
	service.readPolicy = func(context.Context, string, string, string, string) (string, error) { return "pull", nil }
	require.Equal(t, middleware.CredentialPlatform, service.mainWriter())
	out := service.pull(ctx, db.GithubMainPull{RepositoryID: 19})
	require.Equal(t, "synced", out.state, out.err)
	assert.Equal(t, next, s.main(t, owner, repo, "main"))
}

// gitSmartHTTP serves the public Git smart-HTTP routes over the push door as
// routes.GitSmartHandler does in composition, for a bearer token.
func gitSmartHTTP(svc *GitHTTPProxyService) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 3)
		if len(parts) != 3 {
			http.NotFound(w, r)
			return
		}
		owner, repo, rest := parts[0], strings.TrimSuffix(parts[1], ".git"), parts[2]
		var out bytes.Buffer
		var err error
		contentType := ""
		switch {
		case r.Method == http.MethodGet && rest == "info/refs":
			service := r.URL.Query().Get("service")
			contentType, err = svc.ProxyInfoRefs(r.Context(), owner, repo, service, token, &out)
			if contentType == "" {
				contentType = "application/x-" + service + "-advertisement"
			}
		case r.Method == http.MethodPost && rest == "git-upload-pack":
			contentType = "application/x-git-upload-pack-result"
			err = svc.ProxyUploadPack(r.Context(), owner, repo, token, r.Body, &out)
		case r.Method == http.MethodPost && rest == "git-receive-pack":
			contentType = "application/x-git-receive-pack-result"
			err = svc.ProxyReceivePack(r.Context(), owner, repo, token, r.Body, &out)
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			status := http.StatusInternalServerError
			var apiErr *pkgerrors.APIError
			if errors.As(err, &apiErr) {
				status = apiErr.Status
			}
			http.Error(w, err.Error(), status)
			return
		}
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(out.Bytes())
	})
}

// Re-importing an existing mirror refreshes it from GitHub with the import's
// system-minted, repository-bound sync token through the public push door.
// On an install a GitHub fast-forward of main is refreshed, but a GitHub
// rewrite of main is refused by the engine under its write lock: the refresh
// fails (refresh_failed, lease released so the next import retries it) and
// main stays where it was. Hosted repositories keep copying GitHub's refs.
func TestReimportRefreshNeverRewritesInstallMain(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(map[bool]string{true: "install", false: "hosted"}[install], func(t *testing.T) {
			ctx := context.Background()
			s := newInstallSync(t, install)
			const owner, repo = "importer", "smithers"
			require.NoError(t, s.client.InitRepo(ctx, owner, repo, "main", false))
			base := s.f.commit("base", "a.txt", "a")
			require.NoError(t, s.receive(ctx, middleware.CredentialSync, owner, repo, strings.Repeat("0", 40), base, "refs/heads/main"))

			repository := db.Repository{ID: 99, Name: repo, LowerName: repo, DefaultBookmark: "main"}
			doors := &mockGitHTTPProxyQuerier{
				getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
					// What the store returns for issueTemporarySyncPushToken's token.
					return db.GetAuthInfoByTokenHashRow{ID: 7, Username: owner, TokenID: 99, TokenSystemIssued: true,
						TokenScopes: "write:repository," + middleware.RepositoryRestrictionScope(99) + "," + middleware.SyncCredentialScope()}, nil
				},
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return repository, nil
				},
			}
			authorizer := &mockGitHTTPAuthorizer{authorizeFn: func(context.Context, int64, string, string, AccessMode) error { return nil }}
			door := httptest.NewServer(gitSmartHTTP(NewGitHTTPProxyService(doors, authorizer, s.client, WithGitHTTPInstallMainMirror(s.client.InstallMainMirror()))))
			t.Cleanup(door.Close)
			api := newRefreshImportAPI(t)
			t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", s.server.URL)
			ledger := &stageRecordingDB{}
			metrics := &githubImportCovMetrics{}
			existing := repository
			svc := NewGitHubImportService(ledger, testGitHubImportRepoDB{existing: &existing}, testGitHubImportTokenDB{}, s.client,
				testGitHubImportDecrypter{}, door.URL, WithGitHubImportHTTPClient(api.Client()), WithGitHubImportMetrics(metrics),
				withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) { return true, nil }))

			next := s.f.commit("merged on GitHub", "b.txt", "b")
			s.f.git(s.f.work, "push", "-q", s.github, next+":refs/heads/main", next+":refs/heads/feature")
			_, _, err := svc.runImport(ctx, 7, "smithersai", repo, owner, "main", "job-forward")
			require.NoError(t, err)
			assert.Equal(t, next, s.main(t, owner, repo, "main"), "the refresh fast-forwards main")
			assert.Equal(t, next, s.main(t, owner, repo, "feature"))
			assert.NotContains(t, metrics.attempts, "refresh_failed")

			s.f.git(s.f.work, "checkout", "-q", "-b", "rewrite", base)
			rewrite := s.f.commit("rewritten on GitHub", "c.txt", "c")
			s.f.git(s.f.work, "checkout", "-q", "main")
			feature := s.f.commit("feature on GitHub", "d.txt", "d")
			s.f.git(s.f.work, "push", "-q", "--force", s.github, rewrite+":refs/heads/main", feature+":refs/heads/feature")
			ledger.ledger = nil
			_, _, err = svc.runImport(ctx, 7, "smithersai", repo, owner, "main", "job-rewrite")
			require.NoError(t, err, "a failed refresh degrades to the existing mirror")
			if !install {
				assert.Equal(t, rewrite, s.main(t, owner, repo, "main"), "hosted mirrors copy GitHub's rewrite")
				return
			}
			assert.Equal(t, next, s.main(t, owner, repo, "main"), "a GitHub rewrite reached install main")
			assert.Equal(t, next, s.main(t, owner, repo, "feature"), "the refused refresh wrote none of its refs")
			assert.Contains(t, metrics.attempts, "refresh_failed")
			assert.Equal(t, []string{claimGitHubMirrorRefreshSQL, releaseGitHubMirrorRefreshSQL}, ledger.ledger,
				"the refused refresh releases its lease, so the next import retries it")
		})
	}
}
