package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Production HTTP admission, dispatcher, InstallSource, repohost client and
// packaged model host use a real database. The external model is scripted to
// capture its prompt; the repository HTTP fixture supplies immutable blobs and
// deterministic read failures, not proof of the native engine's filesystem gate.
func TestComposedAppInstructionsReadOnlyActivatedRevision(t *testing.T) {
	var mu sync.Mutex
	reads := []string{}
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		reads = append(reads, r.URL.Path)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "/active-one/"):
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Content: "Always end with DONE.\n```js\nthrow new Error('data-only-canary')\n```"})
		case strings.Contains(r.URL.Path, "/active-two/"):
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Content: "Always end with AGAIN."})
		case strings.Contains(r.URL.Path, "/absent/"):
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"code":"file_not_found"}`)
		case strings.Contains(r.URL.Path, "/oversize/"):
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Content: strings.Repeat("x", 65537)})
		default:
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
		}
	}))
	defer source.Close()
	var session string
	var instructionSource services.InstallSource
	local := startConfiguredLocalChat(t, func(local *localChat, options *chat.RuntimeOptions) {
		q := db.New(local.pool)
		_, err := local.pool.Exec(local.ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
		require.NoError(t, err)
		_, err = local.pool.Exec(local.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, local.repoID, local.ownerID)
		require.NoError(t, err)
		binding := fmt.Sprintf(`{"owner_login":"chatowner","repository_name":"chatrepo","repository_id":%d}`, local.repoID)
		for key, value := range map[string]string{"github.repository": binding, "owner.access": binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`, "setup.source.repository": `"chatowner/chatrepo"`, "setup.step.source": `{"status":"done"}`} {
			require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
		}
		session = "instruction-session"
		hash := sha256.Sum256([]byte(session))
		_, err = q.CreateAuthSession(local.ctx, db.CreateAuthSessionParams{UserID: local.ownerID, Username: "chatowner", SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: source.URL}, "source-fixture")
		instructionSource = services.InstallSource{Pool: local.pool, Repos: services.NewRepoService(q, client, ""), Members: identity.NewMemberBoundary(q)}
		options.Sources = instructionSource
	})
	defer local.stop(t)
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(db.New(local.pool), config.AuthConfig{SessionCookieName: "session"}))
	local.composition.runtime.MountPublic(router)
	router.Get("/api/branches/{b}/files/*", (&routes.BranchFileHandler{Source: instructionSource}).Read)
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.AddCookie(&http.Cookie{Name: "session", Value: session})
		router.ServeHTTP(w, r)
	}))
	defer public.Close()
	// Use this authenticated HTTP door for the existing stream/replay harness.
	modelPublic := local.public
	local.public = public
	prompts := make(chan string, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		if bytes.Contains(raw, []byte("Choose relevant context")) {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"[]\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			return
		}
		prompts <- string(raw)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"chatcmpl-instructions\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-instructions\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	local.public = modelPublic
	local.enroll(t, "TEST_PROVIDER", provider.URL, "private-key")
	local.public = public
	fields := map[string]any{"repositoryId": local.repoID, "model": map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": "TEST_PROVIDER", "baseUrl": provider.URL}}
	ask := func() string {
		t.Helper()
		require.Contains(t, local.turn(t, fields).stream, "answer", local.logs.String())
		select {
		case prompt := <-prompts:
			return prompt
		case <-time.After(10 * time.Second):
			t.Fatal("provider not called")
			return ""
		}
	}
	fileCard := func(want string) {
		t.Helper()
		response, err := local.client.Get(public.URL + "/api/branches/main/files/.smithers/instructions/app.md")
		require.NoError(t, err)
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.Equal(t, 200, response.StatusCode, string(raw))
		require.Contains(t, string(raw), want)
		require.Contains(t, string(raw), `"mode":"read_only"`)
	}
	fileCard("Answer the repository question as Smithers for the prompt author.")
	initial := ask()
	require.Contains(t, initial, "You are Smithers")
	require.Contains(t, initial, "propose a TODO editing .smithers/instructions/app.md through todo.new")
	require.NotContains(t, initial, "DONE")
	revision := func(value string) {
		t.Helper()
		raw, _ := json.Marshal(value)
		require.NoError(t, db.New(local.pool).UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: fmt.Sprintf("agent.instructions.main:%d", local.repoID), Value: raw}))
	}
	revision("active-one")
	fileCard("Always end with DONE.")
	prompt := ask()
	require.Contains(t, prompt, "Always end with DONE.")
	require.Contains(t, prompt, "data-only-canary")
	// No second revision receipt means later turns retain the first one.
	require.Contains(t, ask(), "Always end with DONE.")
	revision("active-two")
	require.Contains(t, ask(), "Always end with AGAIN.")
	revision("absent")
	fileCard("Answer the repository question as Smithers for the prompt author.")
	require.NotContains(t, ask(), "Always end with")
	revision("oversize")
	failed := local.turn(t, fields)
	require.NotContains(t, failed.stream, "answer")
	require.Contains(t, failed.stream, "App instructions exceed the read limit.")
	require.Empty(t, prompts, "invalid instructions refuse before provider dispatch")
	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []string{"/repos/chatowner:chatrepo/file/active-one/.smithers/instructions/app.md", "/repos/chatowner:chatrepo/file/active-two/.smithers/instructions/app.md", "/repos/chatowner:chatrepo/file/absent/.smithers/instructions/app.md", "/repos/chatowner:chatrepo/file/oversize/.smithers/instructions/app.md"}, reads)
}
