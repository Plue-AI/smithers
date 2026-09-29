package routes

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

type wikiStartupBarrier struct {
	WikiCollaborationService
	mu      sync.Mutex
	reads   int
	pauseAt int
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func (s *wikiStartupBarrier) ListWikiUpdates(ctx context.Context, actor *db.User, owner, repo, slug string, page, after int64) ([]services.WikiUpdateEvent, error) {
	rows, err := s.WikiCollaborationService.ListWikiUpdates(ctx, actor, owner, repo, slug, page, after)
	s.mu.Lock()
	s.reads++
	pause := s.reads == s.pauseAt
	s.mu.Unlock()
	if pause {
		s.once.Do(func() {
			close(s.entered)
			select {
			case <-s.release:
			case <-ctx.Done():
			}
		})
	}
	return rows, err
}

func wikiStartupEvent(t *testing.T, reader *bufio.Reader) (string, string) {
	t.Helper()
	var kind, data string
	for {
		line, err := reader.ReadString('\n')
		if err == io.EOF {
			return kind, data
		}
		require.NoError(t, err)
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "event:") {
			kind = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
		if strings.HasPrefix(line, "data:") {
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		}
		if line == "" && kind != "" {
			return kind, data
		}
	}
}

func wikiStartupServer(t *testing.T, source *revocation.Bus, broker *sse.Broker, service WikiCollaborationService, actor *db.User, repo *db.Repository, slug string, beforeHandler func(context.Context)) *httptest.Server {
	t.Helper()
	SetRevocationSource(source)
	t.Cleanup(func() { SetRevocationSource(nil) })
	h := WikiCollaborationHandler{Service: service, Broker: broker}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = withRouteParams(r, map[string]string{"owner": actor.Username, "repo": repo.Name, "slug": slug})
		r = withRepoCtx(r, repo.ID, actor.Username, repo.Name)
		r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
			User: actor, IsTokenAuth: true, TokenHash: "wiki-startup-token",
			Scopes: middleware.ScopeSet{middleware.ScopeReadRepository: {}},
		}))
		if beforeHandler != nil {
			beforeHandler(r.Context())
		}
		h.Stream(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func wikiStartupRequest(t *testing.T, ctx context.Context, server *httptest.Server, pageID int64) *http.Request {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"?page_id="+strconv.FormatInt(pageID, 10)+"&visibility=private", nil)
	require.NoError(t, err)
	return request
}

