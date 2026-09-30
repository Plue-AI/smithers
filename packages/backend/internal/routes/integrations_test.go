package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIntegrationsHandler_GetMCPIntegrations(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler(IntegrationCatalog(IntegrationCapabilities{GitHubMirror: true})...)
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/mcp", nil)
	rec := httptest.NewRecorder()
	h.GetMCPIntegrations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var items []IntegrationCatalogItem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))
	require.Len(t, items, 1)

	// Verify github-sync is present
	var found bool
	for _, item := range items {
		if item.ID == "github-sync" {
			found = true
			assert.Equal(t, "GitHub", item.Name)
			assert.Equal(t, "sync-service", item.Kind)
			assert.True(t, item.Installed)
			assert.Equal(t, "Configured", item.Status)
			break
		}
	}
	assert.True(t, found, "expected github-sync integration in response")
}

func TestIntegrationsHandler_GetMCPIntegrations_UnconfiguredIsEmpty(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/mcp", nil)
	rec := httptest.NewRecorder()
	h.GetMCPIntegrations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var items []IntegrationCatalogItem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))

	assert.Empty(t, items)
}

func TestIntegrationsHandler_GetSkills(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/skills", nil)
	rec := httptest.NewRecorder()
	h.GetSkills(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var skills []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &skills))
	assert.Empty(t, skills)
}

func TestIntegrationsHandler_GetSkills_ReturnsEmptyCatalog(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/skills", nil)
	rec := httptest.NewRecorder()
	h.GetSkills(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var skills []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &skills))
	assert.Empty(t, skills)
}

func TestIntegrationsHandler_GetMCPIntegrations_AllHaveRequiredFields(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler(IntegrationCatalog(IntegrationCapabilities{GitHubMirror: true})...)
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/mcp", nil)
	rec := httptest.NewRecorder()
	h.GetMCPIntegrations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var items []IntegrationCatalogItem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))

	for _, item := range items {
		assert.NotEmpty(t, item.ID, "each integration must have an ID")
		assert.NotEmpty(t, item.Name, "each integration must have a name")
		assert.NotEmpty(t, item.Kind, "each integration must have a kind")
		assert.NotEmpty(t, item.Capabilities, "each integration must have capabilities")
	}
}

func TestIntegrationCatalog_AdvertisesOnlyConfiguredRealServices(t *testing.T) {
	t.Parallel()

	assert.Empty(t, IntegrationCatalog(IntegrationCapabilities{}))
	items := IntegrationCatalog(IntegrationCapabilities{GitHubMirror: true})
	require.Len(t, items, 1)
	assert.Equal(t, "github-sync", items[0].ID)
}

func TestNewIntegrationsHandler_CopiesCatalog(t *testing.T) {
	t.Parallel()

	items := IntegrationCatalog(IntegrationCapabilities{GitHubMirror: true})
	h := NewIntegrationsHandler(items...)
	items[0].ID = "changed"
	items[0].Capabilities[0] = "changed"

	req := httptest.NewRequest(http.MethodGet, "/api/integrations/mcp", nil)
	rec := httptest.NewRecorder()
	h.GetMCPIntegrations(rec, req)

	var got []IntegrationCatalogItem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got, 1)
	assert.Equal(t, "github-sync", got[0].ID)
	assert.Equal(t, "Push mirror", got[0].Capabilities[0])
}
