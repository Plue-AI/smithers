package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/subscriptiontoken"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// OwnerModels is the Go host for the existing /api/model credential catalog.
// It is mounted by the common backend assembly for local and hosted roles.
type OwnerModels struct {
	Pool   *pgxpool.Pool
	Codec  webhook.SecretCodec
	Tester ModelTester
}

type credentialRow struct {
	Name    string   `json:"name"`
	Present bool     `json:"present"`
	Origins []string `json:"origins"`
	Managed bool     `json:"managed,omitempty"`
}

var builtins = []credentialRow{
	{Name: "ANTHROPIC_API_KEY", Origins: []string{"https://api.anthropic.com"}},
	{Name: "OPENAI_API_KEY", Origins: []string{"https://api.openai.com"}},
	{Name: "CEREBRAS_API_KEY", Origins: []string{"https://api.cerebras.ai"}},
	{Name: "OPENROUTER_API_KEY", Origins: []string{"https://openrouter.ai"}},
	{Name: "AI_GATEWAY_API_KEY", Origins: []string{"https://ai-gateway.vercel.sh"}},
}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

func ownerOf(r *http.Request) int64 {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		return 0
	}
	return user.ID
}

func modelJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func modelBody(r *http.Request, value any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing data")
	}
	return nil
}

func modelOrigin(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Host == "" {
		return "", false
	}
	if u.Scheme == "https" {
		return u.Scheme + "://" + u.Host, true
	}
	if u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "host.docker.internal" || net.ParseIP(u.Hostname()).IsLoopback()) {
		return u.Scheme + "://" + u.Host, true
	}
	return "", false
}

func validCredentialName(name string) bool {
	return len(name) >= 2 && len(name) <= 63 && credentialNamePattern.MatchString(name) && !strings.HasSuffix(name, "ORIGIN")
}

