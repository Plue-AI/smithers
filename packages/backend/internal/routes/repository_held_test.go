package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// heldRepoHost answers every call as repo-host does for a held repository.
func heldRepoHost(t *testing.T) *repohost.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "5")
		w.Header().Set("X-Smithers-Error-Code", repohost.RepositoryHeldCode)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"code":"repository_held","message":"repository maintenance is finishing; retry in 5s"}`)
	}))
	t.Cleanup(server.Close)
	return repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "test-token")
}

// heldChangeQueries says no change is landed.
type heldChangeQueries struct {
	services.ChangeRevisionQuerier
	services.ChangeRevertQuerier
}

func (heldChangeQueries) GetChangeLandingProvenance(context.Context, db.GetChangeLandingProvenanceParams) (db.GetChangeLandingProvenanceRow, error) {
	return db.GetChangeLandingProvenanceRow{}, pgx.ErrNoRows
}

func (heldChangeQueries) GetLandedChangesetForChange(context.Context, db.GetLandedChangesetForChangeParams) (db.Changeset, error) {
	return db.Changeset{}, pgx.ErrNoRows
}

type heldChangeRecorder struct{}

func (heldChangeRecorder) RecordGeneratedChange(context.Context, int64, repohost.Change, string) error {
	return nil
}

// heldLanding prepares a native append the way LandingService does: any
// repo-host failure but 404 and 409 becomes a generic 500.
type heldLanding struct {
	LandingRouteService
	client *repohost.Client
}

func (s heldLanding) PrepareLandingAppend(ctx context.Context, _ *db.User, owner, repo string, request repohost.AppendPreparationRequest) (services.LandingAppendPreparation, error) {
	if _, err := s.client.PrepareLandAppend(ctx, owner, repo, request); err != nil {
		return services.LandingAppendPreparation{}, errors.Internal("failed to prepare native append")
	}
	return services.LandingAppendPreparation{}, nil
}

// Every product route that calls into a held repository answers 503 with the
// code and Retry-After, whatever its own mapping of the repo-host error: the
// one shared mapper (middleware.DependencyRefusals, fed by the repohost
// client) answers for all of them.
func TestProductRoutesAnswerAHeldRepositoryWith503(t *testing.T) {
	t.Parallel()
	client := heldRepoHost(t)
	jj := &JJVCSHandler{
		RepoHost:          client,
		ChangeService:     jjVCSTestChangeService{client: client},
		RepoResolver:      jjVCSLegacyResolver{},
		WebhookDispatcher: jjVCSNoopDispatcher{},
		ChangeSplitter:    services.NewChangeService(heldChangeQueries{}, client, nil),
		ChangeReverter:    services.NewChangeRevertService(heldChangeQueries{}, client, nil, nil, heldChangeRecorder{}),
	}
	landings := &LandingHandler{Service: heldLanding{client: client}}
	importRefs := func(w http.ResponseWriter, r *http.Request) {
		if err := client.ImportRefs(r.Context(), "alice", "demo"); err != nil {
			writeRouteError(w, r, fmt.Errorf("import refs: %w", err))
		}
	}
	commit := strings.Repeat("a", 40)
	for _, route := range []struct {
		name    string
		handler http.HandlerFunc
		body    string
		params  map[string]string
	}{
		{"bookmark create", jj.CreateBookmark, `{"name":"release","target_change_id":"chg"}`, nil},
		{"split", jj.SplitChange, `{"paths":["a.txt"]}`, map[string]string{"change_id": "chg"}},
		{"revert", jj.RevertChange, ``, map[string]string{"change_id": "chg"}},
		{"land", landings.PrepareLandingAppend, `{"target_bookmark":"main","expected_commit_id":"` + commit + `","source_commit_id":"` + commit + `","source_base_commit_id":"` + commit + `"}`, nil},
		{"import", importRefs, ``, nil},
	} {
		t.Run(route.name, func(t *testing.T) {
			t.Parallel()
			params := map[string]string{"owner": "alice", "repo": "demo"}
			for key, value := range route.params {
				params[key] = value
			}
			req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/x", strings.NewReader(route.body))
			req.Header.Set("Content-Type", "application/json")
			req = withRepoAuth(withJJRouteParams(req, params), 1, "alice")
			rec := httptest.NewRecorder()

			middleware.DependencyRefusals(route.handler).ServeHTTP(rec, req)

			require.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
			assert.Equal(t, "5", rec.Header().Get("Retry-After"))
			var body struct {
				Code  string `json:"code"`
				Fault string `json:"fault"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, "repository_held", body.Code)
			assert.Equal(t, "wait", body.Fault)
		})
	}
}
