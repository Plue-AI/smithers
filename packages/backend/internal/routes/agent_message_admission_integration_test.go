//go:build integration
// +build integration

package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

const agentAdmissionChild = "SMITHERS_AGENT_ADMISSION_CHILD"

// The HTTP server process exits after 201, before any worker begins execution.
// A separate parent process must still be able to claim the accepted request.
func TestAgentMessageHTTPAdmissionSurvivesProcessExit(t *testing.T) {
	if os.Getenv(agentAdmissionChild) == "1" {
		runAgentAdmissionChild(t)
		return
	}

	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	queries := db.New(pool)
	user := routesIntegrationCreateUser(t, pool, "agent_admission")
	repo := routesIntegrationCreateRepo(t, pool, user, "agent_admission_repo", false)
	session := routesIntegrationCreateAgentSession(t, queries, repo, user)
	auth := services.NewAuthService(queries, config.AuthConfig{}, nil, nil)
	pat, err := auth.CreateToken(context.Background(), user.ID, services.CreateTokenRequest{
		Name:   "agent-admission-process-exit",
		Scopes: []string{string(middleware.ScopeWriteRepository)},
	})
	require.NoError(t, err)

	executable, err := os.Executable()
	require.NoError(t, err)
	cmd := exec.Command(executable, "-test.run=^TestAgentMessageHTTPAdmissionSurvivesProcessExit$", "-test.v")
	cmd.Env = append(os.Environ(),
		agentAdmissionChild+"=1",
		"SMITHERS_AGENT_ADMISSION_DATABASE="+databaseURL,
		"SMITHERS_AGENT_ADMISSION_SESSION="+session.ID,
		"SMITHERS_AGENT_ADMISSION_PAT="+pat.Token,
		"SMITHERS_AGENT_ADMISSION_OWNER="+repo.Owner,
		"SMITHERS_AGENT_ADMISSION_NAME="+repo.Name,
	)
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, "HTTP child failed:\n%s", output)
	require.NotContains(t, string(output), "--- PASS: TestAgentMessageHTTPAdmissionSurvivesProcessExit", "child must exit without test cleanup")
	const marker = "AGENT_MESSAGE_ID="
	index := strings.Index(string(output), marker)
	require.GreaterOrEqual(t, index, 0, "child did not report accepted message:\n%s", output)
	line := strings.SplitN(string(output[index+len(marker):]), "\n", 2)[0]
	messageID, err := strconv.ParseInt(strings.TrimSpace(line), 10, 64)
	require.NoError(t, err)
	require.Positive(t, messageID)

	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	claim, err := store.ClaimForOperations(context.Background(), "replacement-worker", time.Minute, []string{"agent-run-dispatch"})
	require.NoError(t, err, "201 must leave a claimable dispatch after HTTP process exit")
	require.Equal(t, "agent-run-dispatch", claim.Operation)
	require.Equal(t, "agent-message:"+strconv.FormatInt(messageID, 10), claim.RequestID)
	require.Equal(t, jobs.EffectUnsafe, claim.EffectPolicy)

	var input services.DispatchAgentRunInput
	require.NoError(t, json.Unmarshal(claim.Payload, &input))
	require.Equal(t, session.ID, input.SessionID)
	require.Equal(t, repo.ID, input.RepositoryID)
	require.Equal(t, user.ID, input.UserID)
	require.Equal(t, messageID, input.TriggerMessageID)
	require.Equal(t, repo.Owner, input.RepoOwner)
	require.Equal(t, repo.Name, input.RepoName)
	require.Equal(t, "codex", input.AgentProvider)
	require.Equal(t, "http", input.AgentTransport)
	require.Equal(t, []string{"src/**"}, input.AllowedPaths)
}

func runAgentAdmissionChild(t *testing.T) {
	ctx := context.Background()
	pool, err := postgresfixture.Open(ctx, os.Getenv("SMITHERS_AGENT_ADMISSION_DATABASE"), 0)
	require.NoError(t, err)
	sessionID := os.Getenv("SMITHERS_AGENT_ADMISSION_SESSION")
	owner := os.Getenv("SMITHERS_AGENT_ADMISSION_OWNER")
	name := os.Getenv("SMITHERS_AGENT_ADMISSION_NAME")

	queries := db.New(pool)
	handler := &AgentSessionHandler{Service: services.NewAgentServiceWithPool(queries, pool, services.WithAgentDispatchQuerier(queries))}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.LoadRepoContext(queries))
		r.With(
			middleware.RequireAuth,
			middleware.RequireScope(middleware.ScopeWriteRepository),
			middleware.RequireRepoPermission(middleware.PermissionWrite),
		).Post("/agent/sessions/{id}/messages", handler.PostMessage)
	})
	server := httptest.NewServer(router)

	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/repos/"+owner+"/"+name+"/agent/sessions/"+sessionID+"/messages", strings.NewReader(`{
		"role":"user",
		"parts":[{"type":"text","content":"resume after exit"}],
		"agent_provider":"codex",
		"agent_transport":"http",
		"allowed_paths":["src/**"]
	}`))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+os.Getenv("SMITHERS_AGENT_ADMISSION_PAT"))
	response, err := server.Client().Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusCreated, response.StatusCode)
	var message services.AgentMessageResponse
	require.NoError(t, json.NewDecoder(response.Body).Decode(&message))
	require.Positive(t, message.ID)
	fmt.Printf("AGENT_MESSAGE_ID=%d\n", message.ID)
	os.Exit(0)
}
