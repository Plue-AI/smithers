package modelhost

import (
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strings"
)

// ProviderStandInVariable names the loopback origin that answers for every
// built-in model provider. The no-GitHub walk sets it to its model fake
// (apps/app/scripts/run-local-no-github.ts) as it sets the GitHub base URLs;
// unset, every call goes to its provider.
const ProviderStandInVariable = "SMITHERS_MODEL_PROVIDER_ORIGIN"

// standInPrefix renames a built-in credential for the stand-in. The model
// host pins a built-in to its provider's origin and never re-pins one
// (@smthrs/rpc customModelCredentials), so the key travels to the stand-in as
// a custom credential pinned to the stand-in alone.
const standInPrefix = "STANDIN_"

// providerStandIn is a canonical loopback origin, or empty for none.
type providerStandIn string

// parseProviderStandIn accepts http on a loopback host with a port and
// nothing after it: a key sent there never leaves this machine.
func parseProviderStandIn(raw string) (providerStandIn, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	invalid := errors.New(ProviderStandInVariable + " must be an http loopback origin such as http://127.0.0.1:47400")
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Port() == "" ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", invalid
	}
	host := parsed.Hostname()
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "", invalid
	}
	return providerStandIn("http://" + parsed.Host), nil
}

// model sends a ConfiguredModel record on a built-in credential to the
// stand-in: the credential under its stand-in name, the base URL's origin
// replaced and its path kept. Any other value is returned unchanged.
func (origin providerStandIn) model(raw json.RawMessage) (json.RawMessage, error) {
	var record map[string]json.RawMessage
	if origin == "" || json.Unmarshal(raw, &record) != nil || record == nil {
		return raw, nil
	}
	var credential, baseURL string
	if json.Unmarshal(record["credential"], &credential) != nil || !builtinCredential(credential) {
		return raw, nil
	}
	base := string(origin)
	if json.Unmarshal(record["baseUrl"], &baseURL) == nil && baseURL != "" {
		parsed, err := url.Parse(baseURL)
		if err != nil {
			return nil, errors.New("model base URL is invalid")
		}
		base += strings.TrimRight(parsed.EscapedPath(), "/")
	}
	record["credential"], _ = json.Marshal(standInPrefix + credential)
	record["baseUrl"], _ = json.Marshal(base)
	return json.Marshal(record)
}

// route sends a resolved binding on a built-in credential, and the request
// the model host plans again, to the stand-in. Managed credit and custom
// credentials keep their own addresses.
func (origin providerStandIn) route(binding Binding, request json.RawMessage) (Binding, json.RawMessage, error) {
	if origin == "" || binding.Managed || !builtinCredential(binding.CredentialName) {
		return binding, request, nil
	}
	model, err := origin.model(binding.Model)
	if err != nil {
		return Binding{}, nil, err
	}
	binding.Model, binding.CredentialName, binding.CredentialOrigin = model, standInPrefix+binding.CredentialName, string(origin)
	var body map[string]json.RawMessage
	if json.Unmarshal(request, &body) != nil || body == nil || len(body["model"]) == 0 {
		return binding, request, nil
	}
	if body["model"], err = origin.model(body["model"]); err != nil {
		return Binding{}, nil, err
	}
	request, err = json.Marshal(body)
	return binding, request, err
}
