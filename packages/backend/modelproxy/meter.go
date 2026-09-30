package modelproxy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/modelprice"
)

// Usage sources recorded in model_usage.
const (
	SourceAgentRun  = "agent_run"
	SourceWorkspace = "workspace"
	// SourceRepoGateway names historical rows from the retired box gateway
	// (#2198); nothing records it any more.
	SourceRepoGateway    = "repo_gateway"
	SourceFlowHost       = "flow_host"
	SourceRecommendation = "recommendation"
	// SourceApp is a signed-in app call made with the user's own token.
	SourceApp = "app"
)

var (
	// ErrModelNotOffered refuses a model with no price on this provider.
	ErrModelNotOffered = errors.New("modelproxy: model is not offered on platform keys")
	// ErrNotCharged marks a provider call the provider certainly did not
	// charge: it was refused, or never sent. The reservation is released.
	ErrNotCharged = errors.New("modelproxy: provider did not charge the call")
)

// Caller is who pays for a call and what it is correlated with.
type Caller struct {
	OwnerType     string
	OwnerID       int64
	Source        string
	UserID        int64
	RepositoryID  int64
	WorkspaceID   string
	WorkflowRunID int64
	// Reference names the calling Flow host binding.
	Reference string
}

// Call is one priced model call before it is made.
type Call struct {
	Provider string
	// Model is the model id on the wire.
	Model  string
	Stream bool
	// Maximum is the provider-enforced usage ceiling the bound is priced at.
	Maximum modelprice.Usage
}

// Result is what the provider call reported.
type Result struct {
	Outcome credits.ModelOutcome
	Usage   modelprice.Usage
	// Status is the provider's HTTP status; zero when none was received.
	Status int
}

// Meter reserves, settles and records platform-key model calls.
type Meter struct {
	Ledger credits.Ledger
	// DailyCapNanos caps every owner's platform-key spend per UTC day
	// (DailySpendCapEnv); 0 means no cap. The check is not atomic: calls
	// admitted concurrently each see the same prior spend.
	DailyCapNanos int64
}

// Price resolves the price-table key and price for a model on a provider.
// A price for another provider is refused: the bound would be wrong.
// OpenRouter serves every vendor, so any listed vendor price applies there,
// with an explicit "<model>@openrouter" row taking precedence.
func Price(provider, model string) (string, modelprice.Price, bool) {
	model = strings.TrimSpace(model)
	if model == "" {
		return "", modelprice.Price{}, false
	}
	if provider == ProviderOpenRouter {
		bare := model
		if i := strings.LastIndex(bare, "/"); i >= 0 {
			bare = bare[i+1:]
		}
		if price, ok := modelprice.Table[bare+"@openrouter"]; ok {
			return bare + "@openrouter", price, true
		}
	}
	price, ok := modelprice.Lookup(model)
	if !ok {
		// A dated snapshot id (claude-haiku-4-5-20251001) is its model's price.
		if dated := datedSuffix.FindStringIndex(model); dated != nil {
			model = model[:dated[0]]
			price, ok = modelprice.Lookup(model)
		}
		if !ok {
			return "", modelprice.Price{}, false
		}
	}
	key := model
	if _, exact := modelprice.Table[model]; !exact {
		key = model[strings.LastIndex(model, "/")+1:]
	}
	switch {
	case provider == ProviderOpenRouter && price.Provider != ProviderVercel:
	case price.Provider == provider:
	default:
		return "", modelprice.Price{}, false
	}
	return key, price, true
}

var datedSuffix = regexp.MustCompile(`-20\d{6}$`)

// Bound is the reservation for maximum at the model's price.
func Bound(price modelprice.Price, maximum modelprice.Usage) (int64, error) {
	return modelprice.CostNanos(price, maximum)
}

