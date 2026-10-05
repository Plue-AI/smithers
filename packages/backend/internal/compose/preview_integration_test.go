//go:build smithers_preview

package compose

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/localbootstrap"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestPreviewMachinesRefuseBeforeEffects(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	local, err := localbootstrap.Prepare(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	root := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(root, "index.html"), []byte("<html>preview app</html>"), 0600))
	t.Setenv("SMITHERS_WEB_ROOT", root)
	token, err := seed.OwnerToken(context.Background(), pool, "o")
	require.NoError(t, err)
	var userID, repositoryID int64
	require.NoError(t, pool.QueryRow(context.Background(), "SELECT id FROM users WHERE username='o'").Scan(&userID))
	require.NoError(t, pool.QueryRow(context.Background(), `INSERT INTO repositories(user_id,name,lower_name,description,is_public,default_bookmark,next_issue_number) VALUES($1,'fixture','fixture','',TRUE,'main',1) RETURNING id`, userID).Scan(&repositoryID))
	var pendingWorkspace string
	require.NoError(t, pool.QueryRow(context.Background(), `INSERT INTO workspaces(repository_id,user_id) VALUES($1,$2) RETURNING id`, repositoryID, userID).Scan(&pendingWorkspace))
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	for _, operation := range []string{flowdispatch.OperationLaunch, "install.setup.machine"} {
		_, err = store.Admit(context.Background(), jobs.Admission{Scope: jobs.Scope{TenantID: "preview", PrincipalID: "owner"}, Operation: operation, RequestID: operation, Payload: json.RawMessage(`{}`), AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent})
		require.NoError(t, err)
	}
	handler := startSplitProcess(t, Options{Repository: local.Client(), Workspace: workspace.NewDisabled(), FlowHostRegistry: &flowmanifest.Registry{}})
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, path := range []string{"/", "/api/bootstrap"} {
		response, err := server.Client().Get(server.URL + path)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, 200, response.StatusCode, string(body))
		if path == "/" {
			require.Contains(t, string(body), "preview app")
		} else {
			require.Contains(t, string(body), `"install"`)
			require.NotContains(t, string(body), `"agent"`)
		}
	}
	children := previewChildren(t)
	for _, path := range []string{"/api/repos/o/r/workspaces", "/api/repos/o/r/agent/sessions", "/api/workflow/provision", "/api/workflow/rpc", "/api/todos", "/api/install/setup/machine", "/api/github/import"} {
		request, err := http.NewRequest(http.MethodPost, server.URL+path, nil)
		require.NoError(t, err)
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := server.Client().Do(request)
		require.NoError(t, err)
		var body map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
		response.Body.Close()
		require.Equal(t, 503, response.StatusCode, path)
		require.Equal(t, "machines_disabled", body["code"], path)
		require.Equal(t, map[string]any{"code": "machines_disabled", "fault": "infra", "message": "Machines are off in this preview."}, body, path)
		require.Empty(t, response.Header.Get("Retry-After"))
	}
	require.Equal(t, children, previewChildren(t), "machine request spawned a child")
	time.Sleep(600 * time.Millisecond)
	var attempts int
	require.NoError(t, pool.QueryRow(context.Background(), "SELECT sum(attempt) FROM product_job_dispatches").Scan(&attempts))
	require.Zero(t, attempts, "pending jobs were dispatched")
	var count int
	require.NoError(t, pool.QueryRow(context.Background(), "SELECT count(*) FROM workspaces").Scan(&count))
	require.Equal(t, 1, count, "a refused door created a workspace")
	var status string
	var generation int
	require.NoError(t, pool.QueryRow(context.Background(), "SELECT status,provisioning_generation FROM workspaces WHERE id=$1", pendingWorkspace).Scan(&status, &generation))
	require.Equal(t, "pending", status, "preview reconciled a pending machine")
	require.Zero(t, generation)
	require.NoError(t, pool.QueryRow(context.Background(), "SELECT count(*) FROM repository_job_dispatches").Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pool.QueryRow(context.Background(), "SELECT count(*) FROM product_job_dispatches").Scan(&count))
	require.Equal(t, 2, count)
}

