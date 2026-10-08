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
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/chat/turncredential"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// Binding is resolved for exactly one authenticated owner and turn. Model is
// the canonical TypeScript ModelBinding; TypeScript remains the sole authority
// for provider routing, credential origin, and model policy.
type Binding struct {
	Fast      *modelproxy.InstallFastSource
	Fallbacks []Binding
	// Preflight is the install owner's fast role, resolved separately from
	// an explicit app-agent model. Its credential stays in launch memory too.
	Preflight        *Binding
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
	standIn  providerStandIn

	// transcripts is the one credential-free host that normalizes external
	// transcripts. It is launched at the first record and kept: a process per
	// record would add its start time to every line of a member's session.
	transcriptMu sync.Mutex
	transcripts  Lease
}

// TranscriptLauncher starts the packaged host with no model credential. A
// launcher that cannot do so leaves transcript import unavailable.
type TranscriptLauncher interface {
	LaunchTranscriptHost(context.Context) (Lease, error)
}

// ErrTranscriptHostUnavailable means this deployment's launcher cannot start
// the credential-free host, so no transcript can be normalized.
var ErrTranscriptHostUnavailable = errors.New("model host launcher cannot normalize transcripts")

// transcriptTimeout bounds one record's normalization. The adapters are pure
// and a record is at most 1 MiB; a host that takes longer is not answering.
const transcriptTimeout = 30 * time.Second

// NormalizeExternalTranscript sends one framed record to the install-shipped
// TypeScript adapters and returns their inert drafts and checkpoint. The host
// it uses holds no provider credential and never reaches a model. The adapter's
// refusal and the host's rejection of a request are returned as they are; only
// a host that did not answer is replaced, once, before the error is returned.
func (host *Host) NormalizeExternalTranscript(ctx context.Context, input chat.ExternalNormalizeInput) (chat.ExternalNormalized, error) {
	launcher, ok := host.launcher.(TranscriptLauncher)
	if !ok {
		return chat.ExternalNormalized{}, ErrTranscriptHostUnavailable
	}
	// Records of one source arrive in order and each needs the checkpoint of
	// the one before, so one request at a time loses nothing.
	host.transcriptMu.Lock()
	defer host.transcriptMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, transcriptTimeout)
	defer cancel()
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if host.transcripts == nil {
			lease, err := launcher.LaunchTranscriptHost(ctx)
			if err != nil {
				return chat.ExternalNormalized{}, fmt.Errorf("launch transcript host: %w", err)
			}
			host.transcripts = lease
		}
		baseURL, client, token := leaseEndpoint(host.transcripts)
		transport, err := chat.NewHTTPChatHost(baseURL, client, token)
		if err != nil {
			return chat.ExternalNormalized{}, err
		}
		normalized, err := transport.NormalizeExternalTranscript(ctx, input)
		var refusal *chat.ExternalRefusal
		if err == nil || errors.As(err, &refusal) || errors.Is(err, chat.ErrExternalInvalid) || ctx.Err() != nil {
			return normalized, err
		}
		// The host did not answer: it exited, or its connection failed. Its
		// state is the caller's checkpoint, so a new host continues exactly.
		lastErr = err
		cleanupCtx, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		_ = host.transcripts.Close(cleanupCtx)
		cancelCleanup()
		host.transcripts = nil
	}
	return chat.ExternalNormalized{}, lastErr
}

// HostOption configures a Host.
type HostOption func(*Host) error

// WithProviderStandIn sends every built-in credential's calls to a loopback
// stand-in (ProviderStandInVariable). An empty origin changes nothing.
func WithProviderStandIn(origin string) HostOption {
	return func(host *Host) (err error) {
		host.standIn, err = parseProviderStandIn(origin)
		return err
	}
}

const cleanupTimeout = 15 * time.Second

const maxModelStreamBytes = 16 << 20

func New(resolver Resolver, launcher Launcher, options ...HostOption) (*Host, error) {
	if resolver == nil || launcher == nil {
		return nil, errors.New("model host requires an owner-scoped resolver and private launcher")
	}
	host := &Host{resolver: resolver, launcher: launcher}
	for _, option := range options {
		if err := option(host); err != nil {
			return nil, err
		}
	}
	return host, nil
}