func TestWikiCollaborationStream_CompletedStartupRevocationPreventsPrivateReplay(t *testing.T) {
	for _, tc := range []struct {
		name    string
		kind    revocation.Kind
		pauseAt int
	}{
		{"token revoked during first read", revocation.KindTokenRevoked, 1},
		{"user disabled during first read", revocation.KindUserDisabled, 1},
		{"token revoked during replay read", revocation.KindTokenRevoked, 2},
		{"user disabled during replay read", revocation.KindUserDisabled, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			pool, err := pgxpool.New(ctx, testdb.New(t).URL)
			require.NoError(t, err)
			defer pool.Close()
			broker := sse.NewBroker(pool)
			require.NoError(t, broker.Start(ctx))
			defer broker.Stop()
			bus := revocation.NewBus(nil, nil)
			fixture := &wikiRoutesFixture{events: []services.WikiUpdateEvent{{ID: 1, PageID: 42, Revision: 1, Slug: "home"}}}
			barrier := &wikiStartupBarrier{WikiCollaborationService: fixture, pauseAt: tc.pauseAt, entered: make(chan struct{}), release: make(chan struct{})}
			actor := &db.User{ID: 7, Username: "alice", LowerUsername: "alice"}
			repo := &db.Repository{ID: 42, Name: "demo"}
			server := wikiStartupServer(t, bus, broker, barrier, actor, repo, "home", nil)
			responses := make(chan *http.Response, 1)
			errors := make(chan error, 1)
			request := wikiStartupRequest(t, ctx, server, 42)
			go func() {
				response, err := http.DefaultClient.Do(request)
				responses <- response
				errors <- err
			}()
			select {
			case <-barrier.entered:
			case <-ctx.Done():
				t.Fatal("first successful service read did not reach barrier")
			}
			event := revocation.Event{ID: 1, Kind: tc.kind, UserID: actor.ID, TokenHash: "wiki-startup-token"}
			bus.Deliver(event)
			if tc.kind == revocation.KindTokenRevoked {
				require.True(t, bus.IsTokenRevoked(event.TokenHash))
			} else {
				require.True(t, bus.IsUserDisabled(actor.ID))
			}
			fixture.Lock()
			fixture.events = append(fixture.events, services.WikiUpdateEvent{ID: 2, PageID: 42, Revision: 2, Slug: "post-revocation-private-name"})
			fixture.Unlock()
			close(barrier.release)
			response := <-responses
			require.NoError(t, <-errors)
			require.NotNil(t, response)
			defer response.Body.Close()
			if tc.pauseAt == 1 {
				require.Equal(t, http.StatusForbidden, response.StatusCode)
				body, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				require.NotContains(t, string(body), "post-revocation-private-name")
				return
			}
			require.Equal(t, http.StatusOK, response.StatusCode)
			reader := bufio.NewReader(response.Body)
			kind, data := wikiStartupEvent(t, reader)
			require.Equal(t, "revoked", kind)
			require.NotContains(t, data, "post-revocation-private-name")
			body, err := io.ReadAll(reader)
			require.NoError(t, err)
			require.NotContains(t, string(body), "wiki.update")
		})
	}
}

func TestWikiCollaborationStream_NormalReplayAndLaterRevocation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, testdb.New(t).URL)
	require.NoError(t, err)
	defer pool.Close()
	broker := sse.NewBroker(pool)
	require.NoError(t, broker.Start(ctx))
	defer broker.Stop()
	bus := revocation.NewBus(nil, nil)
	fixture := &wikiRoutesFixture{events: []services.WikiUpdateEvent{{ID: 1, PageID: 42, Revision: 1, Slug: "home"}}}
	actor := &db.User{ID: 7, Username: "alice", LowerUsername: "alice"}
	repo := &db.Repository{ID: 42, Name: "demo"}
	server := wikiStartupServer(t, bus, broker, fixture, actor, repo, "home", nil)
	response, err := http.DefaultClient.Do(wikiStartupRequest(t, ctx, server, 42))
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
	reader := bufio.NewReader(response.Body)
	kind, data := wikiStartupEvent(t, reader)
	require.Equal(t, "wiki.update", kind)
	require.Contains(t, data, `"revision":1`)
	bus.Deliver(revocation.Event{ID: 3, Kind: revocation.KindTokenRevoked, UserID: actor.ID, TokenHash: "wiki-startup-token"})
	kind, _ = wikiStartupEvent(t, reader)
	require.Equal(t, "revoked", kind)
}

func TestWikiCollaborationStream_RevokedBeforeHandlerAdmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, testdb.New(t).URL)
	require.NoError(t, err)
	defer pool.Close()
	broker := sse.NewBroker(pool)
	require.NoError(t, broker.Start(ctx))
	defer broker.Stop()
	bus := revocation.NewBus(nil, nil)
	fixture := &wikiRoutesFixture{events: []services.WikiUpdateEvent{{ID: 1, PageID: 42, Revision: 1, Slug: "private-home"}}}
	actor := &db.User{ID: 7, Username: "alice", LowerUsername: "alice"}
	repo := &db.Repository{ID: 42, Name: "demo"}
	entered, release := make(chan struct{}), make(chan struct{})
	server := wikiStartupServer(t, bus, broker, fixture, actor, repo, "home", func(requestCtx context.Context) {
		close(entered)
		select {
		case <-release:
		case <-requestCtx.Done():
		}
	})
	request := wikiStartupRequest(t, ctx, server, 42)
	responses := make(chan *http.Response, 1)
	errors := make(chan error, 1)
	go func() { response, err := http.DefaultClient.Do(request); responses <- response; errors <- err }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("request did not reach handler admission barrier")
	}
	bus.Deliver(revocation.Event{ID: 4, Kind: revocation.KindTokenRevoked, UserID: actor.ID, TokenHash: "wiki-startup-token"})
	require.True(t, bus.IsTokenRevoked("wiki-startup-token"))
	close(release)
	response := <-responses
	require.NoError(t, <-errors)
	require.NotNil(t, response)
	defer response.Body.Close()
	require.Equal(t, http.StatusForbidden, response.StatusCode)
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.NotContains(t, string(body), "private-home")
}