func (s OwnerModels) Catalog(w http.ResponseWriter, r *http.Request) {
	owner := ownerOf(r)
	if owner <= 0 {
		modelJSON(w, http.StatusUnauthorized, map[string]string{"code": "sign_in_required"})
		return
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT name, origin, value_encrypted IS NOT NULL FROM owner_model_credentials WHERE user_id=$1 ORDER BY name`, owner)
	if err != nil {
		modelJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "storage_failed"})
		return
	}
	defer rows.Close()
	credentials := make([]credentialRow, len(builtins))
	copy(credentials, builtins)
	for rows.Next() {
		var name, origin string
		var present bool
		if err = rows.Scan(&name, &origin, &present); err != nil {
			break
		}
		entry := credentialRow{Name: name, Origins: []string{origin}, Present: present, Managed: true}
		found := false
		for i := range credentials {
			if credentials[i].Name == name {
				credentials[i] = entry
				found = true
				break
			}
		}
		if !found {
			credentials = append(credentials, entry)
		}
	}
	if err = rows.Err(); err != nil {
		modelJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "storage_failed"})
		return
	}
	modelJSON(w, http.StatusOK, map[string]any{"models": []any{}, "credentials": credentials, "seats": []string{"chat"}, "enrollment": map[string]bool{"available": true}})
}

type credentialRequest struct {
	Action    string `json:"action"`
	RequestID string `json:"requestId"`
	Name      string `json:"name"`
	Origin    string `json:"origin,omitempty"`
	Value     string `json:"value,omitempty"`
}

func credentialFailure(code string, field ...string) map[string]any {
	failure := map[string]string{"code": code}
	if len(field) > 0 {
		failure["field"] = field[0]
	}
	fault := "user"
	if code == "storage_unavailable" {
		fault = "infra"
	}
	return map[string]any{"ok": false, "failure": failure, "fault": fault}
}

func (s OwnerModels) Credential(w http.ResponseWriter, r *http.Request) {
	owner := ownerOf(r)
	if owner <= 0 {
		modelJSON(w, http.StatusUnauthorized, map[string]string{"code": "sign_in_required"})
		return
	}
	var input credentialRequest
	if err := modelBody(r, &input); err != nil {
		modelJSON(w, http.StatusOK, credentialFailure("invalid", "action"))
		return
	}
	if !requestIDPattern.MatchString(input.RequestID) {
		modelJSON(w, http.StatusOK, credentialFailure("invalid", "requestId"))
		return
	}
	if !validCredentialName(input.Name) {
		modelJSON(w, http.StatusOK, credentialFailure("invalid", "name"))
		return
	}
	if input.Action != "enroll" && input.Action != "rotate" && input.Action != "remove" {
		modelJSON(w, http.StatusOK, credentialFailure("invalid", "action"))
		return
	}
	if input.Action != "remove" && (strings.TrimSpace(input.Value) == "" || len(input.Value) > 8192 || strings.ContainsAny(input.Value, "\r\n\x00")) {
		modelJSON(w, http.StatusOK, credentialFailure("invalid", "value"))
		return
	}
	// A model credential is an API key. A Claude or ChatGPT subscription
	// login is never one; where a deployment allows them, they belong to the
	// provider connections pool (#2222).
	if input.Action != "remove" && subscriptiontoken.Holds(input.Name, input.Value) {
		modelJSON(w, http.StatusOK, credentialFailure("invalid", "value"))
		return
	}
	origin := ""
	if input.Action == "enroll" {
		var ok bool
		origin, ok = modelOrigin(input.Origin)
		if !ok || origin != input.Origin {
			modelJSON(w, http.StatusOK, credentialFailure("invalid", "origin"))
			return
		}
		for _, builtin := range builtins {
			if builtin.Name == input.Name && builtin.Origins[0] != origin {
				modelJSON(w, http.StatusOK, credentialFailure("invalid", "origin"))
				return
			}
		}
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		modelJSON(w, http.StatusOK, credentialFailure("storage_unavailable"))
		return
	}
	defer tx.Rollback(context.WithoutCancel(r.Context()))
	// Serialize an owner's receipts so a retry with the same request ID sees
	// the first committed result, including when both requests arrive together.
	var lockedOwner int64
	if err := tx.QueryRow(r.Context(), `SELECT id FROM users WHERE id=$1 FOR UPDATE`, owner).Scan(&lockedOwner); err != nil {
		modelJSON(w, http.StatusOK, credentialFailure("storage_unavailable"))
		return
	}
	var recorded json.RawMessage
	err = tx.QueryRow(r.Context(), `SELECT result FROM owner_model_credential_receipts WHERE user_id=$1 AND request_id=$2`, owner, input.RequestID).Scan(&recorded)
	if err == nil {
		modelJSON(w, http.StatusOK, recorded)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		modelJSON(w, http.StatusOK, credentialFailure("storage_unavailable"))
		return
	}
	var priorOrigin string
	var priorPresent bool
	err = tx.QueryRow(r.Context(), `SELECT origin, value_encrypted IS NOT NULL FROM owner_model_credentials WHERE user_id=$1 AND name=$2 FOR UPDATE`, owner, input.Name).Scan(&priorOrigin, &priorPresent)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		modelJSON(w, http.StatusOK, credentialFailure("storage_unavailable"))
		return
	}
	// A removed credential keeps its row with no value; enrolling it again is
	// the recovery path the catalog offers.
	if input.Action == "enroll" && err == nil && priorPresent {
		modelJSON(w, http.StatusOK, credentialFailure("exists"))
		return
	}
	if input.Action != "enroll" && errors.Is(err, pgx.ErrNoRows) {
		modelJSON(w, http.StatusOK, credentialFailure("unknown"))
		return
	}
	if input.Action != "enroll" {
		origin = priorOrigin
	}
	var encrypted *string
	if input.Action != "remove" {
		value, sealErr := s.Codec.EncryptString(input.Value)
		if sealErr != nil {
			modelJSON(w, http.StatusOK, credentialFailure("storage_unavailable"))
			return
		}
		encrypted = &value
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO owner_model_credentials (user_id,name,origin,value_encrypted) VALUES ($1,$2,$3,$4)
		ON CONFLICT (user_id,name) DO UPDATE SET origin=EXCLUDED.origin,value_encrypted=EXCLUDED.value_encrypted`, owner, input.Name, origin, encrypted)
	if err != nil {
		modelJSON(w, http.StatusOK, credentialFailure("storage_unavailable"))
		return
	}
	result := map[string]any{"ok": true, "credential": credentialRow{Name: input.Name, Origins: []string{origin}, Present: encrypted != nil, Managed: true}}
	_, err = tx.Exec(r.Context(), `INSERT INTO owner_model_credential_receipts (user_id,request_id,result) VALUES ($1,$2,$3)`, owner, input.RequestID, result)
	if err != nil || tx.Commit(r.Context()) != nil {
		modelJSON(w, http.StatusOK, credentialFailure("storage_unavailable"))
		return
	}
	modelJSON(w, http.StatusOK, result)
}

