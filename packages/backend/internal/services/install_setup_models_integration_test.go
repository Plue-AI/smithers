package services

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// modelTestRecorder stands in for the private model host behind POST
// /api/model/test: it records each request and answers by the record's role.
type modelTestRecorder struct {
	mu       sync.Mutex
	requests map[string]json.RawMessage
	answers  map[string]string
	err      error
}

func (r *modelTestRecorder) RunModelTest(_ context.Context, owner int64, request json.RawMessage) (json.RawMessage, error) {
	var body struct {
		Model struct {
			ID string `json:"id"`
		} `json:"model"`
	}
	if owner <= 0 || json.Unmarshal(request, &body) != nil {
		return nil, errors.New("unexpected model test request")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests[body.Model.ID] = request
	if r.err != nil {
		return nil, r.err
	}
	if answer, ok := r.answers[body.Model.ID]; ok {
		return json.RawMessage(answer), nil
	}
	return json.RawMessage(`{"ok":true,"latencyMs":4,"sample":"ok","output":{"kind":"generation","text":"ok"}}`), nil
}

func (r *modelTestRecorder) roles() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	roles := make([]string, 0, len(r.requests))
	for role := range r.requests {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	return roles
}

// modelAccessFixture is an install whose repository step is done, with an
// owner, an OpenAI coding model and the named saved keys.
func modelAccessFixture(t *testing.T, keys ...string) (*InstallSetupService, int64) {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	owner, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "model-owner", LowerUsername: "model-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO owner_model_defaults(user_id,model) VALUES($1,'{"protocol":"openai-responses","modelId":"gpt-5.1","credential":"OPENAI_API_KEY"}')`, owner.ID)
	require.NoError(t, err)
	for _, name := range keys {
		_, err = pool.Exec(ctx, `INSERT INTO owner_model_credentials(user_id,name,value_encrypted,origin) VALUES($1,$2,'sealed-'||$2,'')`, owner.ID, name)
		require.NoError(t, err)
	}
	service := &InstallSetupService{Pool: pool, Jobs: store}
	require.NoError(t, service.Initialize(ctx))
	repository, err := json.Marshal(InstallStep{ID: "repository", Status: InstallReady})
	require.NoError(t, err)
	require.NoError(t, db.New(pool).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.step.repository", Value: repository}))
	return service, owner.ID
}

// runModelAccess admits Model access and works it through the jobs worker
// until the step leaves running.
func runModelAccess(t *testing.T, service *InstallSetupService, key string) InstallStep {
	t.Helper()
	ctx := t.Context()
	_, err := service.Admit(ctx, "models", key, json.RawMessage(`{}`))
	require.NoError(t, err)
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- service.Jobs.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "models-" + key, Capacity: 1, Lease: time.Minute, PollInterval: time.Millisecond, Operations: []string{"install.setup.models"}}, service.Handle)
	}()
	var step InstallStep
	require.Eventually(t, func() bool {
		step, err = service.readStep(ctx, db.New(service.Pool), "models")
		return err == nil && step.Status != InstallRunning
	}, 10*time.Second, 10*time.Millisecond)
	cancel()
	require.NoError(t, <-done)
	return step
}

func modelRoles(t *testing.T, service *InstallSetupService) []map[string]string {
	t.Helper()
	status, err := service.Status(t.Context())
	require.NoError(t, err)
	return status["models"].([]map[string]string)
}

func agentSetting(t *testing.T, service *InstallSetupService, role string) string {
	t.Helper()
	row, err := db.New(service.Pool).GetInstallSetting(t.Context(), "agent:"+role)
	require.NoError(t, err)
	return string(row.Value)
}

