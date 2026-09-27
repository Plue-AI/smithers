package services

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type fakeInstallationSource struct {
	mu        sync.Mutex
	pages     []url.Values
	inventory func(page int) ([]GitHubRepoListItem, error)
	diagnose  func(owner, repo string) (GitHubAccessDiagnosis, error)
	diagnosed atomic.Int32
	inFlight  atomic.Int32
	maxFlight atomic.Int32
}

func (f *fakeInstallationSource) ListAuthenticatedUserGitHubRepos(_ context.Context, userID int64, query url.Values) (GitHubRepoListResult, error) {
	f.mu.Lock()
	f.pages = append(f.pages, query)
	f.mu.Unlock()
	page, _ := strconv.Atoi(query.Get("page"))
	repos, err := f.inventory(page)
	return GitHubRepoListResult{Repos: repos}, err
}

func (f *fakeInstallationSource) DiagnoseGitHubAccess(_ context.Context, _ int64, owner, repo, surface string) (GitHubAccessDiagnosis, error) {
	if surface != GitHubRepoMetadataIssues {
		return GitHubAccessDiagnosis{}, fmt.Errorf("unexpected surface %q", surface)
	}
	n := f.inFlight.Add(1)
	defer f.inFlight.Add(-1)
	for {
		max := f.maxFlight.Load()
		if n <= max || f.maxFlight.CompareAndSwap(max, n) {
			break
		}
	}
	f.diagnosed.Add(1)
	return f.diagnose(owner, repo)
}

func onePage(items ...GitHubRepoListItem) func(int) ([]GitHubRepoListItem, error) {
	return func(page int) ([]GitHubRepoListItem, error) {
		if page == 1 {
			return items, nil
		}
		return nil, nil
	}
}

func okDiagnosis(id int64) GitHubAccessDiagnosis {
	return GitHubAccessDiagnosis{Verdict: GitHubAccessVerdictOK, InstallationID: id, Detail: "healthy"}
}

func TestVerifyGitHubAppInstallationsReturnsVerifiedReposAndFiltersByID(t *testing.T) {
	source := &fakeInstallationSource{
		inventory: onePage(
			GitHubRepoListItem{FullName: "ada/hello", PushedAt: "2026-09-12T00:00:00Z"},
			GitHubRepoListItem{FullName: "acme/api", PushedAt: "2026-09-01T00:00:00Z"},
		),
		diagnose: func(owner, _ string) (GitHubAccessDiagnosis, error) {
			if owner == "acme" {
				return okDiagnosis(99), nil
			}
			return okDiagnosis(42), nil
		},
	}

	repos, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.Nil(t, err)
	assert.Equal(t, []GitHubAppInstallationRepo{
		{FullName: "ada/hello", PushedAt: "2026-09-12T00:00:00Z", InstallationID: 42},
		{FullName: "acme/api", PushedAt: "2026-09-01T00:00:00Z", InstallationID: 99},
	}, repos)
	require.Len(t, source.pages, 1)
	assert.Equal(t, "pushed", source.pages[0].Get("sort"))
	assert.Equal(t, "desc", source.pages[0].Get("direction"))
	assert.Equal(t, "100", source.pages[0].Get("per_page"))
	assert.Equal(t, "1", source.pages[0].Get("page"))

	filtered, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "99")
	require.Nil(t, err)
	assert.Equal(t, []GitHubAppInstallationRepo{{FullName: "acme/api", PushedAt: "2026-09-01T00:00:00Z", InstallationID: 99}}, filtered)

	none, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "5")
	require.Nil(t, err)
	assert.NotNil(t, none, "an empty result must still encode as a JSON array")
	assert.Empty(t, none)
}

func TestVerifyGitHubAppInstallationsWalksLaterPagesAndDedupes(t *testing.T) {
	source := &fakeInstallationSource{
		inventory: func(page int) ([]GitHubRepoListItem, error) {
			if page == 1 {
				items := make([]GitHubRepoListItem, 0, 100)
				for i := 0; i < 100; i++ {
					items = append(items, GitHubRepoListItem{FullName: fmt.Sprintf("ada/repo-%d", i)})
				}
				return items, nil
			}
			return []GitHubRepoListItem{{FullName: "ada/repo-0"}, {FullName: "not a name"}, {FullName: "acme/api"}}, nil
		},
		diagnose: func(string, string) (GitHubAccessDiagnosis, error) { return okDiagnosis(42), nil },
	}

	repos, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.Nil(t, err)
	assert.Len(t, source.pages, 2)
	assert.Len(t, repos, 101)
	assert.Equal(t, "acme/api", repos[100].FullName)
	assert.Equal(t, int32(101), source.diagnosed.Load())
	assert.LessOrEqual(t, source.maxFlight.Load(), int32(6))
}