func (s OwnerModels) CredentialReceipt(w http.ResponseWriter, r *http.Request) {
	owner := ownerOf(r)
	if owner <= 0 {
		modelJSON(w, http.StatusUnauthorized, map[string]string{"code": "sign_in_required"})
		return
	}
	var result json.RawMessage
	err := s.Pool.QueryRow(r.Context(), `SELECT result FROM owner_model_credential_receipts WHERE user_id=$1 AND request_id=$2`, owner, r.URL.Query().Get("id")).Scan(&result)
	if errors.Is(err, pgx.ErrNoRows) {
		modelJSON(w, http.StatusOK, map[string]string{"state": "unknown"})
		return
	}
	if err != nil {
		modelJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "storage_failed"})
		return
	}
	modelJSON(w, http.StatusOK, map[string]any{"state": "completed", "result": result})
}

type defaultModelRequest struct {
	Model json.RawMessage `json:"model"`
}

func (s OwnerModels) SetDefault(w http.ResponseWriter, r *http.Request) {
	owner := ownerOf(r)
	if owner <= 0 {
		modelJSON(w, http.StatusUnauthorized, map[string]string{"code": "sign_in_required"})
		return
	}
	var input defaultModelRequest
	if err := modelBody(r, &input); err != nil {
		modelJSON(w, http.StatusBadRequest, map[string]string{"code": "request_invalid"})
		return
	}
	if string(input.Model) == "null" {
		_, err := s.Pool.Exec(r.Context(), `DELETE FROM owner_model_defaults WHERE user_id=$1`, owner)
		if err != nil {
			modelJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "storage_failed"})
			return
		}
		modelJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	var binding struct {
		Protocol   string `json:"protocol"`
		ModelID    string `json:"modelId"`
		Credential string `json:"credential"`
		BaseURL    string `json:"baseUrl"`
	}
	if json.Unmarshal(input.Model, &binding) != nil ||
		(binding.Protocol != "openai-chat" && binding.Protocol != "openai-responses" && binding.Protocol != "anthropic-messages") ||
		binding.ModelID == "" || len(binding.ModelID) > 256 || !validCredentialName(binding.Credential) {
		modelJSON(w, http.StatusBadRequest, map[string]string{"code": "request_invalid"})
		return
	}
	_, err := s.Pool.Exec(r.Context(), `INSERT INTO owner_model_defaults(user_id,model) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET model=EXCLUDED.model`, owner, input.Model)
	if err != nil {
		modelJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "storage_failed"})
		return
	}
	modelJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s OwnerModels) Default(w http.ResponseWriter, r *http.Request) {
	owner := ownerOf(r)
	if owner <= 0 {
		modelJSON(w, http.StatusUnauthorized, map[string]string{"code": "sign_in_required"})
		return
	}
	var model json.RawMessage
	err := s.Pool.QueryRow(r.Context(), `SELECT model FROM owner_model_defaults WHERE user_id=$1`, owner).Scan(&model)
	if errors.Is(err, pgx.ErrNoRows) {
		modelJSON(w, http.StatusOK, map[string]any{"model": nil})
		return
	}
	if err != nil {
		modelJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "storage_failed"})
		return
	}
	modelJSON(w, http.StatusOK, map[string]any{"model": model})
}
