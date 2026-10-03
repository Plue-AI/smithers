package config

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestGitHubCallbackConfiguration(t *testing.T) {
	for _, tc := range []struct {
		url   string
		valid bool
	}{
		{"https://app.example/api/auth/github/callback", true},
		{"http://127.0.0.1:4000/api/auth/github/callback", true},
		{"", false}, {"/api/auth/github/callback", false},
		{"https://secret@app.example/api/auth/github/callback", false},
		{"https://app.example/wrong-path", false},
		{"https://app.example/api/auth/github/callback?return_to=elsewhere", false},
		{"https://app.example/api/auth/github/callback#fragment", false},
	} {
		t.Run(tc.url, func(t *testing.T) {
			cfg := Config{Auth: AuthConfig{GitHubRedirectURL: tc.url}}
			var failures []string
			validateOptionalProviders(&cfg, &failures)
			if tc.valid {
				require.Empty(t, failures)
			} else {
				require.Contains(t, failures, "auth.github_redirect_url must name the browser origin's /api/auth/github/callback endpoint")
			}
		})
	}
}
