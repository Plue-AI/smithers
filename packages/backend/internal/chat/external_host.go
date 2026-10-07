package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// ExternalNormalizeInput contains trusted registration context and one framed
// record. State is the adapter checkpoint from the previous committed receipt.
type ExternalNormalizeInput struct {
	Profile string            `json:"profile"`
	Context map[string]string `json:"context"`
	Record  string            `json:"record"`
	Start   uint64            `json:"start"`
	End     uint64            `json:"end"`
	State   json.RawMessage   `json:"state,omitempty"`
}

type ExternalNormalized struct {
	Entries   []ExternalDraft `json:"entries"`
	State     json.RawMessage `json:"state"`
	NeedsMore bool            `json:"needs_more"`
}

// NormalizeExternalTranscript calls the same packaged host as app-agent turns,
// using its existing bearer. It never calls a model or executes transcript text.
func (h *HTTPChatHost) NormalizeExternalTranscript(ctx context.Context, input ExternalNormalizeInput) (ExternalNormalized, error) {
	if h == nil || h.endpoint == nil {
		return ExternalNormalized{}, ErrInvalidRequest
	}
	endpoint := *h.endpoint
	endpoint.Path = strings.TrimSuffix(endpoint.Path, ModelHostTurnPath) + "/v1/transcript/normalize"
	body, err := json.Marshal(input)
	if err != nil {
		return ExternalNormalized{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return ExternalNormalized{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.authorization)
	res, err := h.client.Do(req)
	if err != nil {
		return ExternalNormalized{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ExternalNormalized{}, errors.New("external transcript normalization refused")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024+1))
	if err != nil {
		return ExternalNormalized{}, err
	}
	if len(data) > 4*1024*1024 {
		return ExternalNormalized{}, ErrLimit
	}
	var decoded ExternalNormalized
	if err = json.Unmarshal(data, &decoded); err != nil {
		return ExternalNormalized{}, err
	}
	if decoded.NeedsMore || !json.Valid(decoded.State) {
		return ExternalNormalized{}, ErrInvalidFrame
	}
	for _, entry := range decoded.Entries {
		if !entry.valid() {
			return ExternalNormalized{}, ErrInvalidFrame
		}
	}
	return decoded, nil
}
