package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

// The reviewed candidate is historical fixture input authored on GitHub's
// side, as in TestDelegatedMergeSettlementNativeInstall. Publication, member
// reads and the browser's private Merge door use the installed composition.
// This does not qualify the coding machine's file-mutation provider.
func TestConversationReadyInstallBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_CONVERSATION_READY_BROWSER") != "1" {
		t.Skip("set SMITHERS_CONVERSATION_READY_BROWSER=1; build apps/app first")
	}
	_, source, _, _ := runtime.Caller(0)
	app := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../apps/app"))
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", filepath.Join(app, "dist"))
	require.FileExists(t, filepath.Join(app, "dist/index.html"))
	r := newRehearsal(t, "SMITHERS_CONVERSATION_READY_BROWSER", "C-UI-04", "ready-")
	require.True(t, r.install("Install ready"))
	alice, err := r.member("alice", 81, "write")
	require.NoError(t, err)
	seedConversationFailure(t, r, "rehearsal-owner", "Retained failure")
	n := seedConversationFailure(t, r, "rehearsal-owner", "Reviewed greeting")
	head, base, err := r.pushMemberBranch("smithers/timeline-ready", "Reviewed greeting", map[string]string{"ready.md": "Hello\n"})
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(r.pool, codec)
	connections := services.NewRepoConnectionService(r.pool, credentials)
	access, err := connections.CreateGitHubInstallationToken(r.ctx, r.installationID, services.GitHubTokenScope{AllRepositories: true, Permissions: map[string]string{"pull_requests": "write"}})
	require.NoError(t, err)
	request, err := http.NewRequestWithContext(r.ctx, "POST", r.fake.URL+"/repos/rehearsal-owner/app/pulls", strings.NewReader(`{"title":"Reviewed greeting","head":"smithers/timeline-ready","base":"main"}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+access.Token)
	response, err := r.fake.Client().Do(request)
	require.NoError(t, err)
	var pull struct {
		Number  int64
		HTMLURL string `json:"html_url"`
	}
	require.Equal(t, 201, response.StatusCode)
	require.NoError(t, json.NewDecoder(response.Body).Decode(&pull))
	require.NoError(t, response.Body.Close())
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET state='proposed',attempt=1,candidate_base=$2,candidate_head=$3,candidate_verified=true,pr_number=$4,pr_url=$5,pr_state='open',pr_head=$3 WHERE number=$1`, n, base, head, pull.Number, pull.HTMLURL)
	require.NoError(t, err)
	// Move puts the reviewed TODO first and publishes committed subject facts.
	_, err = r.expectAs(r.jar, "POST", fmt.Sprintf("/api/todos/%d", n), `{"op":"move","direction":"up"}`, 202)
	require.NoError(t, err)
	runConversationTimelineBrowser(t, r, alice, map[string]int64{"ready": n}, "historical reviewed TODO")
	for _, write := range r.fake.Writes() {
		require.False(t, write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge"), "opening Merge must never merge the PR")
	}
}
