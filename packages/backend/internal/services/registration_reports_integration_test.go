package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeGitHub is the anonymous GitHub API: only the repositories it lists as
// public answer; everything else is 404, exactly as GitHub hides a private one.
type fakeGitHub struct {
	mu      sync.Mutex
	public  map[string]string // repo -> head commit
	commits map[string]bool   // repo@commit exists
	status  int               // forces every answer when non-zero
	calls   int
}

func (g *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls++
	if g.status != 0 {
		w.WriteHeader(g.status)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/repos/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		http.NotFound(w, r)
		return
	}
	repo := parts[0] + "/" + parts[1]
	head, ok := g.public[repo]
	if !ok {
		http.NotFound(w, r)
		return
	}
	switch {
	case len(parts) == 2:
		_ = json.NewEncoder(w).Encode(map[string]any{"private": false})
	case len(parts) == 4 && parts[3] == "HEAD":
		_, _ = w.Write([]byte(head))
	case len(parts) == 4 && (g.commits[repo+"@"+parts[3]] || parts[3] == head):
		_, _ = w.Write([]byte(parts[3]))
	default:
		w.WriteHeader(http.StatusUnprocessableEntity)
	}
}

func githubServer(t *testing.T, g *fakeGitHub) {
	t.Helper()
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
}

const (
	sharedCommit = "fc3f257b643b41dd8de24d4b0d3248253ab411c5"
	olderCommit  = "0123456789abcdef0123456789abcdef01234567"
)

func reportOf(repo, commit string) json.RawMessage {
	return json.RawMessage(`{"repo":"` + repo + `","clone":{"_tag":"clone","repo":"` + repo + `","commit":"` + commit + `","files":3,"lines":9}}`)
}

func TestRegistrationReportsSharePublicRepositoryAtItsCommit(t *testing.T) {
	pool := newProductTestPool(t)
	github := &fakeGitHub{public: map[string]string{"acme/widgets": sharedCommit}}
	githubServer(t, github)
	reports := NewRegistrationReports(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_, found, err := reports.Lookup(ctx, "acme/widgets")
	require.NoError(t, err)
	require.False(t, found, "nothing is recorded yet")

	wrote, err := reports.Record(ctx, "acme/widgets", sharedCommit, reportOf("acme/widgets", sharedCommit))
	require.NoError(t, err)
	require.True(t, wrote)

	shared, found, err := reports.Lookup(ctx, "acme/widgets")
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, sharedCommit, shared.Commit)
	require.JSONEq(t, string(reportOf("acme/widgets", sharedCommit)), string(shared.Report))

	// The first report of a commit stays.
	other := json.RawMessage(`{"repo":"acme/widgets","clone":{"repo":"acme/widgets","commit":"` + sharedCommit + `","files":99}}`)
	wrote, err = reports.Record(ctx, "acme/widgets", sharedCommit, other)
	require.NoError(t, err)
	require.False(t, wrote)
	shared, _, _ = reports.Lookup(ctx, "acme/widgets")
	require.JSONEq(t, string(reportOf("acme/widgets", sharedCommit)), string(shared.Report))

	// The repository moved on: the old report is not served at the new commit.
	github.mu.Lock()
	github.public["acme/widgets"] = olderCommit
	github.mu.Unlock()
	_, found, err = reports.Lookup(ctx, "acme/widgets")
	require.NoError(t, err)
	require.False(t, found)
}

func TestRegistrationReportsNeverShareOrServePrivateRepositories(t *testing.T) {
	pool := newProductTestPool(t)
	github := &fakeGitHub{public: map[string]string{"acme/widgets": sharedCommit}}
	githubServer(t, github)
	reports := NewRegistrationReports(pool)
	ctx := context.Background()

	// GitHub answers 404 for a private repository: a report for it is refused and nothing is stored.
	wrote, err := reports.Record(ctx, "acme/secret", sharedCommit, reportOf("acme/secret", sharedCommit))
	require.ErrorIs(t, err, ErrRegistrationReportUnshareable)
	require.False(t, wrote)
	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_registration_reports`).Scan(&rows))
	require.Zero(t, rows)
	_, found, err := reports.Lookup(ctx, "acme/secret")
	require.NoError(t, err)
	require.False(t, found)

	// A public repository that later turns private stops being served, though its row remains.
	_, err = reports.Record(ctx, "acme/widgets", sharedCommit, reportOf("acme/widgets", sharedCommit))
	require.NoError(t, err)
	github.mu.Lock()
	delete(github.public, "acme/widgets")
	github.mu.Unlock()
	_, found, err = reports.Lookup(ctx, "acme/widgets")
	require.NoError(t, err)
	require.False(t, found)
}

func TestRegistrationReportsRefuseReportsThatDoNotDescribeTheirKey(t *testing.T) {
	pool := newProductTestPool(t)
	github := &fakeGitHub{public: map[string]string{"acme/widgets": sharedCommit, "acme/other": sharedCommit}}
	githubServer(t, github)
	reports := NewRegistrationReports(pool)
	ctx := context.Background()
	for name, tc := range map[string]struct {
		repo, commit string
		report       json.RawMessage
	}{
		"other repository in the report": {"acme/widgets", sharedCommit, reportOf("acme/other", sharedCommit)},
		"other commit in the report":     {"acme/widgets", sharedCommit, reportOf("acme/widgets", olderCommit)},
		"commit GitHub does not have":    {"acme/widgets", olderCommit, reportOf("acme/widgets", olderCommit)},
		"malformed commit":               {"acme/widgets", "HEAD", reportOf("acme/widgets", "HEAD")},
		"malformed repository":           {"Acme/Widgets", sharedCommit, reportOf("Acme/Widgets", sharedCommit)},
		"not an object":                  {"acme/widgets", sharedCommit, json.RawMessage(`[1]`)},
		"oversized":                      {"acme/widgets", sharedCommit, json.RawMessage(`{"repo":"acme/widgets","pad":"` + strings.Repeat("x", 1<<20) + `"}`)},
	} {
		t.Run(name, func(t *testing.T) {
			wrote, err := reports.Record(ctx, tc.repo, tc.commit, tc.report)
			require.ErrorIs(t, err, ErrRegistrationReportUnshareable)
			require.False(t, wrote)
		})
	}
	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_registration_reports`).Scan(&rows))
	require.Zero(t, rows)
}

// An unreadable GitHub is an error, never a claim that the repository is private or absent.
func TestRegistrationReportsFailClosedWhenGitHubIsUnreadable(t *testing.T) {
	pool := newProductTestPool(t)
	github := &fakeGitHub{public: map[string]string{"acme/widgets": sharedCommit}, status: http.StatusTooManyRequests}
	githubServer(t, github)
	reports := NewRegistrationReports(pool)
	ctx := context.Background()
	_, _, err := reports.Lookup(ctx, "acme/widgets")
	require.Error(t, err)
	wrote, err := reports.Record(ctx, "acme/widgets", sharedCommit, reportOf("acme/widgets", sharedCommit))
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrRegistrationReportUnshareable)
	require.False(t, wrote)
	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_registration_reports`).Scan(&rows))
	require.Zero(t, rows)
}
