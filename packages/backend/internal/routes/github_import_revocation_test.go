package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type importRevocationRecorder struct {
	*httptest.ResponseRecorder
	firstFlush chan struct{}
	once       sync.Once
}

func (r *importRevocationRecorder) Flush() {
	r.ResponseRecorder.Flush()
	r.once.Do(func() { close(r.firstFlush) })
}

func TestGitHubImportStreamEndsWhenUserDisabled(t *testing.T) {
	previous := currentRevocationSource()
	bus := revocation.NewBus(nil, nil)
	SetRevocationSource(bus)
	t.Cleanup(func() { SetRevocationSource(previous) })
	oldPoll, oldDuration := githubImportStreamPollInterval, githubImportStreamMaxDuration
	githubImportStreamPollInterval, githubImportStreamMaxDuration = time.Millisecond, 250*time.Millisecond
	t.Cleanup(func() { githubImportStreamPollInterval, githubImportStreamMaxDuration = oldPoll, oldDuration })
	service := &mockGitHubImportRouteService{getFn: func(context.Context, int64, string) (services.ImportJob, error) {
		if bus.IsUserDisabled(7) {
			return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "secret-after-revoke"}, nil
		}
		return services.ImportJob{ImportJobID: "job-1", Status: "cloning", RepoName: "before-revoke"}, nil
	}}
	handler := &GitHubImportHandler{Service: service}
	router := chi.NewRouter()
	router.Get("/api/github/import/{id}", handler.GetImportJob)
	ctx, cancel := context.WithTimeout(newAuthedRequest(t, 7, "token-hash").Context(), time.Second)
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil).WithContext(ctx)
	req.Header.Set("Accept", "text/event-stream")
	rec := &importRevocationRecorder{ResponseRecorder: httptest.NewRecorder(), firstFlush: make(chan struct{})}
	done := make(chan struct{})
	go func() { defer close(done); router.ServeHTTP(rec, req) }()
	select {
	case <-rec.firstFlush:
	case <-ctx.Done():
		t.Fatal("initial import frame did not flush")
	}
	bus.Deliver(revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7})
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("import stream did not end after user revocation")
	}
	body := rec.Body.String()
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, body, `"repoName":"before-revoke"`)
	require.NotContains(t, body, "secret-after-revoke")
	require.Contains(t, body, "event: revoked")
}

func newImportRevocationRoute(t *testing.T, get func(context.Context, int64, string) (services.ImportJob, error)) (*revocation.Bus, http.Handler) {
	t.Helper()
	previous := currentRevocationSource()
	bus := revocation.NewBus(nil, nil)
	SetRevocationSource(bus)
	t.Cleanup(func() { SetRevocationSource(previous) })
	oldPoll, oldDuration := githubImportStreamPollInterval, githubImportStreamMaxDuration
	githubImportStreamPollInterval, githubImportStreamMaxDuration = time.Millisecond, 300*time.Millisecond
	t.Cleanup(func() { githubImportStreamPollInterval, githubImportStreamMaxDuration = oldPoll, oldDuration })
	router := chi.NewRouter()
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{getFn: get}}
	router.Get("/api/github/import/{id}", handler.GetImportJob)
	return bus, router
}

func newImportRevocationRequest(t *testing.T) (*http.Request, context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(newAuthedRequest(t, 7, "token-hash").Context(), time.Second)
	req := httptest.NewRequest(http.MethodGet, "/api/github/import/job-1", nil).WithContext(ctx)
	req.Header.Set("Accept", "text/event-stream")
	return req, ctx, cancel
}

func serveImportRevocation(router http.Handler, req *http.Request) (*importRevocationRecorder, <-chan struct{}) {
	rec := &importRevocationRecorder{ResponseRecorder: httptest.NewRecorder(), firstFlush: make(chan struct{})}
	done := make(chan struct{})
	go func() { defer close(done); router.ServeHTTP(rec, req) }()
	return rec, done
}

func awaitImportRevocation(t *testing.T, ctx context.Context, ch <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-ch:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for %s", label)
	}
}

