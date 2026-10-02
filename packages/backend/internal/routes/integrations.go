package routes

import (
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type IntegrationsHandler struct {
	catalog []IntegrationCatalogItem
}

type IntegrationCatalogItem struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Icon         string   `json:"icon"`
	Color        string   `json:"color"`
	Status       string   `json:"status"`
	Installed    bool     `json:"installed"`
	Kind         string   `json:"kind"`
	Route        string   `json:"route,omitempty"`
	Capabilities []string `json:"capabilities"`
}

// IntegrationCapabilities names only providers backed by the common product
// services in this process. Code presence alone is not a capability.
type IntegrationCapabilities struct {
	GitHubMirror bool
}

// NewIntegrationsHandler preserves the client response shape while making the
// catalog installation-specific. With no configured providers it returns an
// empty catalog instead of invented installed integrations.
func NewIntegrationsHandler(catalog ...IntegrationCatalogItem) *IntegrationsHandler {
	items := append([]IntegrationCatalogItem(nil), catalog...)
	for i := range items {
		items[i].Capabilities = append([]string(nil), items[i].Capabilities...)
	}
	return &IntegrationsHandler{catalog: items}
}

// IntegrationCatalog returns the entries supported by the actual services
// selected during composition. The MVP exposes GitHub only.
func IntegrationCatalog(capabilities IntegrationCapabilities) []IntegrationCatalogItem {
	items := make([]IntegrationCatalogItem, 0, 1)
	if capabilities.GitHubMirror {
		items = append(items, IntegrationCatalogItem{
			ID:           "github-sync",
			Name:         "GitHub",
			Icon:         "github",
			Color:        "text-primary",
			Status:       "Configured",
			Installed:    true,
			Kind:         "sync-service",
			Route:        "/integrations/github",
			Capabilities: []string{"Push mirror", "Refs and tags", "Webhooks", "Scheduled sync"},
		})
	}
	return items
}

func (h *IntegrationsHandler) GetMCPIntegrations(w http.ResponseWriter, r *http.Request) {
	items := make([]IntegrationCatalogItem, len(h.catalog))
	copy(items, h.catalog)
	errors.WriteJSON(w, http.StatusOK, items)
}

func (h *IntegrationsHandler) GetSkills(w http.ResponseWriter, r *http.Request) {
	// No real skills catalog is built yet; return empty rather than fabricate one.
	errors.WriteJSON(w, http.StatusOK, []map[string]any{})
}
