package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelprice"
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
	// SelectDeadline bounds the Jev call behind Select; zero means
	// CommandSelectDeadline.
	SelectDeadline time.Duration
}

// CommandSelectDeadline bounds one command selection call: the app waits on
// it before answering a chat message.
const CommandSelectDeadline = 1500 * time.Millisecond

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
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, recommendBodyLimit))
	if err := decodeSingleJSONDocument(decoder, &input); err != nil || !validRecommendationRequest(input) {
		writeRecommendationError(w, http.StatusBadRequest, "request_invalid")
		return
	}
	result, err := h.recommend(r.Context(), user, input)
	if err != nil {
		if errors.Is(err, credits.ErrInsufficient) || errors.Is(err, credits.ErrSealed) {
			writeRecommendationError(w, http.StatusPaymentRequired, modelproxy.OutOfCredit)
		} else if errors.Is(err, modelproxy.ErrSpendCapReached) {
			w.Header().Set("Retry-After", modelproxy.SpendCapRetryAfter)
			writeRecommendationError(w, http.StatusTooManyRequests, "spend_cap_reached")
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

// recommend runs one Jev recommendation, metered to user when the deployment pays.
func (h *RecommendationHandler) recommend(ctx context.Context, user *db.User, input ports.RecommendationRequest) (ports.RecommendationResult, error) {
	var result ports.RecommendationResult
	err := h.metered(ctx, user, func(ctx context.Context) (*ports.RecommendationUsage, error) {
		var err error
		result, err = h.Recommender.Recommend(ctx, input)
		return result.Usage, err
	})
	return result, err
}

// metered runs one Jev call, metered to user when the deployment pays. call
// reports the token count Jev returned, nil when it reported none.
func (h *RecommendationHandler) metered(ctx context.Context, user *db.User, call func(context.Context) (*ports.RecommendationUsage, error)) error {
	if h.Meter == nil {
		_, err := call(ctx)
		return err
	}
	caller := modelproxy.Caller{OwnerType: "user", OwnerID: user.ID, UserID: user.ID, Source: modelproxy.SourceRecommendation}
	maximum := modelproxy.JevMaximum
	_, err := h.Meter.Execute(ctx, caller, modelproxy.Call{Provider: modelproxy.ProviderVercel, Model: modelproxy.JevModel, Maximum: maximum},
		func(ctx context.Context) (modelproxy.Result, error) {
			usage, callErr := call(ctx)
			switch {
			case callErr == nil && usage != nil:
				return modelproxy.Result{Outcome: credits.ModelSucceeded, Usage: modelprice.Usage{InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens}}, nil
			case callErr == nil:
				// An answer without a token count is charged at the request ceiling.
				return modelproxy.Result{Outcome: credits.ModelSucceeded, Usage: maximum}, nil
			case errors.Is(callErr, modelproxy.ErrNotCharged), errors.Is(callErr, ports.ErrModelCredentialMissing):
				return modelproxy.Result{Outcome: credits.ModelFailed}, callErr
			default:
				return modelproxy.Result{Outcome: credits.ModelUnknown}, callErr
			}
		})
	return err
}

// Select asks Jev which offered commands a chat message asks the app to run
// or asks about. Selections are not logged.
func (h *RecommendationHandler) Select(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.Recommender == nil {
		http.Error(w, `{"status":"error","code":"recommend_unavailable"}`, http.StatusNotFound)
		return
	}
	user := middleware.UserFromContext(r.Context())
	if h.Meter != nil && user == nil {
		writeRecommendationError(w, http.StatusUnauthorized, "auth_required")
		return
	}
	var input ports.CommandSelectionRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, recommendBodyLimit))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil || !validCommandSelectionRequest(input) {
		writeRecommendationError(w, http.StatusBadRequest, "request_invalid")
		return
	}
	input.Message = strings.TrimSpace(input.Message)
	deadline := h.SelectDeadline
	if deadline <= 0 {
		deadline = CommandSelectDeadline
	}
	// The deadline bounds the Jev call; metering reserves and settles on the
	// request context so a late answer is still recorded.
	callCtx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	callDeadline, _ := callCtx.Deadline()
	var result ports.CommandSelectionResult
	err := h.metered(r.Context(), user, func(ctx context.Context) (*ports.RecommendationUsage, error) {
		ctx, cancel := context.WithDeadline(ctx, callDeadline)
		defer cancel()
		var err error
		result, err = h.Recommender.SelectCommands(ctx, input)
		if err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) && !errors.Is(err, context.DeadlineExceeded) {
			err = errors.Join(err, context.DeadlineExceeded)
		}
		return result.Usage, err
	})
	if err != nil {
		switch {
		case errors.Is(err, credits.ErrInsufficient), errors.Is(err, credits.ErrSealed):
			writeRecommendationError(w, http.StatusPaymentRequired, modelproxy.OutOfCredit)
		case errors.Is(err, modelproxy.ErrSpendCapReached):
			w.Header().Set("Retry-After", modelproxy.SpendCapRetryAfter)
			writeRecommendationError(w, http.StatusTooManyRequests, "spend_cap_reached")
		case errors.Is(err, ports.ErrModelCredentialMissing):
			writeRecommendationError(w, http.StatusServiceUnavailable, "credential_missing")
		case errors.Is(err, context.DeadlineExceeded):
			writeRecommendationError(w, http.StatusGatewayTimeout, "select_timeout")
		default:
			writeRecommendationError(w, http.StatusBadGateway, "select_failed")
		}
		return
	}
	if strings.TrimSpace(result.Model) == "" {
		writeRecommendationError(w, http.StatusBadGateway, "select_failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"commands": filterSelectedCommands(result.Commands, input.Commands), "model": result.Model})
}

var commandSelectionRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func validCommandSelectionRequest(input ports.CommandSelectionRequest) bool {
	message := strings.TrimSpace(input.Message)
	if message == "" || utf8.RuneCountInString(message) > recommendTextMax || len(input.Tail) > recommendTailMax {
		return false
	}
	for _, message := range input.Tail {
		if message.Role != "user" && message.Role != "assistant" && message.Role != "system" {
			return false
		}
		if utf8.RuneCountInString(message.Text) > recommendTextMax {
			return false
		}
	}
	if input.Repo != nil {
		owner, name, _ := strings.Cut(*input.Repo, "/")
		if !commandSelectionRepo.MatchString(*input.Repo) || strings.Trim(owner, ".") == "" || strings.Trim(name, ".") == "" {
			return false
		}
	}
	if len(input.Commands) == 0 || len(input.Commands) > recommendCommandsMax {
		return false
	}
	names := make(map[string]struct{}, len(input.Commands))
	for _, command := range input.Commands {
		if strings.TrimSpace(command.Name) == "" || utf8.RuneCountInString(command.Name) > recommendNameMax || utf8.RuneCountInString(command.Summary) > recommendSummaryMax {
			return false
		}
		if _, duplicate := names[command.Name]; duplicate {
			return false
		}
		names[command.Name] = struct{}{}
	}
	return true
}

// filterSelectedCommands keeps the offered commands at or above the minimum
// probability, highest first, at most CommandSelectionMax. none is never a
// command.
func filterSelectedCommands(selected []ports.SelectedCommand, offered []ports.RecommendationCommand) []ports.SelectedCommand {
	known := make(map[string]struct{}, len(offered))
	for _, command := range offered {
		known[command.Name] = struct{}{}
	}
	best := make(map[string]float64, len(selected))
	for _, command := range selected {
		if _, ok := known[command.Name]; !ok || command.Name == "none" || !(command.Probability >= ports.CommandSelectionMinProbability) {
			continue
		}
		best[command.Name] = max(best[command.Name], min(command.Probability, 1))
	}
	filtered := make([]ports.SelectedCommand, 0, len(best))
	for name, probability := range best {
		filtered = append(filtered, ports.SelectedCommand{Name: name, Probability: probability})
	}
	sort.Slice(filtered, func(left, right int) bool {
		if filtered[left].Probability != filtered[right].Probability {
			return filtered[left].Probability > filtered[right].Probability
		}
		return filtered[left].Name < filtered[right].Name
	})
	if len(filtered) > ports.CommandSelectionMax {
		filtered = filtered[:ports.CommandSelectionMax]
	}
	return filtered
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
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := decodeSingleJSONDocument(decoder, &input); err != nil || strings.TrimSpace(input.ID) == "" || strings.TrimSpace(input.Command) == "" || len(input.Command) > recommendNameMax {
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