func TestGitHubImportStreamEndsWhenTokenRevokedWhileIdle(t *testing.T) {
	bus, router := newImportRevocationRoute(t, func(context.Context, int64, string) (services.ImportJob, error) {
		return services.ImportJob{ImportJobID: "job-1", Status: "cloning", RepoName: "before-revoke"}, nil
	})
	githubImportStreamPollInterval = time.Hour
	req, ctx, cancel := newImportRevocationRequest(t)
	defer cancel()
	rec, done := serveImportRevocation(router, req)
	awaitImportRevocation(t, ctx, rec.firstFlush, "first frame")
	bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-hash"})
	awaitImportRevocation(t, ctx, done, "revoked stream close")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "event: revoked")
	require.NotContains(t, rec.Body.String(), "event: timeout")
}

func TestGitHubImportStreamDeniesCachedRevocationBeforeFetch(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event revocation.Event
	}{
		{"token", revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-hash"}},
		{"scopes", revocation.Event{Kind: revocation.KindTokenScopesNarrowed, TokenHash: "token-hash"}},
		{"user", revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			bus, router := newImportRevocationRoute(t, func(context.Context, int64, string) (services.ImportJob, error) {
				calls++
				return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "secret-after-revoke"}, nil
			})
			bus.Deliver(tc.event)
			req, _, cancel := newImportRevocationRequest(t)
			defer cancel()
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusForbidden, rec.Code)
			require.Zero(t, calls)
			require.NotContains(t, rec.Body.String(), "secret-after-revoke")
		})
	}
}

func TestGitHubImportStreamRevokedDuringInitialFetch(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event revocation.Event
	}{
		{"token", revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-hash"}},
		{"scopes", revocation.Event{Kind: revocation.KindTokenScopesNarrowed, TokenHash: "token-hash"}},
		{"user", revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fetching, release := make(chan struct{}), make(chan struct{})
			bus, router := newImportRevocationRoute(t, func(context.Context, int64, string) (services.ImportJob, error) {
				close(fetching)
				<-release
				return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "secret-after-revoke"}, nil
			})
			req, ctx, cancel := newImportRevocationRequest(t)
			defer cancel()
			rec, done := serveImportRevocation(router, req)
			awaitImportRevocation(t, ctx, fetching, "initial fetch")
			bus.Deliver(tc.event)
			close(release)
			awaitImportRevocation(t, ctx, done, "initial fetch return")
			require.Equal(t, http.StatusForbidden, rec.Code)
			require.NotContains(t, rec.Body.String(), "secret-after-revoke")
		})
	}
}

func TestGitHubImportStreamRevokedDuringLaterFetch(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event revocation.Event
	}{
		{"token", revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-hash"}},
		{"scopes", revocation.Event{Kind: revocation.KindTokenScopesNarrowed, TokenHash: "token-hash"}},
		{"user", revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fetching, release := make(chan struct{}), make(chan struct{})
			calls := 0
			bus, router := newImportRevocationRoute(t, func(context.Context, int64, string) (services.ImportJob, error) {
				calls++
				if calls == 1 {
					return services.ImportJob{ImportJobID: "job-1", Status: "cloning", RepoName: "before-revoke"}, nil
				}
				close(fetching)
				<-release
				return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "secret-after-revoke"}, nil
			})
			req, ctx, cancel := newImportRevocationRequest(t)
			defer cancel()
			rec, done := serveImportRevocation(router, req)
			awaitImportRevocation(t, ctx, rec.firstFlush, "first frame")
			awaitImportRevocation(t, ctx, fetching, "later fetch")
			bus.Deliver(tc.event)
			close(release)
			awaitImportRevocation(t, ctx, done, "later fetch return")
			require.Equal(t, http.StatusOK, rec.Code)
			require.Contains(t, rec.Body.String(), "event: revoked")
			require.NotContains(t, rec.Body.String(), "secret-after-revoke")
		})
	}
}