func TestInstallModelAccessTestsEachKeyBeforeDonePostgres(t *testing.T) {
	service, _ := modelAccessFixture(t, "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY")
	tests := &modelTestRecorder{requests: map[string]json.RawMessage{}, answers: map[string]string{
		// OpenAI's 429 for a key with no credits (credit_balance_exhausted).
		"coding": `{"ok":false,"latencyMs":0,"failure":{"code":"refused","status":429},"fault":"wait"}`,
	}}
	service.Models = tests

	step := runModelAccess(t, service, "models-1")
	require.Equal(t, InstallFailed, step.Status)
	require.Equal(t, "model_key_refused", step.Error.Code)
	require.Equal(t, "user", step.Error.Class)
	require.Equal(t, "OpenAI key: Out of credits or rate limited", step.Error.Message)
	require.Equal(t, []string{"coding", "fast", "jev"}, tests.roles())
	require.JSONEq(t, `{"model":{"id":"coding","protocol":"openai-responses","modelId":"gpt-5.1","credential":"OPENAI_API_KEY"}}`, string(tests.requests["coding"]))
	require.JSONEq(t, `{"model":{"id":"fast","protocol":"openai-chat","modelId":"gpt-oss-120b","credential":"CEREBRAS_API_KEY","baseUrl":"https://api.cerebras.ai"}}`, string(tests.requests["fast"]))
	require.JSONEq(t, `{"model":{"id":"jev","protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}}`, string(tests.requests["jev"]))
	var written int
	require.NoError(t, service.Pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key LIKE 'agent:%'`).Scan(&written))
	require.Zero(t, written, "a refused key writes no model role")
	require.Equal(t, []map[string]string{
		{"role": "fast", "provider": "Cerebras", "key": "saved"},
		{"role": "coding", "provider": "OpenAI", "key": "failed", "error": "Out of credits or rate limited"},
		{"role": "jev", "provider": "AI Gateway", "key": "saved"},
	}, modelRoles(t, service))

	// A new value for the refused key reads saved until it is tested.
	_, err := service.Pool.Exec(t.Context(), `UPDATE owner_model_credentials SET value_encrypted='sealed-replacement' WHERE name='OPENAI_API_KEY'`)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"role": "coding", "provider": "OpenAI", "key": "saved"}, modelRoles(t, service)[1])

	tests.mu.Lock()
	tests.answers = map[string]string{}
	tests.requests = map[string]json.RawMessage{}
	tests.mu.Unlock()
	step = runModelAccess(t, service, "models-2")
	require.Equal(t, InstallReady, step.Status)
	require.Nil(t, step.Error)
	require.Equal(t, []string{"coding", "fast", "jev"}, tests.roles())
	require.JSONEq(t, `{"protocol":"openai-chat","modelId":"gpt-oss-120b","credential":"CEREBRAS_API_KEY","baseUrl":"https://api.cerebras.ai"}`, agentSetting(t, service, "fast"))
	require.JSONEq(t, `{"protocol":"openai-responses","modelId":"gpt-5.1","credential":"OPENAI_API_KEY"}`, agentSetting(t, service, "coding"))
	require.JSONEq(t, `{"protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}`, agentSetting(t, service, "jev"))
	require.Equal(t, []map[string]string{
		{"role": "fast", "provider": "Cerebras", "key": "saved"},
		{"role": "coding", "provider": "OpenAI", "key": "saved"},
		{"role": "jev", "provider": "AI Gateway", "key": "saved"},
	}, modelRoles(t, service))
}

func TestInstallModelAccessNamesEveryRefusedKeyPostgres(t *testing.T) {
	service, _ := modelAccessFixture(t, "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY")
	service.Models = &modelTestRecorder{requests: map[string]json.RawMessage{}, answers: map[string]string{
		"fast": `{"ok":false,"latencyMs":0,"failure":{"code":"refused","status":401},"fault":"user"}`,
		"jev":  `{"ok":false,"latencyMs":0,"failure":{"code":"timeout","deadlineMs":15000},"fault":"dependency"}`,
	}}
	step := runModelAccess(t, service, "models-both")
	require.Equal(t, InstallFailed, step.Status)
	require.Equal(t, "AI Gateway key: No answer in time; Cerebras key: Key rejected", step.Error.Message)
	roles := modelRoles(t, service)
	require.Equal(t, map[string]string{"role": "fast", "provider": "Cerebras", "key": "failed", "error": "Key rejected"}, roles[0])
	require.Equal(t, map[string]string{"role": "jev", "provider": "AI Gateway", "key": "failed", "error": "No answer in time"}, roles[2])
}

func TestInstallModelAccessWithoutFastKeyTestsCodingAndGatewayPostgres(t *testing.T) {
	service, _ := modelAccessFixture(t, "OPENAI_API_KEY", "AI_GATEWAY_API_KEY")
	tests := &modelTestRecorder{requests: map[string]json.RawMessage{}}
	service.Models = tests
	step := runModelAccess(t, service, "models-no-fast")
	require.Equal(t, InstallReady, step.Status)
	require.Equal(t, []string{"coding", "jev"}, tests.roles())
	// Without a fast key the app agent uses the coding model (mvp.md §6.5).
	require.JSONEq(t, `{"protocol":"openai-responses","modelId":"gpt-5.1","credential":"OPENAI_API_KEY"}`, agentSetting(t, service, "fast"))
}

func TestInstallModelAccessRefusesUntestedKeysPostgres(t *testing.T) {
	for _, tc := range []struct {
		name    string
		models  InstallModelTester
		code    string
		message string
	}{
		{"no model host", nil, "model_host_unavailable", "Model host unavailable"},
		{"host failure", &modelTestRecorder{requests: map[string]json.RawMessage{}, err: errors.New("launch owner model host: refused")}, "model_key_refused", "OpenAI key: Could not test the key; AI Gateway key: Could not test the key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, _ := modelAccessFixture(t, "OPENAI_API_KEY", "AI_GATEWAY_API_KEY")
			service.Models = tc.models
			step := runModelAccess(t, service, "models-untested")
			require.Equal(t, InstallFailed, step.Status)
			require.Equal(t, tc.code, step.Error.Code)
			require.Equal(t, tc.message, step.Error.Message)
			var written int
			require.NoError(t, service.Pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key LIKE 'agent:%'`).Scan(&written))
			require.Zero(t, written)
		})
	}
}

func TestInstallModelAccessRequiresCodingAndGatewayKeysPostgres(t *testing.T) {
	service, _ := modelAccessFixture(t, "OPENAI_API_KEY")
	tests := &modelTestRecorder{requests: map[string]json.RawMessage{}}
	service.Models = tests
	step := runModelAccess(t, service, "models-missing")
	require.Equal(t, InstallFailed, step.Status)
	require.Equal(t, "model_key_missing", step.Error.Code)
	require.Empty(t, tests.roles(), "a missing key is refused before any provider call")
}
