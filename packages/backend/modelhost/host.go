// Package modelhost connects the durable Go chat journal to the canonical
// TypeScript model host. Credential selection is an authorized deployment
// concern; a grant never carries a provider secret.
package modelhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/chat/turncredential"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// Binding is resolved for exactly one authenticated owner and turn. Model is
// the canonical TypeScript ModelBinding; TypeScript remains the sole authority
// for provider routing, credential origin, and model policy.
type Binding struct {
	Model            json.RawMessage
	CredentialName   string
	CredentialOrigin string

	// CredentialValue is held only in the launch request's memory and child
	// process environment. It must never enter workspace metadata or logs.
	CredentialValue string

	// Managed spends the owner's managed credit through the metered model
	// proxy. A resolver leaves CredentialValue empty; the host fills it with
	// the turn's own credential (turncredential.Mint), so no provider key
	// or user token reaches the launcher.
	Managed bool
}

type Resolver interface {
	ResolveChatModel(context.Context, int64, int64, json.RawMessage) (Binding, error)
}

type ResolverFunc func(context.Context, int64, int64, json.RawMessage) (Binding, error)

func (resolve ResolverFunc) ResolveChatModel(ctx context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
	return resolve(ctx, ownerID, repositoryID, request)
}

// Lease is an authenticated private connection to one launched host. Close
// joins process termination and workspace cleanup before a turn is released.
type Lease interface {
	// A nil client uses the standard HTTP transport with the caller's context.
	Endpoint() (baseURL string, client *http.Client, token string)
	Close(context.Context) error
}

func leaseEndpoint(lease Lease) (baseURL string, client *http.Client, token string) {
	baseURL, client, token = lease.Endpoint()
	if client == nil {
		client = &http.Client{}
	}
	return
}

type Launcher interface {
	LaunchChatHost(context.Context, ports.ChatTurnGrant, Binding) (Lease, error)
}

type Host struct {
	resolver Resolver
	launcher Launcher
}

const cleanupTimeout = 15 * time.Second

const maxModelStreamBytes = 16 << 20

func New(resolver Resolver, launcher Launcher) (*Host, error) {
	if resolver == nil || launcher == nil {
		return nil, errors.New("model host requires an owner-scoped resolver and private launcher")
	}
	return &Host{resolver: resolver, launcher: launcher}, nil
}

func (host *Host) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) (runErr error) {
	if grant.OwnerID <= 0 {
		return errors.New("model host grant has no authenticated owner")
	}
	binding, err := host.resolver.ResolveChatModel(ctx, grant.OwnerID, grant.RepositoryID, grant.Request)
	if err != nil {
		return fmt.Errorf("resolve owner model: %w", err)
	}
	if binding.Managed {
		binding.CredentialValue = turncredential.Mint(grant.TurnID, grant.Generation, grant.Token)
	}
	lease, err := host.launcher.LaunchChatHost(ctx, grant, binding)
	if err != nil {
		return fmt.Errorf("launch owner model host: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		runErr = errors.Join(runErr, lease.Close(cleanupCtx))
	}()
	baseURL, client, token := leaseEndpoint(lease)
	// The lease client's timeout bounds probes and streams. A chat turn has
	// no fixed length; the dispatcher context and producer lease end it.
	turnClient := *client
	turnClient.Timeout = 0
	transport, err := chat.NewHTTPChatHost(baseURL, &turnClient, token)
	if err != nil {
		return err
	}
	err = transport.RunChatTurn(ctx, grant)
	// The binding names the key, so a provider's refusal names its provider.
	var refusal *chat.ProviderRefusal
	if errors.As(err, &refusal) {
		refusal.Provider = services.ModelProviderNames[binding.CredentialName]
	}
	return err
}

// RunModelStream uses the same owner resolver and short-lived local host as a
// durable chat turn, but asks the host for a sealed NDJSON response directly.
// The provider credential remains inside the launched host process.
func (host *Host) RunModelStream(ctx context.Context, grant ports.ModelStreamGrant) (stream io.ReadCloser, runErr error) {
	if grant.OwnerID <= 0 {
		return nil, errors.New("model stream has no authenticated owner")
	}
	var request map[string]any
	if err := json.Unmarshal(grant.Request, &request); err != nil || request == nil {
		return nil, ports.ErrModelRequestInvalid
	}
	runID := uuid.NewString()
	request["runId"] = runID
	request["ownerId"] = grant.OwnerID
	requestBody, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encode model stream request: %w", err)
	}
	binding, err := host.resolver.ResolveChatModel(ctx, grant.OwnerID, grant.RepositoryID, requestBody)
	if err != nil {
		return nil, fmt.Errorf("resolve owner model: %w", err)
	}
	// Managed credit is metered against a durable chat turn; a model stream
	// has none, so it runs only on the owner's own credential.
	if binding.Managed {
		return nil, fmt.Errorf("model stream has no chat turn to meter managed credit: %w", ports.ErrModelCredentialMissing)
	}
	chatGrant := ports.ChatTurnGrant{
		TurnID: "model-stream-" + runID, OwnerID: grant.OwnerID, RepositoryID: grant.RepositoryID,
		RunID: runID, LegID: runID, Generation: 1, Token: "model-stream",
		ExpiresAt: time.Now().Add(15 * time.Minute), Request: requestBody, ProducerBaseURL: "http://127.0.0.1",
	}
	lease, err := host.launcher.LaunchChatHost(ctx, chatGrant, binding)
	if err != nil {
		return nil, fmt.Errorf("launch owner model host: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		runErr = errors.Join(runErr, lease.Close(cleanupCtx))
	}()
	baseURL, client, token := leaseEndpoint(lease)
	endpoint := strings.TrimRight(baseURL, "/") + "/v1/model/stream"
	requestHTTP, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(requestBody))
	if err != nil {
		return nil, err
	}
	requestHTTP.Header.Set("content-type", "application/json")
	requestHTTP.Header.Set("authorization", "Bearer "+token)
	response, err := client.Do(requestHTTP)
	if err != nil {
		return nil, fmt.Errorf("run model stream: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		// The canonical host reserves 400 for request validation; provider
		// and execution failures use 502.
		if response.StatusCode == http.StatusBadRequest {
			return nil, ports.ErrModelRequestInvalid
		}
		return nil, fmt.Errorf("model stream host refused request with status %d", response.StatusCode)
	}
	// Read one extra byte so the cap cannot turn a truncated stream into success.
	body, err := io.ReadAll(io.LimitReader(response.Body, maxModelStreamBytes+1))
	response.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("read model stream: %w", err)
	}
	if len(body) > maxModelStreamBytes {
		return nil, errors.New("model stream response too large")
	}
	return io.NopCloser(bytes.NewReader(body)), nil
}

// Close releases any launcher's retained cleanup work after dispatcher drain.
func (host *Host) Close(ctx context.Context) error {
	if closer, ok := host.launcher.(interface{ Close(context.Context) error }); ok {
		return closer.Close(ctx)
	}
	return nil
}