func TestGitHubImportStreamIgnoresUnrelatedRevocations(t *testing.T) {
	fetching, release := make(chan struct{}), make(chan struct{})
	calls := 0
	bus, router := newImportRevocationRoute(t, func(context.Context, int64, string) (services.ImportJob, error) {
		calls++
		if calls == 1 {
			return services.ImportJob{ImportJobID: "job-1", Status: "cloning", RepoName: "before-revoke"}, nil
		}
		close(fetching)
		<-release
		return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "allowed-ready"}, nil
	})
	req, ctx, cancel := newImportRevocationRequest(t)
	defer cancel()
	rec, done := serveImportRevocation(router, req)
	awaitImportRevocation(t, ctx, rec.firstFlush, "first frame")
	awaitImportRevocation(t, ctx, fetching, "later fetch")
	bus.Deliver(revocation.Event{Kind: revocation.KindUserDisabled, UserID: 8})
	bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "other-token"})
	close(release)
	awaitImportRevocation(t, ctx, done, "normal completion")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "allowed-ready")
	require.NotContains(t, rec.Body.String(), "event: revoked")
}

func TestGitHubImportStreamCompletesWithoutRevocation(t *testing.T) {
	_, router := newImportRevocationRoute(t, func(context.Context, int64, string) (services.ImportJob, error) {
		return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "allowed-ready"}, nil
	})
	req, _, cancel := newImportRevocationRequest(t)
	defer cancel()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"status":"ready"`)
	require.Contains(t, rec.Body.String(), "allowed-ready")
	require.NotContains(t, rec.Body.String(), "event: revoked")
}

func TestGitHubImportStreamRevocationBeatsInitialServiceError(t *testing.T) {
	fetching, release := make(chan struct{}), make(chan struct{})
	bus, router := newImportRevocationRoute(t, func(context.Context, int64, string) (services.ImportJob, error) {
		close(fetching)
		<-release
		return services.ImportJob{}, errors.New("private fetch failure")
	})
	req, ctx, cancel := newImportRevocationRequest(t)
	defer cancel()
	rec, done := serveImportRevocation(router, req)
	awaitImportRevocation(t, ctx, fetching, "initial fetch")
	bus.Deliver(revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-hash"})
	close(release)
	awaitImportRevocation(t, ctx, done, "initial fetch error return")
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.NotContains(t, rec.Body.String(), "private fetch failure")
	require.NotContains(t, rec.Body.String(), "event: import_job")
}

// startupImportRevocationSource delivers a real bus event while Watch is being
// installed. It deliberately exposes no cache checker, so the handler must
// consume the newly registered watch before fetching private status.
type startupImportRevocationSource struct {
	bus   *revocation.Bus
	event revocation.Event
}

func (s *startupImportRevocationSource) Watch(ctx context.Context, principal revocation.Principal) <-chan revocation.Event {
	ch := s.bus.Watch(ctx, principal)
	s.bus.Deliver(s.event)
	return ch
}

func (s *startupImportRevocationSource) Subscribe(fn func(revocation.Event)) func() {
	return s.bus.Subscribe(fn)
}

func TestGitHubImportStreamFencesRevocationDuringWatchInstallation(t *testing.T) {
	previous := currentRevocationSource()
	SetRevocationSource(&startupImportRevocationSource{
		bus:   revocation.NewBus(nil, nil),
		event: revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7},
	})
	t.Cleanup(func() { SetRevocationSource(previous) })
	calls := 0
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{getFn: func(context.Context, int64, string) (services.ImportJob, error) {
		calls++
		return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "secret-after-revoke"}, nil
	}}}
	router := chi.NewRouter()
	router.Get("/api/github/import/{id}", handler.GetImportJob)
	req, _, cancel := newImportRevocationRequest(t)
	defer cancel()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Zero(t, calls)
	require.NotContains(t, rec.Body.String(), "secret-after-revoke")
}

type cleanupImportRevocationSource struct {
	watched chan (<-chan struct{})
}

func (s *cleanupImportRevocationSource) Watch(ctx context.Context, _ revocation.Principal) <-chan revocation.Event {
	s.watched <- ctx.Done()
	return make(chan revocation.Event)
}

func (*cleanupImportRevocationSource) Subscribe(func(revocation.Event)) func() {
	return func() {}
}

func TestGitHubImportStreamCancelsWatchOnNormalCompletion(t *testing.T) {
	previous := currentRevocationSource()
	source := &cleanupImportRevocationSource{watched: make(chan (<-chan struct{}), 1)}
	SetRevocationSource(source)
	t.Cleanup(func() { SetRevocationSource(previous) })
	handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{getFn: func(context.Context, int64, string) (services.ImportJob, error) {
		return services.ImportJob{ImportJobID: "job-1", Status: "ready"}, nil
	}}}
	router := chi.NewRouter()
	router.Get("/api/github/import/{id}", handler.GetImportJob)
	req, ctx, cancel := newImportRevocationRequest(t)
	defer cancel()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"status":"ready"`)
	select {
	case watchDone := <-source.watched:
		awaitImportRevocation(t, ctx, watchDone, "watch cleanup")
	case <-ctx.Done():
		t.Fatal("watch was not installed")
	}
}

