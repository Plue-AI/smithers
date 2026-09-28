package modelhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode"

	"github.com/smithersai/smithers/packages/backend/ports"
)

var ErrModelTestInvalid = errors.New("model test request is invalid")

var modelTestIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
var modelTestModelIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$`)

// This checks the ConfiguredModel wire before owner credential lookup. The
// packaged host remains responsible for the full input schema and planner.
func validModelTestRecord(raw json.RawMessage) bool {
	var model struct {
		ID         string  `json:"id"`
		Protocol   string  `json:"protocol"`
		ModelID    string  `json:"modelId"`
		Credential string  `json:"credential"`
		BaseURL    *string `json:"baseUrl"`
		Path       *string `json:"path"`
		Builtin    *bool   `json:"builtin"`
	}
	decode := json.NewDecoder(bytes.NewReader(raw))
	decode.DisallowUnknownFields()
	if decode.Decode(&model) != nil {
		return false
	}
	var trailing any
	if !errors.Is(decode.Decode(&trailing), io.EOF) {
		return false
	}
	if !modelTestIDPattern.MatchString(model.ID) || model.ID == "default" ||
		!modelTestModelIDPattern.MatchString(model.ModelID) || !validCredentialName(model.Credential) {
		return false
	}
	switch model.Protocol {
	case "anthropic-messages", "openai-responses", "openai-chat", "evaluation":
	default:
		return false
	}
	for _, field := range []*string{model.BaseURL, model.Path} {
		if field != nil && (*field == "" || strings.IndexFunc(*field, unicode.IsSpace) >= 0) {
			return false
		}
	}
	if model.BaseURL != nil && len(*model.BaseURL) > 512 {
		return false
	}
	if model.Path != nil && len(*model.Path) > 256 {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	for _, key := range []string{"baseUrl", "path", "builtin"} {
		if value, present := fields[key]; present && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return true
}

// ModelTester runs one owner-scoped call on the same private provider host as chat.
type ModelTester interface {
	RunModelTest(context.Context, int64, json.RawMessage) (json.RawMessage, error)
}

func modelTestFailed(code string, detail map[string]any, fault string) map[string]any {
	detail["code"] = code
	return map[string]any{"ok": false, "latencyMs": 0, "failure": detail, "fault": fault}
}

// Test accepts the existing {model,input?} wire. A provider failure is a
// typed HTTP 200 result; authentication and malformed requests are refusals.
func (s OwnerModels) Test(w http.ResponseWriter, r *http.Request) {
	owner := ownerOf(r)
	if owner <= 0 {
		modelJSON(w, http.StatusUnauthorized, map[string]string{"code": "sign_in_required"})
		return
	}
	var input struct {
		Model json.RawMessage `json:"model"`
		Input json.RawMessage `json:"input,omitempty"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64<<10+1))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&input)
	var trailing any
	if decodeErr != nil || !errors.Is(decoder.Decode(&trailing), io.EOF) || !validModelTestRecord(input.Model) {
		modelJSON(w, http.StatusBadRequest, map[string]string{"code": "request_invalid"})
		return
	}
	if s.Tester == nil {
		modelJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "model_host_unavailable"})
		return
	}
	body, err := json.Marshal(input)
	if err != nil {
		modelJSON(w, http.StatusBadRequest, map[string]string{"code": "request_invalid"})
		return
	}
	result, err := s.Tester.RunModelTest(r.Context(), owner, body)
	if errors.Is(err, ErrModelTestInvalid) {
		modelJSON(w, http.StatusBadRequest, map[string]string{"code": "request_invalid"})
		return
	}
	if errors.Is(err, ports.ErrModelCredentialMissing) {
		var model struct {
			Credential string `json:"credential"`
		}
		_ = json.Unmarshal(input.Model, &model)
		if validCredentialName(model.Credential) {
			modelJSON(w, http.StatusOK, modelTestFailed("credential_missing", map[string]any{"credential": model.Credential}, "user"))
			return
		}
	}
	if err != nil {
		modelJSON(w, http.StatusOK, modelTestFailed("unreachable", map[string]any{}, "dependency"))
		return
	}
	if !json.Valid(result) || len(result) > 64<<10 {
		modelJSON(w, http.StatusOK, modelTestFailed("unreachable", map[string]any{}, "dependency"))
		return
	}
	modelJSON(w, http.StatusOK, json.RawMessage(result))
}

// RunModelTest resolves the caller's credential, launches a private packaged
// host, and forwards the contract unchanged. The secret stays in its process
// environment; only the private bearer token crosses this request.
func (host *Host) RunModelTest(ctx context.Context, ownerID int64, request json.RawMessage) (result json.RawMessage, runErr error) {
	if ownerID <= 0 || !json.Valid(request) {
		return nil, ErrModelTestInvalid
	}
	binding, err := host.resolver.ResolveChatModel(ctx, ownerID, 0, request)
	if err != nil {
		return nil, err
	}
	grant := ports.ChatTurnGrant{OwnerID: ownerID, TurnID: "model-test", ProducerBaseURL: "http://127.0.0.1"}
	lease, err := host.launcher.LaunchChatHost(ctx, grant, binding)
	if err != nil {
		return nil, err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		runErr = errors.Join(runErr, lease.Close(cleanupCtx))
	}()
	baseURL, client, token := leaseEndpoint(lease)
	private, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1/model/test", bytes.NewReader(request))
	if err != nil {
		return nil, err
	}
	private.Header.Set("Content-Type", "application/json")
	private.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(private)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusBadRequest {
		return nil, ErrModelTestInvalid
	}
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("private model test refused")
	}
	result, err = io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil {
		return nil, err
	}
	if len(result) > 64<<10 {
		return nil, errors.New("private model test response too large")
	}
	return result, nil
}
