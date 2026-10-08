package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// ExternalRefusal is the adapter's answer that it does not read this record:
// a release line or a kind of record outside the ones it names. It is a fact
// about the agent's transcript, never a transport failure, so the caller stops
// that source and shows the import as stopped instead of retrying.
type ExternalRefusal struct {
	// Reason is the decoder's code: unsupported_version, missing_version,
	// unsupported_record or malformed_record.
	Reason string
	// Line is the 1-based source line the decoder stopped at.
	Line uint64
}

func (r *ExternalRefusal) Error() string {
	return "external transcript refused: " + r.Reason
}

// Sentence is what the conversation shows for a stopped import. The words
// match the app's own reading of the same refusal.
func (r *ExternalRefusal) Sentence() string {
	if r.Reason == "unsupported_version" || r.Reason == "missing_version" {
		return "This session transcript version is not supported."
	}
	return fmt.Sprintf("Session transcript line %d could not be read.", r.Line)
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
	if res.StatusCode == http.StatusUnprocessableEntity {
		var refusal struct {
			Code   string `json:"code"`
			Reason string `json:"reason"`
			Line   uint64 `json:"line"`
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		// Only the four decoder codes with a source line are a refusal. Any
		// other answer is a request the host could not trust, not a verdict.
		if json.Unmarshal(body, &refusal) == nil && refusal.Code == "transcript_refused" && refusal.Line > 0 &&
			oneOf(refusal.Reason, "unsupported_version", "missing_version", "unsupported_record", "malformed_record") {
			return ExternalNormalized{}, &ExternalRefusal{Reason: refusal.Reason, Line: refusal.Line}
		}
	}
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