// cachedImportRevocationSource models the interval after the bus updates its
// cache and before its watcher callback runs.
type cachedImportRevocationSource struct {
	*revocation.Bus
}

func (*cachedImportRevocationSource) Watch(context.Context, revocation.Principal) <-chan revocation.Event {
	return make(chan revocation.Event)
}

func TestGitHubImportStreamChecksCacheAfterFetchBeforeFirstFrame(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event revocation.Event
	}{
		{"token", revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-hash"}},
		{"user", revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previous := currentRevocationSource()
			bus := revocation.NewBus(nil, nil)
			SetRevocationSource(&cachedImportRevocationSource{Bus: bus})
			t.Cleanup(func() { SetRevocationSource(previous) })
			fetching, release := make(chan struct{}), make(chan struct{})
			handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				close(fetching)
				<-release
				return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "secret-after-revoke"}, nil
			}}}
			router := chi.NewRouter()
			router.Get("/api/github/import/{id}", handler.GetImportJob)
			req, ctx, cancel := newImportRevocationRequest(t)
			defer cancel()
			rec, done := serveImportRevocation(router, req)
			awaitImportRevocation(t, ctx, fetching, "initial fetch")
			bus.Deliver(tc.event)
			close(release)
			awaitImportRevocation(t, ctx, done, "initial fetch return")
			require.Equal(t, http.StatusForbidden, rec.Code)
			require.NotContains(t, rec.Body.String(), "secret-after-revoke")
		})
	}
}

func TestGitHubImportStreamChecksCacheAfterFetchBeforeLaterFrame(t *testing.T) {
	for _, tc := range []struct {
		name  string
		event revocation.Event
	}{
		{"token", revocation.Event{Kind: revocation.KindTokenRevoked, TokenHash: "token-hash"}},
		{"user", revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previous := currentRevocationSource()
			bus := revocation.NewBus(nil, nil)
			SetRevocationSource(&cachedImportRevocationSource{Bus: bus})
			t.Cleanup(func() { SetRevocationSource(previous) })
			oldPoll, oldDuration := githubImportStreamPollInterval, githubImportStreamMaxDuration
			githubImportStreamPollInterval, githubImportStreamMaxDuration = time.Millisecond, 300*time.Millisecond
			t.Cleanup(func() { githubImportStreamPollInterval, githubImportStreamMaxDuration = oldPoll, oldDuration })
			fetching, release := make(chan struct{}), make(chan struct{})
			calls := 0
			handler := &GitHubImportHandler{Service: &mockGitHubImportRouteService{getFn: func(context.Context, int64, string) (services.ImportJob, error) {
				calls++
				if calls == 1 {
					return services.ImportJob{ImportJobID: "job-1", Status: "cloning"}, nil
				}
				close(fetching)
				<-release
				return services.ImportJob{ImportJobID: "job-1", Status: "ready", RepoName: "secret-after-revoke"}, nil
			}}}
			router := chi.NewRouter()
			router.Get("/api/github/import/{id}", handler.GetImportJob)
			req, ctx, cancel := newImportRevocationRequest(t)
			defer cancel()
			rec, done := serveImportRevocation(router, req)
			awaitImportRevocation(t, ctx, rec.firstFlush, "first frame")
			awaitImportRevocation(t, ctx, fetching, "later fetch")
			bus.Deliver(tc.event)
			close(release)
			awaitImportRevocation(t, ctx, done, "later fetch return")
			require.Equal(t, http.StatusOK, rec.Code)
			require.Contains(t, rec.Body.String(), "event: revoked")
			require.NotContains(t, rec.Body.String(), "secret-after-revoke")
		})
	}
}
