package services

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBoundSecretDestinationObservation(t *testing.T) {
	sentinels := map[string]string{"ALL": "all-sentinel", "MAIN": "main-sentinel", "BOUND": "bound-sentinel", "PROVIDER": "provider-sentinel", "PEM": "pem-sentinel"}
	good := "GET /workspace-id HTTP/1.1\r\nHost: csec01-bound.example\r\nAuthorization: Bearer bound-sentinel\r\n\r\n"
	cases := []struct {
		name, request, workspace string
		allowed                  bool
	}{
		{"substituted at destination", good, "workspace-id", true},
		{"missing observation", "", "workspace-id", false},
		{"malformed observation", "not HTTP", "workspace-id", false},
		{"placeholder reached destination", strings.ReplaceAll(good, "bound-sentinel", "placeholder"), "workspace-id", false},
		{"no authorization", strings.ReplaceAll(good, "Authorization: Bearer bound-sentinel\r\n", ""), "workspace-id", false},
		{"duplicate authorization", strings.ReplaceAll(good, "Authorization:", "Authorization: Bearer bound-sentinel\r\nAuthorization:"), "workspace-id", false},
		{"wrong destination", strings.ReplaceAll(good, "csec01-bound.example", "elsewhere.example"), "workspace-id", false},
		{"wrong workspace", good, "other-workspace", false},
		{"missing workspace", good, "", false},
		{"wrong method", strings.ReplaceAll(good, "GET", "POST"), "workspace-id", false},
		{"unbound query", strings.ReplaceAll(good, "/workspace-id", "/workspace-id?other=1"), "workspace-id", false},
	}
	for _, label := range []string{"ALL", "MAIN", "PROVIDER", "PEM"} {
		cases = append(cases, struct {
			name, request, workspace string
			allowed                  bool
		}{"leaked " + label, strings.ReplaceAll(good, "Host:", "X-Leak: "+sentinels[label]+"\r\nHost:"), "workspace-id", false})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateBoundSecretRequest([]byte(tc.request), tc.workspace, sentinels)
			if tc.allowed {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			for _, sentinel := range sentinels {
				require.NotContains(t, err.Error(), sentinel)
			}
		})
	}
	for _, label := range []string{"ALL", "MAIN", "BOUND", "PROVIDER", "PEM"} {
		t.Run("missing fixture "+label, func(t *testing.T) {
			incomplete := make(map[string]string)
			for key, value := range sentinels {
				incomplete[key] = value
			}
			delete(incomplete, label)
			require.Error(t, validateBoundSecretRequest([]byte(good), "workspace-id", incomplete))
		})
	}
}