func TestVerifyGitHubAppInstallationsSkipsInvisibleAndUninstalled(t *testing.T) {
	source := &fakeInstallationSource{
		inventory: onePage(
			GitHubRepoListItem{FullName: "ada/gone"},
			GitHubRepoListItem{FullName: "ada/hidden"},
			GitHubRepoListItem{FullName: "ada/bare"},
			GitHubRepoListItem{FullName: "ada/hello"},
		),
		diagnose: func(_, repo string) (GitHubAccessDiagnosis, error) {
			switch repo {
			case "gone":
				return GitHubAccessDiagnosis{}, pkgerrors.NotFound("repository not found")
			case "hidden":
				return GitHubAccessDiagnosis{}, pkgerrors.Forbidden("forbidden")
			case "bare":
				return GitHubAccessDiagnosis{Verdict: GitHubAccessVerdictAppNotInstalled, Detail: "install it"}, nil
			}
			return okDiagnosis(42), nil
		},
	}

	repos, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.Nil(t, err)
	assert.Equal(t, []GitHubAppInstallationRepo{{FullName: "ada/hello", InstallationID: 42}}, repos)
}

func TestVerifyGitHubAppInstallationsBlockerIsAConflictOnlyWithoutRepos(t *testing.T) {
	blocked := GitHubAccessDiagnosis{Verdict: GitHubAccessVerdictNoOrgGrant, InstallationID: 42, Detail: "Your GitHub credential cannot access this repository."}
	source := &fakeInstallationSource{
		inventory: onePage(GitHubRepoListItem{FullName: "ada/hello"}),
		diagnose:  func(string, string) (GitHubAccessDiagnosis, error) { return blocked, nil },
	}

	_, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "42")
	require.NotNil(t, err)
	assert.Equal(t, http.StatusConflict, err.Status)
	assert.Equal(t, pkgerrors.CodeConflict, err.Code)
	assert.Equal(t, blocked.Detail, err.Message)

	// A blocker for another installation is filtered out with its repos.
	repos, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "7")
	require.Nil(t, err)
	assert.Empty(t, repos)

	// A verified repo wins over a blocker elsewhere.
	source.inventory = onePage(GitHubRepoListItem{FullName: "ada/hello"}, GitHubRepoListItem{FullName: "ada/ok"})
	source.diagnose = func(_, repo string) (GitHubAccessDiagnosis, error) {
		if repo == "ok" {
			return okDiagnosis(42), nil
		}
		return blocked, nil
	}
	repos, err = VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.Nil(t, err)
	assert.Equal(t, []GitHubAppInstallationRepo{{FullName: "ada/ok", InstallationID: 42}}, repos)
}

func TestVerifyGitHubAppInstallationsRefusesOverBudgetBeforeDiagnosis(t *testing.T) {
	source := &fakeInstallationSource{
		inventory: func(page int) ([]GitHubRepoListItem, error) {
			items := make([]GitHubRepoListItem, 0, 100)
			for i := 0; i < 100; i++ {
				items = append(items, GitHubRepoListItem{FullName: fmt.Sprintf("ada/page%d-%d", page, i)})
			}
			return items, nil
		},
		diagnose: func(string, string) (GitHubAccessDiagnosis, error) { return okDiagnosis(42), nil },
	}

	_, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.NotNil(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, err.Status)
	assert.Equal(t, "Smithers Cloud could not verify this repository inventory within its request budget.", err.Message)
	assert.Len(t, source.pages, 10)
	assert.Equal(t, int32(0), source.diagnosed.Load())

	// A complete walk over 900 candidates also refuses.
	source.pages = nil
	source.inventory = func(page int) ([]GitHubRepoListItem, error) {
		count := 100
		if page == 10 {
			count = 1
		}
		items := make([]GitHubRepoListItem, 0, count)
		for i := 0; i < count; i++ {
			items = append(items, GitHubRepoListItem{FullName: fmt.Sprintf("ada/page%d-%d", page, i)})
		}
		return items, nil
	}
	_, err = VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.NotNil(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, err.Status)
	assert.Equal(t, int32(0), source.diagnosed.Load())
}

func TestVerifyGitHubAppInstallationsRestatesUpstreamFailures(t *testing.T) {
	source := &fakeInstallationSource{
		inventory: func(int) ([]GitHubRepoListItem, error) {
			return nil, pkgerrors.GitHubReconnectRequired("raw upstream prose")
		},
		diagnose: func(string, string) (GitHubAccessDiagnosis, error) { return okDiagnosis(42), nil },
	}
	_, err := VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.NotNil(t, err)
	assert.Equal(t, http.StatusUnauthorized, err.Status)
	assert.Equal(t, pkgerrors.CodeGitHubReconnectRequired, err.Code)
	assert.Equal(t, gitHubInstallationUnverifiedMessage, err.Message)

	source.inventory = onePage(GitHubRepoListItem{FullName: "ada/hello"})
	source.diagnose = func(string, string) (GitHubAccessDiagnosis, error) {
		return GitHubAccessDiagnosis{}, pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "github installation lookup returned status 500")
	}
	_, err = VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.NotNil(t, err)
	assert.Equal(t, http.StatusBadGateway, err.Status)
	assert.Equal(t, gitHubInstallationUnverifiedMessage, err.Message)

	source.diagnose = func(string, string) (GitHubAccessDiagnosis, error) { return GitHubAccessDiagnosis{}, context.Canceled }
	_, err = VerifyGitHubAppInstallations(context.Background(), source, 7, "")
	require.NotNil(t, err)
	assert.Equal(t, http.StatusBadGateway, err.Status)
	assert.Equal(t, gitHubInstallationUnverifiedMessage, err.Message)
}
