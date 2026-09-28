package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type PublicRepositoryCatalogSource interface {
	ListPublicRepositoryCatalog(context.Context) ([]db.PublicRepository, error)
}

type PublicRepositoryCatalogHandler struct{ Source PublicRepositoryCatalogSource }

func NewPublicRepositoryCatalog(source PublicRepositoryCatalogSource) *PublicRepositoryCatalogHandler {
	return &PublicRepositoryCatalogHandler{Source: source}
}

func (h *PublicRepositoryCatalogHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodHead {
		return
	}
	if h.Source == nil {
		http.Error(w, `{"status":"error","code":"catalog_unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	rows, err := h.Source.ListPublicRepositoryCatalog(r.Context())
	if err != nil {
		http.Error(w, `{"status":"error","code":"catalog_unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	repos := make([]map[string]string, 0, len(rows))
	for _, row := range rows {
		entry := map[string]string{"name": row.Name, "title": row.Title, "url": row.URL}
		if strings.TrimSpace(row.Summary) != "" {
			entry["summary"] = row.Summary
		}
		repos = append(repos, entry)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"repos": repos, "comingSoon": []any{}})
}

// RecommendationHandler asks the decision model (Jev) for the next commands.
// With a Meter (a deployment that pays for Jev), every call is metered to the
// signed-in user; a single-owner installation runs Jev on its owner's key.
type RecommendationHandler struct {
	Recommender ports.Recommender
	Log         ports.RecommendationLog
	Meter       *modelproxy.Meter
}

func NewRecommendationHandler(recommender ports.Recommender, log ports.RecommendationLog, meter *modelproxy.Meter) *RecommendationHandler {
	return &RecommendationHandler{Recommender: recommender, Log: log, Meter: meter}
}

const (
	recommendBodyLimit   = 256 << 10
	recommendTailMax     = 12
	recommendTextMax     = 4000
	recommendCommandsMax = 300
	recommendNameMax     = 160
	recommendSummaryMax  = 512
)

func (h *RecommendationHandler) Recommend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.Recommender == nil || h.Log == nil {
		http.Error(w, `{"status":"error","code":"recommend_unavailable"}`, http.StatusNotFound)
		return
	}
	user := middleware.UserFromContext(r.Context())
	if h.Meter != nil && user == nil {
		// A platform-key call needs a payer.
		writeRecommendationError(w, http.StatusUnauthorized, "auth_required")
		return
	}
	var input ports.RecommendationRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, recommendBodyLimit+1))
	if err := decoder.Decode(&input); err != nil || !validRecommendationRequest(input) {
		writeRecommendationError(w, http.StatusBadRequest, "request_invalid")
		return
	}
	result, err := h.recommend(r.Context(), user, input)
	if err != nil {
		if errors.Is(err, credits.ErrInsufficient) || errors.Is(err, credits.ErrSealed) {
			writeRecommendationError(w, http.StatusPaymentRequired, modelproxy.OutOfCredit)
		} else if errors.Is(err, ports.ErrModelCredentialMissing) {
			writeRecommendationError(w, http.StatusServiceUnavailable, "credential_missing")
		} else {
			writeRecommendationError(w, http.StatusBadGateway, "recommend_failed")
		}
		return
	}
	result.Commands = filterRecommendationCommands(result.Commands, input.Commands)
	if strings.TrimSpace(result.Model) == "" {
		writeRecommendationError(w, http.StatusBadGateway, "recommend_failed")
		return
	}
	tailBytes, _ := json.Marshal(input.Tail)
	digest := sha256.Sum256(tailBytes)
	id, err := h.Log.AppendRecommendation(r.Context(), input, result, hex.EncodeToString(digest[:]))
	if err != nil {
		writeRecommendationError(w, http.StatusServiceUnavailable, "recommend_log_unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "commands": result.Commands, "model": result.Model})
}

// recommend runs one Jev call, metered to user when the deployment pays.
func (h *RecommendationHandler) recommend(ctx context.Context, user *db.User, input ports.RecommendationRequest) (ports.RecommendationResult, error) {
	if h.Meter == nil {
		return h.Recommender.Recommend(ctx, input)
	}
	var result ports.RecommendationResult
	caller := modelproxy.Caller{OwnerType: "user", OwnerID: user.ID, UserID: user.ID, Source: modelproxy.SourceRecommendation}
	_, err := h.Meter.Execute(ctx, caller, modelproxy.Call{Provider: modelproxy.ProviderVercel, Model: modelproxy.JevModel},
		func(ctx context.Context) (modelproxy.Result, error) {
			var callErr error
			result, callErr = h.Recommender.Recommend(ctx, input)
			switch {
			case callErr == nil:
				return modelproxy.Result{Outcome: credits.ModelSucceeded}, nil
			case errors.Is(callErr, modelproxy.ErrNotCharged), errors.Is(callErr, ports.ErrModelCredentialMissing):
				return modelproxy.Result{Outcome: credits.ModelFailed}, callErr
			default:
				return modelproxy.Result{Outcome: credits.ModelUnknown}, callErr
			}
		})
	return result, err
}

func (h *RecommendationHandler) Outcome(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.Log == nil {
		http.Error(w, `{"status":"error","code":"recommend_unavailable"}`, http.StatusNotFound)
		return
	}
	var input struct {
		ID      string `json:"id"`
		Command string `json:"command"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4<<10))
	if err := decoder.Decode(&input); err != nil || strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.Command) == "" || len(input.Command) > recommendNameMax {
		writeRecommendationError(w, http.StatusBadRequest, "request_invalid")
		return
	}
	status, err := h.Log.RecordRecommendationOutcome(r.Context(), input.ID, input.Command, time.Now().UTC())
	if err != nil {
		writeRecommendationError(w, http.StatusServiceUnavailable, "recommend_log_unavailable")
		return
	}
	switch status {
	case http.StatusNoContent:
		w.WriteHeader(http.StatusNoContent)
	case http.StatusNotFound:
		writeRecommendationError(w, http.StatusNotFound, "recommendation_not_found")
	case http.StatusConflict:
		writeRecommendationError(w, http.StatusConflict, "recommendation_already_recorded")
	default:
		writeRecommendationError(w, http.StatusInternalServerError, "recommend_log_unavailable")
	}
}

func validRecommendationRequest(input ports.RecommendationRequest) bool {
	if len(input.Tail) > recommendTailMax || len(input.Commands) > recommendCommandsMax {
		return false
	}
	textSize := 0
	for _, message := range input.Tail {
		if message.Role != "user" && message.Role != "assistant" && message.Role != "system" {
			return false
		}
		textSize += len(message.Text)
	}
	if textSize > recommendTextMax {
		return false
	}
	for _, command := range input.Commands {
		if strings.TrimSpace(command.Name) == "" || len(command.Name) > recommendNameMax || len(command.Summary) > recommendSummaryMax {
			return false
		}
	}
	if len(input.Model) > 0 {
		var binding struct {
			ModelID string `json:"modelId"`
		}
		if json.Unmarshal(input.Model, &binding) != nil || strings.TrimSpace(binding.ModelID) != ports.RecommendationModelID {
			return false
		}
	}
	return true
}

func filterRecommendationCommands(names []string, offered []ports.RecommendationCommand) []string {
	known := make(map[string]struct{}, len(offered))
	for _, command := range offered {
		known[command.Name] = struct{}{}
	}
	filtered := make([]string, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if _, ok := known[name]; !ok {
			continue
		}
		duplicate := false
		for _, existing := range filtered {
			duplicate = duplicate || existing == name
		}
		if !duplicate && len(filtered) < 5 {
			filtered = append(filtered, name)
		}
	}
	return filtered
}

func writeRecommendationError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "error", "code": code})
}

type ModelStreamHandler struct{ Host ports.ModelStreamHost }

func NewModelStreamHandler(host ports.ModelStreamHost) *ModelStreamHandler {
	return &ModelStreamHandler{Host: host}
}

func (h *ModelStreamHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := middleware.UserFromContext(r.Context())
	if user == nil || user.ID <= 0 {
		writeRecommendationError(w, http.StatusUnauthorized, "sign_in_required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20+1))
	if err != nil || len(body) == 0 || len(body) > 2<<20 {
		writeRecommendationError(w, http.StatusBadRequest, "request_invalid")
		return
	}
	// Validate the JSON envelope here; the model host owns its request schema.
	// Raw fields preserve numbers and original bytes at the host port boundary.
	var object map[string]json.RawMessage
	if err := json.Unmarshal(body, &object); err != nil || object == nil {
		writeRecommendationError(w, http.StatusBadRequest, "request_invalid")
		return
	}
	stream, err := h.Host.RunModelStream(r.Context(), ports.ModelStreamGrant{OwnerID: user.ID, Request: body})
	if err != nil {
		if errors.Is(err, ports.ErrModelRequestInvalid) {
			writeRecommendationError(w, http.StatusBadRequest, "request_invalid")
		} else if errors.Is(err, ports.ErrModelCredentialMissing) {
			writeRecommendationError(w, http.StatusServiceUnavailable, "credential_missing")
		} else {
			writeRecommendationError(w, http.StatusBadGateway, "model_unavailable")
		}
		return
	}
	defer stream.Close()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.Copy(w, stream)
}
