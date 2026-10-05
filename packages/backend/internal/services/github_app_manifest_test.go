package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestGitHubAppManifestExactPermissionsAndLocalhostCallbacks(t *testing.T) {
	// Literal permission and full callback fixtures from spec §12.1.2 and C-GH-01.
	origins := []string{"http://mini.local:4000", "https://smithers.example"}
	manifest, action, err := BuildGitHubAppManifest("acme", "org", origins, "single-use-state")
	require.NoError(t, err)
	require.Equal(t, "https://github.com/organizations/acme/settings/apps/new", strings.Split(action, "?")[0])
	encoded, err := json.Marshal(manifest)
	require.NoError(t, err)
	var actual map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &actual))
	golden, err := os.ReadFile("testdata/github_app_manifest_permissions.golden.json")
	require.NoError(t, err)
	require.JSONEq(t, string(golden), string(actual["default_permissions"]))
	var hook struct {
		Active bool `json:"active"`
	}
	require.NoError(t, json.Unmarshal(actual["hook_attributes"], &hook))
	require.False(t, hook.Active)
	var callbacks []string
	require.NoError(t, json.Unmarshal(actual["callback_urls"], &callbacks))
	require.ElementsMatch(t, []string{"http://mini.local:4000/api/auth/github/callback", "https://smithers.example/api/auth/github/callback", "http://localhost:4000/api/auth/github/callback"}, callbacks)
	var redirect, setup, name string
	require.NoError(t, json.Unmarshal(actual["redirect_url"], &redirect))
	require.NoError(t, json.Unmarshal(actual["setup_url"], &setup))
	require.Equal(t, "http://localhost:4000/setup/github/callback", redirect)
	require.Equal(t, "http://localhost:4000/setup/github/installed", setup)
	require.NoError(t, json.Unmarshal(actual["name"], &name))
	require.NotEmpty(t, name)
	require.LessOrEqual(t, len(name), 34)
}

func TestGitHubAppManifestBrowserStateBinding(t *testing.T) {
	valid := strings.Repeat("a", 64)
	require.NoError(t, validateGitHubAppBrowserState(valid, valid))
	for _, pair := range [][2]string{{"", ""}, {valid, ""}, {"", valid}, {valid, strings.Repeat("b", 64)}, {valid + "a", valid + "a"}, {valid[:63], valid[:63]}} {
		require.Error(t, validateGitHubAppBrowserState(pair[0], pair[1]))
	}
}

func TestGitHubAppManifestCallbackOriginLimits(t *testing.T) {
	origins := make([]string, 9)
	for i := range origins {
		origins[i] = fmt.Sprintf("https://host%d.example", i)
	}
	manifest, _, err := BuildGitHubAppManifest("acme", "org", origins, "state")
	require.NoError(t, err)
	require.Len(t, manifest.CallbackURLs, 10)
	origins = append(origins, "https://one-too-many.example")
	_, _, err = BuildGitHubAppManifest("acme", "org", origins, "state")
	require.Error(t, err)
	for _, origin := range []string{"https://owner:secret@host.example", "https://host.example/?query=x", "https://host.example/#anchor", "https://%", "http://"} {
		_, _, err = BuildGitHubAppManifest("acme", "org", []string{origin}, "state")
		require.Error(t, err)
	}
}

func TestGitHubAppManifestOwnerRoutingAndNameLimit(t *testing.T) {
	for _, tc := range []struct{ kind, owner, action string }{
		{"user", "ada", "https://github.com/settings/apps/new"},
		{"org", "a-very-long-organization-name-123456789", "https://github.com/organizations/a-very-long-organization-name-123456789/settings/apps/new"},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			manifest, action, err := BuildGitHubAppManifest(tc.owner, tc.kind, []string{"http://localhost:4000", "http://localhost:4000"}, "state")
			require.NoError(t, err)
			require.Equal(t, tc.action, strings.Split(action, "?")[0])
			data, err := json.Marshal(manifest)
			require.NoError(t, err)
			var actual struct {
				Name         string   `json:"name"`
				CallbackURLs []string `json:"callback_urls"`
			}
			require.NoError(t, json.Unmarshal(data, &actual))
			require.LessOrEqual(t, len(actual.Name), 34)
			require.Equal(t, []string{"http://localhost:4000/api/auth/github/callback"}, actual.CallbackURLs)
		})
	}
}

func TestGitHubAppManifestRefusesInvalidOwnerAndOrigin(t *testing.T) {
	for _, tc := range []struct {
		owner, kind string
		origins     []string
	}{
		{"", "user", nil}, {"../evil", "org", nil}, {"acme", "unknown", nil},
		{"acme", "org", []string{"javascript:alert(1)"}}, {"acme", "org", []string{"http://mini.local:4000/path"}},
	} {
		_, _, err := BuildGitHubAppManifest(tc.owner, tc.kind, tc.origins, "state")
		require.Error(t, err)
	}
}

func TestGitHubAppManifestDefaultConfigurationAndUnavailableService(t *testing.T) {
	origins := []string{"http://mini.local:4000"}
	service := NewGitHubAppManifestService(nil, nil, "", func() []string { return origins })
	require.Equal(t, "https://api.github.com", service.apiBaseURL)
	require.Equal(t, []string{"http://mini.local:4000"}, service.knownOrigins())
	// The callback list follows the saved Address: a changed origin is read on the next App creation.
	origins = []string{"https://changed.example"}
	require.Equal(t, []string{"https://changed.example"}, service.knownOrigins())
	require.Nil(t, NewGitHubAppManifestService(nil, nil, "", nil).knownOrigins())
	require.Equal(t, 30*time.Second, service.client.Timeout)
	state := strings.Repeat("a", 64)
	for _, s := range []*GitHubAppManifestService{nil, service} {
		_, err := s.Begin(context.Background(), GitHubAppManifestRequest{})
		require.Error(t, err)
		_, err = s.Convert(context.Background(), "code", state, state)
		require.Error(t, err)
		require.Error(t, s.ResumeInstallation(context.Background()))
		_, err = s.Convert(context.Background(), "code", state, strings.Repeat("b", 64))
		require.Error(t, err)
		for _, code := range []string{"", " ", strings.Repeat("x", 513)} {
			_, err = s.Convert(context.Background(), code, state, state)
			require.Error(t, err)
		}
	}
}
