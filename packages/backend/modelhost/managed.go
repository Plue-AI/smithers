package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

// ManagedCredentialName names the managed-credit credential in a model
// binding. Its value is always a turn credential the host mints; a guest
// sees only an egress placeholder in its place.
const ManagedCredentialName = "SMITHERS_MANAGED"

// managedDefaults is the model a managed turn runs for each provider the
// deployment pays for, in preference order. Every entry is priced
// (modelproxy.Price), so the proxy meters it.
var managedDefaults = []struct{ provider, protocol, modelID string }{
	{modelproxy.ProviderAnthropic, "anthropic-messages", "claude-sonnet-5"},
	{modelproxy.ProviderOpenAI, "openai-responses", "gpt-6-sol"},
}

// ManagedModels serves an owner's chat turns on managed credit when the
// owner names no model: a turn with no model, for an owner with no default
// model, runs a priced default through the metered model proxy. An explicit
// model and its credential failures stay the owner resolver's.
type ManagedModels struct {
	owner    Resolver
	keys     modelproxy.Keys
	proxyURL string
	origin   string
}

// NewManagedModels wraps owner. proxyURL is the metered proxy a guest
// reaches (the public API base URL plus modelproxy.Path); keys lists the
// providers the deployment pays for, read at every turn.
func NewManagedModels(owner Resolver, keys modelproxy.Keys, proxyURL string) (*ManagedModels, error) {
	proxyURL = strings.TrimRight(strings.TrimSpace(proxyURL), "/")
	parsed, err := url.Parse(proxyURL)
	if owner == nil || keys == nil || err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != modelproxy.Path {
		return nil, errors.New("managed models require an owner resolver, platform keys, and an https model proxy URL")
	}
	return &ManagedModels{owner: owner, keys: keys, proxyURL: proxyURL, origin: parsed.Scheme + "://" + parsed.Host}, nil
}

func (m *ManagedModels) ResolveChatModel(ctx context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
	binding, err := m.owner.ResolveChatModel(ctx, ownerID, repositoryID, request)
	if !errors.Is(err, ErrOwnerModelUnset) {
		return binding, err
	}
	offered := m.keys.PlatformModelProviders()
	for _, managed := range managedDefaults {
		if !slices.Contains(offered, managed.provider) {
			continue
		}
		model, marshalErr := json.Marshal(map[string]string{
			"protocol": managed.protocol, "modelId": managed.modelID, "credential": ManagedCredentialName,
			"baseUrl": m.proxyURL + "/" + managed.provider,
		})
		if marshalErr != nil {
			return Binding{}, marshalErr
		}
		return Binding{Model: model, CredentialName: ManagedCredentialName, CredentialOrigin: m.origin, Managed: true}, nil
	}
	return Binding{}, err
}
