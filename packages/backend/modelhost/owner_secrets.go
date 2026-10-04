package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/subscriptiontoken"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// ErrOwnerModelUnset is a turn that names no model for an owner with no
// default model. It is a missing credential unless managed models serve the
// turn (NewManagedModels).
var ErrOwnerModelUnset = fmt.Errorf("owner has no default model: %w", ports.ErrModelCredentialMissing)

// OwnerSecretResolver reads the same encrypted repository secrets written by
// the product API. The database address becomes available after native-owned
// PostgreSQL starts, so it is obtained at turn time. The first turn opens a
// pool that later turns reuse; a changed address replaces it.
type OwnerSecretResolver struct {
	databaseURL  func() string
	secretKey    func() string
	previousKeys func() string

	mu      sync.Mutex
	pool    *pgxpool.Pool
	poolURL string
}

// OwnerSecretOption configures an OwnerSecretResolver.
type OwnerSecretOption func(*OwnerSecretResolver)

// WithPreviousSecretKeys supplies the operator keys a rotation replaced, in
// the SMITHERS_WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS form, so credentials
// stay readable until they are resealed under the current key.
func WithPreviousSecretKeys(previousKeys func() string) OwnerSecretOption {
	return func(resolver *OwnerSecretResolver) { resolver.previousKeys = previousKeys }
}

func NewOwnerSecretResolver(databaseURL, secretKey func() string, options ...OwnerSecretOption) (*OwnerSecretResolver, error) {
	if databaseURL == nil || secretKey == nil {
		return nil, errors.New("owner model secrets require database and encryption key providers")
	}
	resolver := &OwnerSecretResolver{databaseURL: databaseURL, secretKey: secretKey, previousKeys: func() string { return "" }}
	for _, option := range options {
		option(resolver)
	}
	if resolver.previousKeys == nil {
		return nil, errors.New("owner model secrets require a previous key provider")
	}
	return resolver, nil
}

func (resolver *OwnerSecretResolver) ResolveChatModel(ctx context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
	var input struct {
		RepositoryID int64           `json:"repositoryId"`
		Model        json.RawMessage `json:"model"`
	}
	var model struct {
		Protocol   string `json:"protocol"`
		ModelID    string `json:"modelId"`
		Credential string `json:"credential"`
	}
	if err := json.Unmarshal(request, &input); err != nil {
		return Binding{}, errors.New("model turn request is invalid")
	}
	if input.RepositoryID == 0 {
		input.RepositoryID = repositoryID
	}
	if ownerID <= 0 || strings.TrimSpace(resolver.databaseURL()) == "" {
		return Binding{}, errors.New("owner model store is unavailable")
	}
	codec, err := webhook.NewSecretCodec(resolver.secretKey(), config.WebhookConfig{PreviousSecretEncryptionKeys: resolver.previousKeys()}.PreviousKeys()...)
	if err != nil {
		return Binding{}, fmt.Errorf("open owner model secrets: %w", err)
	}
	pool, err := resolver.openPool(ctx, resolver.databaseURL())
	if err != nil {
		return Binding{}, fmt.Errorf("connect owner model secrets: %w", err)
	}
	if len(input.Model) == 0 || string(input.Model) == "null" {
		err = pool.QueryRow(ctx, `SELECT model FROM owner_model_defaults WHERE user_id=$1`, ownerID).Scan(&input.Model)
		if errors.Is(err, pgx.ErrNoRows) {
			return Binding{}, ErrOwnerModelUnset
		}
		if err != nil {
			return Binding{}, fmt.Errorf("read owner default model: %w", err)
		}
	}
	if json.Unmarshal(input.Model, &model) != nil || model.Protocol == "" || model.ModelID == "" || !validCredentialName(model.Credential) {
		return Binding{}, errors.New("model turn requires a configured model")
	}
	read := func(name string) (string, error) {
		var encrypted []byte
		if input.RepositoryID > 0 {
			// A chat turn is an agent's: a main-only secret never reaches it,
			// nor one bound to hosts, which only an egress proxy may carry.
			err := pool.QueryRow(ctx, `SELECT s.value_encrypted FROM repository_secrets s
				JOIN repositories r ON r.id=s.repository_id
				WHERE r.id=$1 AND r.user_id=$2 AND s.name=$3 AND NOT s.main_only AND cardinality(s.hosts) = 0`, input.RepositoryID, ownerID, name).Scan(&encrypted)
			if err == nil {
				return codec.DecryptString(string(encrypted))
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return "", err
			}
		}
		err := pool.QueryRow(ctx, `SELECT value_encrypted FROM owner_model_credentials WHERE user_id=$1 AND name=$2`, ownerID, name).Scan(&encrypted)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ports.ErrModelCredentialMissing
		}
		if err != nil {
			return "", err
		}
		return codec.DecryptString(string(encrypted))
	}
	value, err := read(model.Credential)
	if err != nil {
		return Binding{}, fmt.Errorf("read owner model credential: %w", err)
	}
	if strings.TrimSpace(value) == "" {
		return Binding{}, ports.ErrModelCredentialMissing
	}
	// A subscription login stored before the save refusal, or a repository
	// secret overriding the credential, is not an API key: the turn fails as
	// a missing credential to replace. The error names the credential, never
	// its value (#2222).
	if subscriptiontoken.Holds(model.Credential, value) {
		return Binding{}, fmt.Errorf("model credential %s holds a Claude or ChatGPT subscription token; replace it with an API key: %w", model.Credential, ports.ErrModelCredentialMissing)
	}
	binding := Binding{Model: input.Model, CredentialName: model.Credential, CredentialValue: value}
	if !builtinCredential(model.Credential) {
		var origin string
		if input.RepositoryID > 0 {
			origin, err = read(model.Credential + "_ORIGIN")
		}
		if origin == "" || err != nil {
			err = pool.QueryRow(ctx, `SELECT origin FROM owner_model_credentials WHERE user_id=$1 AND name=$2`, ownerID, model.Credential).Scan(&origin)
			if err != nil {
				return Binding{}, fmt.Errorf("read owner model origin: %w", err)
			}
		}
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
			return Binding{}, errors.New("owner model origin is invalid")
		}
		binding.CredentialOrigin = origin
	}
	return binding, nil
}

