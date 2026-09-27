// Package modelproxy is the one metering point for model calls made with a
// platform (Smithers-paid) provider key. Guests, managed Flow hosts and the
// product's own model features reach providers through it with a Smithers
// credential; it reserves a provider-enforced bound in the credit ledger,
// forwards the call with a key resolved at use, settles the reported usage
// once and records the call in model_usage. Platform keys never leave this
// process. Calls on a user's own connected accounts use the account pool
// (/provider-pool) and are not metered here.
package modelproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strings"
)

// Path is where the proxy is mounted: outside /api, because model calls
// stream for minutes and guest credentials are confined away from /api.
const Path = "/model-proxy"

// APIPath serves the same proxy to the app's signed-in calls, which reach it
// with the user's own token (apps/server modelPayer.ts).
const APIPath = "/api/model"

// Guest environment variables. URLEnv is the TypeScript model routes'
// SMITHERS_MODEL_PROXY_URL; ProvidersEnv limits it to the listed providers so a
// repository's own key for another provider keeps its provider origin.
const (
	URLEnv       = "SMITHERS_MODEL_PROXY_URL"
	ProvidersEnv = "SMITHERS_MODEL_PROXY_PROVIDERS"
)

// Provider names, as they appear in the proxy path.
const (
	ProviderAnthropic  = "anthropic"
	ProviderOpenAI     = "openai"
	ProviderCerebras   = "cerebras"
	ProviderOpenRouter = "openrouter"
	ProviderVercel     = "vercel"
)

// ErrKeyMissing means the deployment offers no platform key for a provider.
var ErrKeyMissing = errors.New("modelproxy: platform model key is not configured")

// Keys is the deployment port for platform provider keys. PlatformModelKey is
// called for every model call, so a rotated key applies to the next call; the
// proxy never caches, logs or stores the value.
type Keys interface {
	// PlatformModelProviders lists the providers the deployment pays for.
	PlatformModelProviders() []string
	// PlatformModelKey returns the provider's key, or ErrKeyMissing.
	PlatformModelKey(ctx context.Context, provider string) (string, error)
}

// Seat is the guest-side spelling of one platform provider: the key variable a
// model SDK reads and the base URL variable that points it at the proxy.
type Seat struct {
	Provider   string
	KeyEnv     string
	BaseURLEnv string
	// BaseURLPath follows the proxy URL in BaseURLEnv.
	BaseURLPath string
}

