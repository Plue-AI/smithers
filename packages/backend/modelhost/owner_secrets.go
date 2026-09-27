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

	"github.com/smithersai/smithers/packages/backend/internal/subscriptiontoken"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// OwnerSecretResolver reads the same encrypted repository secrets written by
// the product API. The database address becomes available after native-owned
// PostgreSQL starts, so it is obtained at turn time. The first turn opens a
// pool that later turns reuse; a changed address replaces it.
type OwnerSecretResolver struct {
	databaseURL func() string
	secretKey   func() string

	mu      sync.Mutex
	pool    *pgxpool.Pool
	poolURL string
}

func NewOwnerSecretResolver(databaseURL, secretKey func() string) (*OwnerSecretResolver, error) {
	if databaseURL == nil || secretKey == nil {
		return nil, errors.New("owner model secrets require database and encryption key providers")
	}
	return &OwnerSecretResolver{databaseURL: databaseURL, secretKey: secretKey}, nil
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
	codec, err := webhook.NewSecretCodec(resolver.secretKey())
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
			return Binding{}, ports.ErrModelCredentialMissing
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
			// A chat turn is an agent's: a main-only secret never reaches it.
			err := pool.QueryRow(ctx, `SELECT s.value_encrypted FROM repository_secrets s
				JOIN repositories r ON r.id=s.repository_id
				WHERE r.id=$1 AND r.user_id=$2 AND s.name=$3 AND NOT s.main_only`, input.RepositoryID, ownerID, name).Scan(&encrypted)
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