func previewChildren(t *testing.T) string {
	t.Helper()
	output, err := exec.Command("pgrep", "-P", strconv.Itoa(os.Getpid())).Output()
	if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
		return ""
	}
	require.NoError(t, err)
	return string(output)
}

func TestPreviewMountedMachineRouteSweep(t *testing.T) {
	router := openAPIConformanceRouter(testConfigAllFlagsOn())
	server := httptest.NewServer(withMachinesDisabled(router, router))
	defer server.Close()
	count := 0
	require.NoError(t, chi.Walk(router, func(method, pattern string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		covered := false
		for _, gate := range middlewares {
			if reflect.ValueOf(gate).Pointer() == reflect.ValueOf(gateMachines).Pointer() {
				covered = true
			}
		}
		if !covered {
			return nil
		}
		count++
		path := regexp.MustCompile(`\{[^}]+\}`).ReplaceAllString(pattern, "sample")
		path = strings.ReplaceAll(path, "*", "sample")
		request, err := http.NewRequest(method, server.URL+path, nil)
		require.NoError(t, err)
		response, err := server.Client().Do(request)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, 503, response.StatusCode, method+" "+pattern)
		require.Contains(t, string(body), `"code":"machines_disabled"`)
		require.Contains(t, string(body), `"message":"Machines are off in this preview."`)
		return nil
	}))
	require.GreaterOrEqual(t, count, 53)
	t.Logf("refused %d mounted machine routes", count)
}

func TestPreviewChatHasNoHost(t *testing.T) {
	composition, err := newChatComposition(runOptions{Options: Options{Workspace: workspace.NewDisabled()}}, nil, chat.RuntimeOptions{})
	require.NoError(t, err)
	require.Nil(t, composition)
}

func TestPreviewFlowInvocationRefusesBeforeDatabase(t *testing.T) {
	invoked := services.NewInvokedFlowService(nil, nil, nil)
	flow, err := newFlowComposition(runOptions{Options: Options{Workspace: workspace.NewDisabled(), FlowHostRegistry: &flowmanifest.Registry{}}}, nil, nil, nil, nil, nil, nil, nil, nil, invoked)
	require.NoError(t, err)
	require.Nil(t, flow)
	_, _, err = invoked.Invoke(context.Background(), services.InvokedFlowLaunch{}, nil)
	require.EqualError(t, err, "Machines are off in this preview.")
}

// This inventory is independent of route middleware declarations.
func TestPreviewReplayExecutionDoors(t *testing.T) {
	router := openAPIConformanceRouter(testConfigAllFlagsOn())
	server := httptest.NewServer(withMachinesDisabled(router, router))
	defer server.Close()
	for _, suffix := range []string{"workflows/runs/123/rerun", "workflows/runs/123/resume", "actions/runs/123/rerun", "runs/123/rerun", "runs/123/resume"} {
		t.Run(suffix, func(t *testing.T) {
			response, err := server.Client().Post(server.URL+"/api/repos/o/r/"+suffix, "application/json", nil)
			require.NoError(t, err)
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.Equal(t, 503, response.StatusCode, string(body))
			require.Contains(t, string(body), `"code":"machines_disabled"`)
		})
	}
}

func TestPreviewLegacyWorkersFlagRejectedBeforeStartup(t *testing.T) {
	splitProcessDatabase(t)
	t.Setenv("SMITHERS_FEATURE_FLAGS_WORKFLOWS", "true")
	ready := false
	err := StartWithOptions(context.Background(), nil, io.Discard, io.Discard, Options{Workspace: workspace.NewDisabled()}, func(http.Handler) { ready = true })
	require.EqualError(t, err, "legacy workflow triggers are unavailable in single-owner mode; use canonical Flow hosts")
	require.False(t, ready)
}
