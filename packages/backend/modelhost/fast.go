package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

// fastBinding uses the canonical model host for each fallback protocol. Only
// the existing Go proxy reads the per-install credential; the local host sees
// a per-launch bearer and credential-free bindings.
func (r *OwnerSecretResolver) fastBinding(ctx context.Context, owner, repo int64, access services.InstallFastModelAccess) (Binding, error) {
	pool, err := r.openPool(ctx, r.databaseURL())
	if err != nil {
		return Binding{}, err
	}
	q := db.New(pool)
	var fallbacks []Binding
	var models []json.RawMessage
	fast, err := q.EffectiveInstallAgentModel(ctx, "fast")
	if err == nil {
		models = append(models, fast)
	}
	coding, err := q.EffectiveInstallAgentModel(ctx, "coding")
	if err == nil && string(coding) != string(fast) {
		models = append(models, coding)
	}
	for _, model := range models {
		binding, err := r.resolveChatModel(ctx, owner, repo, json.RawMessage(`{}`), model, false)
		if err == nil {
			fallbacks = append(fallbacks, binding)
		}
	}
	nextSource := "coding model"
	if len(fallbacks) > 0 && string(fast) != string(coding) {
		nextSource = "team key"
	}
	installID, err := access.InstallID(ctx)
	if err != nil {
		return Binding{}, err
	}
	gateway := &modelproxy.InstallFastSource{InstallID: installID, Origin: strings.TrimSuffix(access.InferenceURL(), modelproxy.FastGatewayPath+"/v1/chat/completions"), Credential: access.Credential, Observe: func(ctx context.Context, observed modelproxy.FastStatus) error {
		status, err := access.Status(ctx)
		if err != nil {
			return err
		}
		status.Cause = observed.Cause
		status.Remaining = observed.Remaining
		status.ResetAt = observed.ResetAt
		status.Source = "Smithers"
		if status.Cause != "" {
			status.Source = nextSource
		}
		return access.Record(ctx, status)
	}}
	gateway.Status = func(ctx context.Context) (modelproxy.FastStatus, error) {
		status, err := access.Status(ctx)
		return modelproxy.FastStatus{Cause: status.Cause, Remaining: status.Remaining, ResetAt: status.ResetAt}, err
	}
	gateway.Selected = func(ctx context.Context, index int) error {
		status, err := access.Status(ctx)
		if err != nil {
			return err
		}
		status.Source = "coding model"
		if index == 1 {
			status.Source = nextSource
		}
		return access.Record(ctx, status)
	}
	return Binding{Fast: gateway, Fallbacks: fallbacks}, nil
}

type privateFastCaller string

func (token privateFastCaller) ResolveModelCaller(req *http.Request) (modelproxy.Caller, error) {
	if req.Header.Get("Authorization") != "Bearer "+string(token) {
		return modelproxy.Caller{}, modelproxy.ErrForbidden
	}
	return modelproxy.Caller{Source: modelproxy.SourceApp}, nil
}

func prepareFast(binding Binding) (Binding, func(), error) {
	var stops []func()
	closeAll := func() {
		for _, stop := range stops {
			stop()
		}
	}
	reusePreflight := binding.Fast != nil && binding.Preflight != nil && binding.Preflight.Fast == binding.Fast
	if binding.Preflight != nil && !reusePreflight {
		preflight, close, err := prepareFast(*binding.Preflight)
		if err != nil {
			return Binding{}, closeAll, err
		}
		stops = append(stops, close)
		binding.Preflight = &preflight
	}
	if binding.Fast == nil {
		return binding, closeAll, nil
	}
	token, err := randomFastBearer()
	if err != nil {
		closeAll()
		return Binding{}, func() {}, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		closeAll()
		return Binding{}, func() {}, err
	}
	proxy := &modelproxy.Handler{Fast: binding.Fast, Callers: privateFastCaller(token)}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 5_000_000_000}
	go func() { _ = server.Serve(listener) }()
	stops = append(stops, func() { _ = server.Close() })
	origin := "http://" + listener.Addr().String()
	binding.CredentialName = "SMITHERS_FAST_PROXY"
	binding.CredentialOrigin = origin
	binding.CredentialValue = token
	binding.Model, _ = json.Marshal(map[string]string{"protocol": "openai-chat", "modelId": "gpt-oss-120b", "credential": binding.CredentialName, "baseUrl": origin + modelproxy.Path + "/fast"})
	if reusePreflight {
		preflight := binding
		preflight.Preflight = nil
		binding.Preflight = &preflight
	}
	return binding, closeAll, nil
}
func randomFastBearer() (string, error) {
	token, err := services.FastModelBearer()
	if err != nil {
		return "", errors.New("fast-model proxy unavailable")
	}
	return token, nil
}