// Execute reserves the call's bound for the caller's owner, runs spend once,
// settles what spend reports and records the call. spend runs only after the
// reservation and the usage row exist; it must report ModelFailed only when
// the provider cannot have charged the call.
func (m Meter) Execute(ctx context.Context, caller Caller, call Call, spend func(context.Context) (Result, error)) (credits.Reservation, error) {
	if m.Ledger.DB == nil {
		return credits.Reservation{}, errors.New("modelproxy: credit ledger is not configured")
	}
	tableKey, price, ok := Price(call.Provider, call.Model)
	if !ok {
		return credits.Reservation{}, ErrModelNotOffered
	}
	bound, err := Bound(price, call.Maximum)
	if err != nil || bound <= 0 {
		return credits.Reservation{}, fmt.Errorf("modelproxy: invalid bound: %w", errors.Join(err, errors.New("bound must be positive")))
	}
	if m.DailyCapNanos > 0 {
		spent, err := spentToday(ctx, m.Ledger.DB)
		if err != nil {
			return credits.Reservation{}, fmt.Errorf("modelproxy: read today's spend: %w", err)
		}
		if spent > m.DailyCapNanos-bound {
			slog.Error(spendCapLog, "provider", call.Provider, "model", call.Model, "cap", DailySpendCapEnv)
			return credits.Reservation{}, ErrSpendCapReached
		}
	}
	accountID, err := m.Ledger.EnsureAccount(ctx, caller.OwnerType, caller.OwnerID)
	if err != nil {
		return credits.Reservation{}, err
	}
	key := "model:" + uuid.NewString()
	var result Result
	recorded := false
	reservation, callErr := m.Ledger.ExecutePricedModelCall(ctx, accountID, key, tableKey, call.Maximum,
		func(ctx context.Context) (credits.ModelOutcome, modelprice.Usage, error) {
			if err := insertUsage(ctx, m.Ledger.DB, key, accountID, caller, call); err != nil {
				// Nothing reached the provider: release.
				return credits.ModelFailed, modelprice.Usage{}, fmt.Errorf("modelproxy: record usage: %w", err)
			}
			recorded = true
			var spendErr error
			result, spendErr = spend(ctx)
			if result.Outcome == "" {
				result.Outcome = credits.ModelUnknown
			}
			return result.Outcome, result.Usage, spendErr
		})
	if recorded {
		finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		outcome := result.Outcome
		if errors.Is(callErr, credits.ErrOutcomeUnknown) {
			outcome = credits.ModelUnknown
		}
		var cost *int64
		if outcome == credits.ModelSucceeded {
			if n, err := modelprice.CostNanos(price, result.Usage); err == nil {
				cost = &n
			} else {
				outcome = credits.ModelUnknown
			}
		}
		if err := finishUsage(finishCtx, m.Ledger.DB, key, outcome, result, cost); err != nil {
			slog.Error("model usage record not finished", "request_key", key, "error", err)
		}
	}
	return reservation, callErr
}

func insertUsage(ctx context.Context, db *pgxpool.Pool, key string, accountID int64, caller Caller, call Call) error {
	tag, err := db.Exec(ctx, `INSERT INTO model_usage (request_key, credit_account_id, reservation_id, owner_type, owner_id, source,
			user_id, repository_id, workspace_id, workflow_run_id, reference, provider, model, stream, bound_tokens)
		SELECT $1, $2, r.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
		FROM credit_reservations r WHERE r.account_id = $2 AND r.request_key = $1`,
		key, accountID, caller.OwnerType, caller.OwnerID, caller.Source,
		positive(caller.UserID), positive(caller.RepositoryID), nonEmpty(caller.WorkspaceID), positive(caller.WorkflowRunID),
		caller.Reference, call.Provider, strings.TrimSpace(call.Model), call.Stream,
		call.Maximum.PromptTokens()+call.Maximum.OutputTokens)
	if err == nil && tag.RowsAffected() != 1 {
		err = errors.New("reservation not found")
	}
	return err
}

func finishUsage(ctx context.Context, db *pgxpool.Pool, key string, outcome credits.ModelOutcome, result Result, cost *int64) error {
	usage := result.Usage
	if outcome != credits.ModelSucceeded {
		usage = modelprice.Usage{}
	}
	_, err := db.Exec(ctx, `UPDATE model_usage SET outcome = $2, input_tokens = $3, output_tokens = $4,
			cache_read_tokens = $5, cache_write_tokens = $6, cost_nanos = $7, upstream_status = $8, settled_at = now(),
			cache_write_1h_tokens = $9
		WHERE request_key = $1 AND outcome = 'pending'`,
		key, string(outcome), usage.InputTokens, usage.OutputTokens, usage.CacheReadTokens, usage.CacheWriteTokens,
		cost, positive(int64(result.Status)), usage.CacheWrite1hTokens)
	return err
}

func positive(n int64) *int64 {
	if n <= 0 {
		return nil
	}
	return &n
}

func nonEmpty(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}