func (host *Host) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) (runErr error) {
	if grant.OwnerID <= 0 {
		return errors.New("model host grant has no authenticated owner")
	}
	binding, err := host.resolver.ResolveChatModel(ctx, grant.OwnerID, grant.RepositoryID, grant.Request)
	if err != nil {
		return fmt.Errorf("resolve owner model: %w", err)
	}
	// The binding names the key, so a provider's refusal names its provider.
	provider := services.ModelProviderNames[binding.CredentialName]
	binding, stopFast, err := prepareFast(binding)
	if err != nil {
		return err
	}
	defer stopFast()
	if binding, grant.Request, err = host.standIn.route(binding, grant.Request); err != nil {
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
	var refusal *chat.ProviderRefusal
	if errors.As(err, &refusal) {
		refusal.Provider = provider
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
	binding, stopFast, err := prepareFast(binding)
	if err != nil {
		return nil, err
	}
	defer stopFast()
	if binding, requestBody, err = host.standIn.route(binding, requestBody); err != nil {
		return nil, fmt.Errorf("resolve owner model: %w", err)
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

// maxContextSelectionBytes bounds the selector's one JSON result.
const maxContextSelectionBytes = 4 << 20

// SelectContext runs the shared context preflight selector alone, on the
// owner's fast role, in the same short-lived owner-scoped host as a chat
// turn. The host validates the input; the provider credential stays inside it.
func (host *Host) SelectContext(ctx context.Context, grant ports.ContextSelectionGrant) (result json.RawMessage, runErr error) {
	if grant.OwnerID <= 0 {
		return nil, errors.New("context selection has no authenticated owner")
	}
	if !json.Valid(grant.Input) || len(grant.Input) == 0 || grant.Input[0] != '{' {
		return nil, ports.ErrModelRequestInvalid
	}
	runID := uuid.NewString()
	requestBody, err := json.Marshal(map[string]any{
		"runId": runID, "ownerId": grant.OwnerID, "instructions": "", "messages": []any{}, "contextSelection": grant.Input,
	})
	if err != nil {
		return nil, fmt.Errorf("encode context selection: %w", err)
	}
	binding, err := host.resolver.ResolveChatModel(ctx, grant.OwnerID, grant.RepositoryID, requestBody)
	if err != nil {
		return nil, fmt.Errorf("resolve owner model: %w", err)
	}
	// Managed credit is metered against a durable chat turn; a selection has none.
	if binding.Managed || binding.Preflight != nil && binding.Preflight.Managed {
		return nil, fmt.Errorf("context selection has no chat turn to meter managed credit: %w", ports.ErrModelCredentialMissing)
	}
	binding, stopFast, err := prepareFast(binding)
	if err != nil {
		return nil, err
	}
	defer stopFast()
	if binding, requestBody, err = host.standIn.route(binding, requestBody); err != nil {
		return nil, fmt.Errorf("resolve owner model: %w", err)
	}
	chatGrant := ports.ChatTurnGrant{
		TurnID: "context-selection-" + runID, OwnerID: grant.OwnerID, RepositoryID: grant.RepositoryID,
		RunID: runID, LegID: runID, Generation: 1, Token: "context-selection",
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
	requestHTTP, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/context/select", bytes.NewReader(requestBody))
	if err != nil {
		return nil, err
	}
	requestHTTP.Header.Set("content-type", "application/json")
	requestHTTP.Header.Set("authorization", "Bearer "+token)
	response, err := client.Do(requestHTTP)
	if err != nil {
		return nil, fmt.Errorf("run context selection: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		if response.StatusCode == http.StatusBadRequest {
			return nil, ports.ErrModelRequestInvalid
		}
		return nil, fmt.Errorf("context selection host refused request with status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxContextSelectionBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read context selection: %w", err)
	}
	if len(body) > maxContextSelectionBytes || !json.Valid(body) {
		return nil, errors.New("context selection response is invalid")
	}
	return body, nil
}

// Close releases any launcher's retained cleanup work after dispatcher drain.
func (host *Host) Close(ctx context.Context) error {
	host.transcriptMu.Lock()
	var transcriptErr error
	if host.transcripts != nil {
		transcriptErr = host.transcripts.Close(ctx)
		host.transcripts = nil
	}
	host.transcriptMu.Unlock()
	if closer, ok := host.launcher.(interface{ Close(context.Context) error }); ok {
		return errors.Join(transcriptErr, closer.Close(ctx))
	}
	return transcriptErr
}