func (resolver *OwnerSecretResolver) openPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if resolver.pool != nil && resolver.poolURL == databaseURL {
		return resolver.pool, nil
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if resolver.pool != nil {
		resolver.pool.Close()
	}
	resolver.pool, resolver.poolURL = pool, databaseURL
	return pool, nil
}

// Close releases the resolver's database pool.
func (resolver *OwnerSecretResolver) Close() {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if resolver.pool != nil {
		resolver.pool.Close()
		resolver.pool, resolver.poolURL = nil, ""
	}
}

func builtinCredential(name string) bool {
	switch name {
	case "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY":
		return true
	default:
		return false
	}
}

// OwnerGatewayKeys resolves the install's agent:jev binding for every call.
// It implements Keys solely to reuse Jev's transport; it is never installed as
// platform-paid proxy access and has no environment or file fallback.
type OwnerGatewayKeys struct{ Resolver *OwnerSecretResolver }

func (keys OwnerGatewayKeys) PlatformModelProviders() []string { return []string{"vercel"} }
func (keys OwnerGatewayKeys) PlatformModelKey(ctx context.Context, provider string) (string, error) {
	if provider != "vercel" || keys.Resolver == nil {
		return "", ports.ErrModelCredentialMissing
	}
	resolver := keys.Resolver
	pool, err := resolver.openPool(ctx, resolver.databaseURL())
	if err != nil {
		return "", err
	}
	var owner int64
	var model json.RawMessage
	err = pool.QueryRow(ctx, `SELECT o.user_id,s.value FROM self_host_owners o CROSS JOIN install_settings s WHERE s.key='agent:jev'`).Scan(&owner, &model)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ports.ErrModelCredentialMissing
	}
	if err != nil {
		return "", err
	}
	var binding struct {
		Credential string `json:"credential"`
	}
	if json.Unmarshal(model, &binding) != nil || binding.Credential != "AI_GATEWAY_API_KEY" {
		return "", ports.ErrModelCredentialMissing
	}
	request, _ := json.Marshal(map[string]any{"model": model})
	result, err := resolver.ResolveChatModel(ctx, owner, 0, request)
	if err != nil {
		return "", err
	}
	return result.CredentialValue, nil
}