// Seats are the platform seats in a stable order.
var Seats = []Seat{
	{ProviderAnthropic, "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "/anthropic"},
	{ProviderOpenAI, "OPENAI_API_KEY", "OPENAI_BASE_URL", "/openai/v1"},
	{ProviderCerebras, "CEREBRAS_API_KEY", "CEREBRAS_BASE_URL", "/cerebras/v1"},
	{ProviderOpenRouter, "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "/openrouter/v1"},
	{ProviderVercel, "AI_GATEWAY_API_KEY", "SMITHERS_EVALUATOR_BASE_URL", "/vercel/v4/ai/evaluation-model"},
}

// SeatFor returns the seat for a provider or a key variable name.
func SeatFor(name string) (Seat, bool) {
	name = strings.TrimSpace(name)
	for _, seat := range Seats {
		if seat.Provider == name || seat.KeyEnv == name {
			return seat, true
		}
	}
	return Seat{}, false
}

// OfferedSeats returns the seats of the providers keys offers, in Seats order.
func OfferedSeats(keys Keys) []Seat {
	if keys == nil {
		return nil
	}
	offered := keys.PlatformModelProviders()
	var out []Seat
	for _, seat := range Seats {
		if slices.Contains(offered, seat.Provider) {
			out = append(out, seat)
		}
	}
	return out
}

// GuestEnvironment is the non-secret environment that routes seats through
// the proxy at proxyURL (an origin followed by Path). The seats' key variables
// are set by the caller to a Smithers model credential, never a provider key.
func GuestEnvironment(proxyURL string, seats []Seat) map[string]string {
	proxyURL = strings.TrimRight(strings.TrimSpace(proxyURL), "/")
	env := map[string]string{}
	if proxyURL == "" || len(seats) == 0 {
		return env
	}
	providers := make([]string, 0, len(seats))
	for _, seat := range seats {
		providers = append(providers, seat.Provider)
		env[seat.BaseURLEnv] = proxyURL + seat.BaseURLPath
	}
	env[URLEnv] = proxyURL
	env[ProvidersEnv] = strings.Join(providers, ",")
	return env
}

// StaticKeys serves keys held in process configuration. Unusable values
// (blank, operator placeholders, <templates>) are not offered.
type StaticKeys map[string]string

// NewStaticKeys keeps the usable keys of the known providers.
func NewStaticKeys(byProvider map[string]string) StaticKeys {
	out := StaticKeys{}
	for provider, key := range byProvider {
		if _, ok := SeatFor(provider); ok && UsableKey(key) {
			out[provider] = strings.TrimSpace(key)
		}
	}
	return out
}

func (k StaticKeys) PlatformModelProviders() []string {
	var out []string
	for _, seat := range Seats {
		if _, ok := k[seat.Provider]; ok {
			out = append(out, seat.Provider)
		}
	}
	return out
}

func (k StaticKeys) PlatformModelKey(_ context.Context, provider string) (string, error) {
	if key, ok := k[provider]; ok {
		return key, nil
	}
	return "", ErrKeyMissing
}

// UsableKey rejects blanks, operator-seeded placeholders and <templates>.
func UsableKey(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || (strings.HasPrefix(trimmed, "<") && strings.HasSuffix(trimmed, ">")) {
		return false
	}
	lower := strings.ToLower(trimmed)
	for _, prefix := range []string{"placeholder", "changeme", "change-me", "replace-me", "replaceme", "todo", "unset", "example"} {
		if strings.HasPrefix(lower, prefix) {
			return false
		}
	}
	return true
}

// KeysFileEnv names the platform model key file of a self-hosted install.
const KeysFileEnv = "SMITHERS_PLATFORM_MODEL_KEYS_FILE"

// FileKeys serves keys from a JSON object of provider to key, such as
// {"anthropic":"sk-ant-...","openai":"sk-..."}. The providers offered are
// fixed when the file is opened; each key is read from the file on every
// call, so a rotated key applies to the next call. The file must not be
// readable or writable by other users. Errors never quote the file.
type FileKeys struct {
	path      string
	providers []string
}

// OpenKeysFile validates path and returns the keys it offers.
func OpenKeysFile(path string) (*FileKeys, error) {
	keys := &FileKeys{path: strings.TrimSpace(path)}
	if keys.path == "" {
		return nil, errors.New("modelproxy: platform model key file path is empty")
	}
	byProvider, err := keys.read()
	if err != nil {
		return nil, err
	}
	for name, key := range byProvider {
		if _, ok := SeatFor(name); !ok || name != strings.TrimSpace(name) {
			// The name is never quoted: a swapped entry would print a key.
			return nil, fmt.Errorf("modelproxy: platform model key file names an unknown provider (want %s)", strings.Join(providerNames(), ", "))
		}
		if !UsableKey(key) {
			return nil, fmt.Errorf("modelproxy: platform model key for %s is blank or a placeholder", name)
		}
	}
	keys.providers = NewStaticKeys(byProvider).PlatformModelProviders()
	return keys, nil
}

func (k *FileKeys) read() (map[string]string, error) {
	file, err := os.Open(k.path)
	if err != nil {
		return nil, fmt.Errorf("modelproxy: open platform model key file: %w", err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("modelproxy: stat platform model key file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("modelproxy: platform model key file is not a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("modelproxy: platform model key file %s is accessible to other users (mode %04o); chmod 600 it", k.path, info.Mode().Perm())
	}
	raw, err := io.ReadAll(io.LimitReader(file, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("modelproxy: read platform model key file: %w", err)
	}
	var byProvider map[string]string
	if json.Unmarshal(raw, &byProvider) != nil || byProvider == nil {
		return nil, errors.New("modelproxy: platform model key file must be a JSON object of provider name to key")
	}
	return byProvider, nil
}

func providerNames() []string {
	names := make([]string, len(Seats))
	for i, seat := range Seats {
		names[i] = seat.Provider
	}
	return names
}

func (k *FileKeys) PlatformModelProviders() []string { return slices.Clone(k.providers) }

func (k *FileKeys) PlatformModelKey(_ context.Context, provider string) (string, error) {
	if !slices.Contains(k.providers, provider) {
		return "", ErrKeyMissing
	}
	byProvider, err := k.read()
	if err != nil {
		return "", errors.Join(ErrKeyMissing, err)
	}
	key := strings.TrimSpace(byProvider[provider])
	if !UsableKey(key) {
		return "", ErrKeyMissing
	}
	return key, nil
}

// UpstreamsEnv names a self-hosted install's provider origin overrides: a
// JSON object of provider name to HTTP(S) origin, such as
// {"cerebras":"http://inference.internal:8080"}. Platform keys are sent to
// these origins instead of the provider's, so only an operator sets them.
const UpstreamsEnv = "SMITHERS_MODEL_PROXY_UPSTREAMS"

// ParseUpstreams validates an UpstreamsEnv value; blank means none.
func ParseUpstreams(raw string) (map[string]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var byProvider map[string]string
	if json.Unmarshal([]byte(raw), &byProvider) != nil || byProvider == nil {
		return nil, fmt.Errorf("modelproxy: %s must be a JSON object of provider name to origin", UpstreamsEnv)
	}
	for provider, origin := range byProvider {
		if _, ok := routes[provider]; !ok {
			return nil, fmt.Errorf("modelproxy: %s names an unknown provider (want %s)", UpstreamsEnv, strings.Join(providerNames(), ", "))
		}
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
			parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("modelproxy: %s origin for %s must be an HTTP(S) URL without credentials", UpstreamsEnv, provider)
		}
	}
	return byProvider, nil
}
