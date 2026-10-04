package compose

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/go-chi/cors"
	"github.com/stretchr/testify/require"
)

func TestAppBootstrapReportsAssembledCapabilities(t *testing.T) {
	// Self-host is the same web app as the hosted one: a "cloud" host whose
	// sign-in is the owner's credentials. Nothing here names the desktop shell.
	local := newAppBootstrap(bootstrapFeatures{role: localTopology, identity: true, redirectAuth: true, workspaceRuntime: true, workspace: true, terminal: true})
	require.Equal(t, "cloud", local.Host)
	require.Equal(t, []string{"identity", "cloud", "cloud.terminal"}, local.Capabilities)
	require.NotContains(t, local.Capabilities, "native.shell")
	require.Equal(t, "redirect", local.AuthFlow)
	require.Equal(t, "trusted-only", local.Sandbox.Mode)
	require.NotEmpty(t, local.Sandbox.Platform)

	hosted := newAppBootstrap(bootstrapFeatures{role: hostedAPITopology, identity: true, redirectAuth: true,
		agent: true, modelTurn: true, billingCheckout: true, isolatedSandbox: true})
	require.Equal(t, "cloud", hosted.Host)
	require.Equal(t, []string{"identity", "agent", "model.turn", "billing.checkout"}, hosted.Capabilities)
	require.NotContains(t, hosted.Capabilities, "native.shell")
	require.Equal(t, "redirect", hosted.AuthFlow)
	require.Equal(t, "enforced", hosted.Sandbox.Mode)

	unavailable := newAppBootstrap(bootstrapFeatures{})
	require.Nil(t, unavailable.Sandbox)
	require.Empty(t, unavailable.Capabilities)
	require.Equal(t, "none", unavailable.AuthFlow)
}

func TestAppBootstrapGitHubRequiresConfiguredIntegration(t *testing.T) {
	without := newAppBootstrap(bootstrapFeatures{role: localTopology, identity: true})
	require.NotContains(t, without.Capabilities, "github")
	with := newAppBootstrap(bootstrapFeatures{role: hostedAPITopology, identity: true, github: true})
	require.Contains(t, with.Capabilities, "github")
}

// The selection route is the recommender's handler, so a backend advertises it
// exactly when it serves recommendations; the app binds selection only then.
func TestAppBootstrapCommandSelectionFollowsTheRecommender(t *testing.T) {
	without := newAppBootstrap(bootstrapFeatures{role: hostedAPITopology, identity: true})
	require.NotContains(t, without.Capabilities, "commands.select")
	with := newAppBootstrap(bootstrapFeatures{role: hostedAPITopology, identity: true, recommend: true})
	require.Subset(t, with.Capabilities, []string{"recommend", "commands.select"})
}

func TestAppBootstrapBalanceIsIndependentOfCheckout(t *testing.T) {
	for _, balance := range []bool{false, true} {
		for _, checkout := range []bool{false, true} {
			boot := newAppBootstrap(bootstrapFeatures{role: localTopology, identity: true, billingBalance: balance, billingCheckout: checkout})
			require.Equal(t, balance, slices.Contains(boot.Capabilities, "billing.balance"))
			require.Equal(t, checkout, slices.Contains(boot.Capabilities, "billing.checkout"))
		}
	}
}

func TestBuildIdentityUsesInjectedRevision(t *testing.T) {
	require.Equal(t, "dev", BuildVersion)
	oldVersion := BuildVersion
	old := BuildSHA
	t.Cleanup(func() { BuildVersion = oldVersion; BuildSHA = old })
	BuildVersion = "1.0.0-rc.1"
	BuildSHA = "abcd1234"
	version, sha := buildIdentity()
	require.Equal(t, "1.0.0-rc.1", version)
	require.Equal(t, "abcd1234", sha)
	BuildVersion = "dev"
	BuildSHA = ""
	version, sha = buildIdentity()
	require.Equal(t, "dev", version)
	require.Equal(t, "unknown", sha)
}

func TestAppBootstrapRoute(t *testing.T) {
	oldVersion := BuildVersion
	t.Cleanup(func() { BuildVersion = oldVersion })
	BuildVersion = "1.0.0-rc.1"
	handler := withAppBootstrap(http.NotFoundHandler(), newAppBootstrap(bootstrapFeatures{identity: true}), cors.Options{
		AllowedOrigins: []string{"https://app.example"}, AllowedMethods: []string{"GET", "OPTIONS"},
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil))
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	var body map[string]any
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, float64(1), body["apiVersion"])
	require.Equal(t, "cloud", body["host"])
	require.Equal(t, "1.0.0-rc.1", body["version"])
	require.NotEmpty(t, body["buildSha"])
	require.Equal(t, []any{"identity"}, body["capabilities"])
	response = httptest.NewRecorder()
	preflight := httptest.NewRequest(http.MethodOptions, "/api/bootstrap", nil)
	preflight.Header.Set("Origin", "https://app.example")
	preflight.Header.Set("Access-Control-Request-Method", "GET")
	handler.ServeHTTP(response, preflight)
	require.Equal(t, "https://app.example", response.Header().Get("Access-Control-Allow-Origin"))

	for _, tc := range []struct {
		method string
		want   int
	}{
		{http.MethodHead, http.StatusOK},
		{http.MethodPost, http.StatusMethodNotAllowed},
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, "/api/bootstrap", nil))
		require.Equal(t, tc.want, response.Code)
		if tc.method == http.MethodHead {
			require.Empty(t, response.Body.String())
		}
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/unknown", nil))
	require.Equal(t, http.StatusNotFound, response.Code)
}

func TestAppBootstrapBillingDoorsAreIndependent(t *testing.T) {
	for _, overview := range []bool{false, true} {
		for _, plans := range []bool{false, true} {
			for _, checkout := range []bool{false, true} {
				for _, portal := range []bool{false, true} {
					boot := newAppBootstrap(bootstrapFeatures{identity: true, billingOverview: overview, billingPlans: plans, billingCheckout: checkout, billingPortal: portal})
					require.Equal(t, overview, slices.Contains(boot.Capabilities, "billing.overview"))
					require.Equal(t, plans, slices.Contains(boot.Capabilities, "billing.plans"))
					require.Equal(t, checkout, slices.Contains(boot.Capabilities, "billing.checkout"))
					require.Equal(t, portal, slices.Contains(boot.Capabilities, "billing.portal"))
				}
			}
		}
	}
}

func TestAppBootstrapInstallOnlyWhenRoutesAreMounted(t *testing.T) {
	for _, role := range []topology{localTopology, hostedAPITopology} {
		for _, mounted := range []bool{false, true} {
			document := bootstrapHTTPDocument(t, bootstrapFeatures{role: role, install: mounted})
			capabilities := document["capabilities"].([]any)
			require.Equal(t, mounted && !role.hosted(), slices.Contains(capabilities, any("install")))
			require.Equal(t, "cloud", document["host"])
		}
	}
}
