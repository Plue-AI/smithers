package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/smithersai/smithers/packages/backend/ports"
)

const ModelHostTurnPath = "/v1/chat/turn"

// maxRefusalDetailBytes bounds the host's error body carried into logs.
const maxRefusalDetailBytes = 512

// ProviderRefusal is a turn the model provider refused, as the host classified
// it (model-host HostServer.ts): "provider_quota" when its quota or credits
// ran out, "provider_auth" when it rejected the key. The provider answered, so
// the turn ends with this reason instead of rerunning. Provider is the
// provider's name when the caller knows the binding.
type ProviderRefusal struct {
	Code     string
	Provider string
}

func (r *ProviderRefusal) Error() string { return "model provider refused the turn: " + r.Code }

// Text is the reason the person reads, in product words.
func (r *ProviderRefusal) Text() string {
	who := r.Provider
	if who == "" {
		who = "The model provider"
	}
	if r.Code == "provider_auth" {
		return who + " rejected the key."
	}
	return who + " is out of quota or credits."
}

// HTTPChatHost is the deployment neutral adapter to the packaged TypeScript
// model host. The grant contains an opaque callback capability, never a
// provider credential. Local composition points it at loopback; Plue points it
// at the same bundle on its isolated service network.
type HTTPChatHost struct {
	endpoint      *url.URL
	client        *http.Client
	authorization string
}

func NewHTTPChatHost(baseURL string, client *http.Client, authorization string) (*HTTPChatHost, error) {
	endpoint, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("chat model host URL is invalid")
	}
	// Keep any prefix the host is served under, such as an ingress path.
	if endpoint.Path == "" {
		endpoint.Path = "/"
	}
	endpoint = endpoint.JoinPath(ModelHostTurnPath)
	if client == nil {
		// A turn has no fixed length. The dispatcher context ends it.
		client = &http.Client{}
	}
	authorization = strings.TrimSpace(authorization)
	if authorization == "" {
		return nil, errors.New("chat model host authorization is required")
	}
	return &HTTPChatHost{endpoint: endpoint, client: client, authorization: authorization}, nil
}

func (h *HTTPChatHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	body, err := json.Marshal(grant)
	if err != nil {
		return fmt.Errorf("encode chat model grant: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, h.endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create chat model request: %w", err)
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", "Bearer "+h.authorization)
	response, err := h.client.Do(request)
	if err != nil {
		return fmt.Errorf("run chat model host: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	detail, _ := io.ReadAll(io.LimitReader(response.Body, maxRefusalDetailBytes))
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var refused struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(detail, &refused) == nil && (refused.Code == "provider_quota" || refused.Code == "provider_auth") {
			return fmt.Errorf("chat model host refused grant with status %d: %w", response.StatusCode, &ProviderRefusal{Code: refused.Code})
		}
		return fmt.Errorf("chat model host refused grant with status %d: %s", response.StatusCode, strings.ToValidUTF8(strings.TrimSpace(string(detail)), "?"))
	}
	return nil
}
