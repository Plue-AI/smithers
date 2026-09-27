package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func TestRepositorySetupHTTPPersistsAndReconnectsWithoutRuntimeLaunch(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var userID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('owner','owner') RETURNING id`).Scan(&userID))
	var repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public,default_bookmark) VALUES($1,'repo','repo',true,'main') RETURNING id`, userID).Scan(&repoID))
	queries := db.New(pool)
	user, err := queries.GetUserByID(ctx, userID)
	require.NoError(t, err)
	product := services.NewRepositorySetupService(pool, services.NewRepositoryJobService(queries, nil, pool), nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	var starts atomic.Int32
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		starts.Add(1)
		t.Error("HTTP setup request contacted runtime")
		return nil, nil
	}), Projector: product})
	require.NoError(t, err)
	product.SetFlowDispatcher(dispatcher)
	handler := repositorySetupAPI{repos: services.NewRepoService(queries, nil, ""), setup: product}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Header.Get("X-Fixture-Identity") {
		case "owner":
			r = r.WithContext(context.WithValue(r.Context(), middleware.UserContextKey, &user))
		case "run":
			ctx := context.WithValue(r.Context(), middleware.UserContextKey, &user)
			r = r.WithContext(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &user, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository"}))
		}
		handler.serve(w, r)
	}))
	defer server.Close()
	fixture, err := os.ReadFile("../../../rpc/testdata/repository-setup-backend.json")
	require.NoError(t, err)
	var inputs []json.RawMessage
	require.NoError(t, json.Unmarshal(fixture, &inputs))
	body := inputs[0]
	call := func(method, path string, body []byte, identity bool) (int, []byte) {
		request, err := http.NewRequest(method, server.URL+path, bytes.NewReader(body))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		if identity {
			request.Header.Set("X-Fixture-Identity", "owner")
		}
		response, err := server.Client().Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.Equal(t, "no-store", response.Header.Get("Cache-Control"))
		return response.StatusCode, data
	}
	status, _ := call(http.MethodPost, "/api/repository-setup/inspect", body, false)
	require.Equal(t, http.StatusUnauthorized, status)
	// A trial files its issue as the person who pressed it (D-25): an agent's
	// run credential cannot press it.
	runTrial, err := http.NewRequest(http.MethodPost, server.URL+"/api/repository-setup/trial", bytes.NewReader(body))
	require.NoError(t, err)
	runTrial.Header.Set("Content-Type", "application/json")
	runTrial.Header.Set("X-Fixture-Identity", "run")
	refused, err := server.Client().Do(runTrial)
	require.NoError(t, err)
	_ = refused.Body.Close()
	require.Equal(t, http.StatusForbidden, refused.StatusCode)
	status, data := call(http.MethodPost, "/api/repository-setup/inspect", body, true)
	require.Equal(t, http.StatusAccepted, status, string(data))
	var response services.SetupResponse
	require.NoError(t, json.Unmarshal(data, &response))
	require.Equal(t, "queued", response.Receipt.Phase)
	require.Empty(t, response.Receipt.RunID)
	var wait sync.WaitGroup
	for range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			status, _ := call(http.MethodPost, "/api/repository-setup/inspect", body, true)
			require.Equal(t, http.StatusAccepted, status)
		}()
	}
	wait.Wait()
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&count))
	require.Equal(t, 1, count)
	for _, part := range []string{"request", "observe"} {
		status, data = call(http.MethodGet, "/api/repository-setup/"+part+"?repo=owner/repo&job=chores&requestId=fixture:0", nil, true)
		require.Equal(t, http.StatusAccepted, status, string(data))
	}
	status, data = call(http.MethodGet, "/api/repository-setup/state?repo=owner/repo&job=chores", nil, true)
	require.Equal(t, http.StatusOK, status, string(data))
	var recovered services.SetupRecovery
	require.NoError(t, json.Unmarshal(data, &recovered))
	require.Equal(t, "found", recovered.Setup.State)
	require.Equal(t, "known", recovered.Registration.State)
	require.Equal(t, "queued", recovered.Setup.Result.Receipt.Phase)
	status, data = call(http.MethodPost, "/api/repository-setup/evaluate", body, true)
	require.Equal(t, http.StatusConflict, status, string(data))
	var failure map[string]any
	require.NoError(t, json.Unmarshal(data, &failure))
	require.Equal(t, "setup_request_reused", failure["code"])
	status, _ = call(http.MethodPost, "/api/repository-setup/unknown", body, true)
	require.Equal(t, http.StatusNotFound, status)
	status, _ = call(http.MethodGet, "/api/repository-setup/request?repo=owner/repo&job=ci&requestId=fixture:0", nil, true)
	require.Equal(t, http.StatusNotFound, status)
	require.Zero(t, starts.Load())
}