func TestWikiCollaborationStream_CanonicalStartupRevocation(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	service := services.NewWikiService(q, nil, services.WithWikiCollaboration(q, nil), services.WithWikiContent(blob.NewMemoryStore()))
	for _, tc := range []struct {
		name string
		kind revocation.Kind
	}{
		{"token revoked", revocation.KindTokenRevoked},
		{"user disabled", revocation.KindUserDisabled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			var actor db.User
			username := "wikiowner_" + strings.ReplaceAll(tc.name, " ", "_")
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id,username`, username, username+"@example.test").Scan(&actor.ID, &actor.Username))
			var repo db.Repository
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public) VALUES($1,'demo','demo',false) RETURNING id,name`, actor.ID).Scan(&repo.ID, &repo.Name))
			private, err := services.WithWikiVisibility(ctx, "private")
			require.NoError(t, err)
			page, err := service.CreateWikiPage(private, &actor, actor.Username, repo.Name, services.CreateWikiPageInput{Title: "Home", Body: "private"})
			require.NoError(t, err)
			broker := sse.NewBroker(pool)
			require.NoError(t, broker.Start(ctx))
			defer broker.Stop()
			bus := revocation.NewBus(nil, nil)
			barrier := &wikiStartupBarrier{WikiCollaborationService: service, pauseAt: 1, entered: make(chan struct{}), release: make(chan struct{})}
			server := wikiStartupServer(t, bus, broker, barrier, &actor, &repo, page.Slug, nil)
			responses := make(chan *http.Response, 1)
			errors := make(chan error, 1)
			request := wikiStartupRequest(t, ctx, server, page.ID)
			go func() { response, err := http.DefaultClient.Do(request); responses <- response; errors <- err }()
			select {
			case <-barrier.entered:
			case <-ctx.Done():
				t.Fatal("canonical first read did not reach barrier")
			}
			event := revocation.Event{ID: 11, Kind: tc.kind, UserID: actor.ID, TokenHash: "wiki-startup-token"}
			bus.Deliver(event)
			if tc.kind == revocation.KindTokenRevoked {
				require.True(t, bus.IsTokenRevoked(event.TokenHash))
			} else {
				require.True(t, bus.IsUserDisabled(actor.ID))
			}
			newSlug := "post-revocation-private-name"
			updated, err := service.UpdateWikiPage(private, &actor, actor.Username, repo.Name, page.Slug, services.UpdateWikiPageInput{Slug: &newSlug, ExpectedRevision: &page.Revision})
			require.NoError(t, err)
			require.Equal(t, int64(2), updated.Revision)
			committed, err := service.ListWikiUpdates(private, &actor, actor.Username, repo.Name, page.Slug, page.ID, 0)
			require.NoError(t, err)
			require.Len(t, committed, 2)
			require.Equal(t, newSlug, committed[1].Slug)
			close(barrier.release)
			response := <-responses
			require.NoError(t, <-errors)
			require.NotNil(t, response)
			defer response.Body.Close()
			require.Equal(t, http.StatusForbidden, response.StatusCode)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.NotContains(t, string(body), newSlug)
		})
	}
}
