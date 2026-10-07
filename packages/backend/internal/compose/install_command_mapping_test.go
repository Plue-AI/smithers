package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Route enumeration measures binding coverage, never expected policy results.
func TestInstallCredentialAdministrationRouteBindings(t *testing.T) {
	for _, route := range servedCompositionRoutes(t, config.AuthModeSelfHosted) {
		if strings.HasPrefix(route.path, "/api/user/provider-connections") || route.path == "/api/repo-connection" || route.path == "/api/install/quiesce" || route.path == "/api/install/metrics" || route.path == "/api/model/default" || route.path == "/api/terminals" {
			path := strings.NewReplacer("{id}", "1", "{grantID}", "2").Replace(route.path)
			command := middleware.InstallMemberCommand(strings.ToUpper(route.method), path)
			require.NotEmpty(t, command, route.key())
			_, exists := services.OperationPolicy(command)
			require.True(t, exists, "%s: %s", route.key(), command)
		}
	}
}

func TestInstallCredentialAdministrationCatalogRefusalsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Install.QuiesceEnabled = true
	cfg.Install.StateDir = t.TempDir()
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := hostStatusProductionRouter(cfg, f.q, &services.InstallCapacityService{}, conformanceServices{pool: f.pool})
	delegated := f.token(f.owner, "admin-delegated", "write:repository,read:user,via:codex", true)
	run := f.token(f.owner, "admin-run", "write:repository,read:user", true)
	for _, door := range []struct{ method, path, command string }{
		{"POST", "/api/user/provider-connections", "secrets.connect"},
		{"GET", "/api/user/provider-connections", "secrets.connections"},
		{"PUT", "/api/user/provider-connections/order", "secrets.move"},
		{"DELETE", "/api/user/provider-connections/1", "secrets.revoke"},
		{"POST", "/api/user/provider-connections/1/grants", "secrets.scope"},
		{"PUT", "/api/model/default", "agent.model"},
		{"POST", "/api/repo-connection", "github.app"},
		{"PUT", "/api/install", "settings"},
		{"POST", "/api/install/quiesce", "settings"},
	} {
		for _, cell := range []struct{ name, credential, code string }{{"delegated", delegated, "never"}, {"run", run, "permission"}} {
			t.Run(door.command+"/"+cell.name, func(t *testing.T) {
				req := httptest.NewRequest(door.method, "http://example.com"+door.path, strings.NewReader(`{}`))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", "http://example.com")
				req.Header.Set("Authorization", "Bearer "+cell.credential)
				req.Header.Set("Smithers-Actor", "person")
				req.Header.Set("Smithers-Via", "smithers")
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, 403, out.Code, out.Body.String())
				require.Contains(t, out.Body.String(), `"code":"`+cell.code+`"`)
				require.Equal(t, []string{door.command}, decisions)
			})
		}
	}
	// SG-04's literal RO terminal cell evaluates the actual personal terminal
	// command, with no terminal or workspace admission after refusal.
	req := httptest.NewRequest(http.MethodPost, "http://example.com/api/terminals", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+run)
	var decisions []string
	req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
	out := httptest.NewRecorder()
	router.ServeHTTP(out, req)
	require.Equal(t, 403, out.Code, out.Body.String())
	require.Contains(t, out.Body.String(), `"code":"permission"`)
	require.Equal(t, []string{"box.terminal"}, decisions)
}
