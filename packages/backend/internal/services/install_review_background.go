package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

const reviewOperation = "install.review"

// ReviewMachine runs the ordinary pinned flow through the shared engine. It
// owns an ephemeral microVM at Admission.Head, never a person's working copy.
// Prepare verifies the pinned source and shared root-input boundary without
// allocating a machine. Start and Retire reconcile the stable operation ID
// after a lost reply; neither may create a TODO or carry GitHub write authority.
type ReviewMachine interface {
	Isolation() workspace.IsolationLevel
	Prepare(context.Context, ReviewAdmission) error
	Start(context.Context, string, ReviewAdmission) (string, error)
	Observe(context.Context, string, ReviewAdmission) (ReviewObservation, error)
	Retire(context.Context, string, ReviewAdmission) error
}

type ReviewObservation struct {
	State jobs.State `json:"state"`
	// Change is the retained change-card payload from the review flow, not PR text.
	Change json.RawMessage `json:"change,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// ReviewDelivery persists a change card in the admitted conversation. The ID
// is the durable operation ID, so replay replaces rather than duplicates it.
type ReviewDelivery interface {
	Ready(context.Context, ReviewAdmission) error
	Deliver(context.Context, string, ReviewAdmission, json.RawMessage) error
}

type ReviewBackground struct {
	service  *MythicalService
	store    *jobs.Store
	machine  ReviewMachine
	delivery ReviewDelivery
}

type reviewJob struct {
	Request   ReviewRequest   `json:"request"`
	Admission ReviewAdmission `json:"admission"`
}
type reviewCheckpoint struct {
	Started bool               `json:"started,omitempty"`
	Run     string             `json:"run,omitempty"`
	Result  *ReviewObservation `json:"result,omitempty"`
}

func NewReviewBackground(pool *pgxpool.Pool, service *MythicalService, machine ReviewMachine, delivery ReviewDelivery) (*ReviewBackground, error) {
	if service == nil || machine == nil || delivery == nil {
		return nil, reviewUnavailable("review_delivery_unavailable")
	}
	if machine.Isolation() != workspace.IsolationSandboxed {
		return nil, reviewUnavailable("review_isolation_unavailable")
	}
	store, err := jobs.NewStore(pool)
	if err != nil {
		return nil, err
	}
	return &ReviewBackground{service: service, store: store, machine: machine, delivery: delivery}, nil
}

func (s *MythicalService) SetReviewBackground(background *ReviewBackground) { s.reviews = background }

func (b *ReviewBackground) admit(ctx context.Context, admission ReviewAdmission, request ReviewRequest) (ReviewAdmission, error) {
	// Readiness must fail before any runtime allocation or durable acceptance.
	if err := b.machine.Prepare(ctx, admission); err != nil {
		return ReviewAdmission{}, err
	}
	if err := b.delivery.Ready(ctx, admission); err != nil {
		return ReviewAdmission{}, err
	}
	tx, err := b.service.store.Begin(ctx)
	if err != nil {
		return ReviewAdmission{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	result, err := b.admitInTx(ctx, tx, admission, request)
	if err != nil {
		return ReviewAdmission{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ReviewAdmission{}, err
	}
	return result, nil
}

// admitInTx shares the person's confirmation transaction: a job and an
// approved card either both commit, or neither does.
func (b *ReviewBackground) admitInTx(ctx context.Context, tx pgx.Tx, admission ReviewAdmission, request ReviewRequest) (ReviewAdmission, error) {
	// The request's own decision stays bound to its credential: the door or the
	// person's Confirm press made it. Under the repository lock only credential
	// and membership liveness are refreshed, as for every install write.
	decision, err := Authorize(ctx, db.New(tx), "review")
	if err != nil {
		return ReviewAdmission{}, err
	}
	if decision.UserID != admission.RequesterID {
		return ReviewAdmission{}, reviewNonMember()
	}
	repository := admission.RepositoryID
	if err = guardInstallMemberCredential(ctx, tx, repository, admission.RequesterID, true); err != nil {
		return ReviewAdmission{}, err
	}
	// Another admission may have selected its pin while we waited for the repository lock.
	existing, lookupErr := b.store.GetByRequestInTx(ctx, tx, reviewScope(repository, admission.RequesterID), reviewOperation, admission.IdempotencyKey)
	if lookupErr == nil {
		var previous reviewJob
		if json.Unmarshal(existing.Payload, &previous) != nil {
			return ReviewAdmission{}, reviewUnavailable("review_record_invalid")
		}
		if previous.Request != request {
			return ReviewAdmission{}, todoRequestMismatch()
		}
		result := previous.Admission
		result.OperationID, result.State = existing.ID, existing.State
		return result, nil
	}
	if !errors.Is(lookupErr, jobs.ErrNotFound) {
		return ReviewAdmission{}, lookupErr
	}
	// Serialize author removal with acceptance as well as requester revocation.
	if _, err = tx.Exec(ctx, `SELECT 1 FROM users WHERE id=$1 FOR SHARE`, admission.AuthorID); err != nil {
		return ReviewAdmission{}, err
	}
	if _, err = tx.Exec(ctx, `SELECT 1 FROM collaborators WHERE repository_id=$1 AND user_id=$2 FOR SHARE`, repository, admission.AuthorID); err != nil {
		return ReviewAdmission{}, err
	}
	consumer := *b.service
	consumer.store = tx
	if err = consumer.reviewMembers(ctx, admission); err != nil {
		return ReviewAdmission{}, err
	}
	payload, _ := json.Marshal(reviewJob{Request: request, Admission: admission})
	credential, _ := json.Marshal(middleware.CredentialOf(middleware.AuthInfoFromContext(ctx)))
	receipt, err := b.store.AdmitInTx(ctx, tx, jobs.Admission{Scope: reviewScope(repository, admission.RequesterID), Operation: reviewOperation, RequestID: admission.IdempotencyKey, Payload: payload, AuthorizationContext: credential, EffectPolicy: jobs.EffectIdempotent})
	if errors.Is(err, jobs.ErrPayloadConflict) {
		return ReviewAdmission{}, todoRequestMismatch()
	}
	if err != nil {
		return ReviewAdmission{}, err
	}
	admission.OperationID, admission.State = receipt.OperationID, receipt.State
	return admission, nil
}

func (b *ReviewBackground) RunWorker(ctx context.Context, config jobs.WorkerConfig) error {
	config.Operations = []string{reviewOperation}
	return b.store.RunWorker(ctx, config, b.handle)
}

func (b *ReviewBackground) handle(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var job reviewJob
	if err := json.Unmarshal(claim.Payload, &job); err != nil {
		return lease.Fail(ctx, json.RawMessage(`{"code":"review_record_invalid"}`))
	}
	var checkpoint reviewCheckpoint
	if len(claim.ExternalReceipt) > 0 {
		if err := json.Unmarshal(claim.ExternalReceipt, &checkpoint); err != nil {
			return err
		}
	}
	admission := job.Admission
	// Existing journals recorded the old start marker before the run ID.
	// Keep that history recoverable without writing the old marker again.
	if !checkpoint.Started && len(claim.ExternalReceipt) > 0 {
		var legacy struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(claim.ExternalReceipt, &legacy) == nil && legacy.Kind == "review" {
			checkpoint.Started = true
		}
	}
	refuse := func() error {
		// Start may have succeeded even though its response was lost. Cleanup
		// uses the stable operation ID; revocation grants no new launch authority.
		if checkpoint.Started || checkpoint.Run != "" {
			if err := b.machine.Retire(ctx, claim.OperationID, admission); err != nil {
				return err
			}
		}
		return lease.Fail(ctx, json.RawMessage(`{"class":"permission","code":"permission"}`))
	}
	// Recheck live authority on observation and delivery recovery as well as launch.
	var credential middleware.Credential
	if err := json.Unmarshal(claim.AuthorizationContext, &credential); err != nil {
		return err
	}
	info, err := middleware.ReloadCredential(ctx, b.service.queries(), credential, time.Now())
	if err != nil && !errors.Is(err, middleware.ErrCredentialGone) {
		return err
	}
	if errors.Is(err, middleware.ErrCredentialGone) || !middleware.BindInstallCredential(info) || info.User.ID != admission.RequesterID {
		return refuse()
	}
	bound := middleware.ContextWithAuthInfo(ctx, info)
	if _, err := Authorize(bound, b.service.queries(), "review"); err != nil {
		var access *AccessError
		if errors.As(err, &access) && access.Class == "infra" {
			return err
		}
		return refuse()
	}
	if err := b.service.reviewMembers(ctx, admission); err != nil {
		var refusal *TodoControlError
		if errors.As(err, &refusal) && refusal.Class == "permission" {
			return refuse()
		}
		return err
	}
	// A settled start (Result without Run) replays to retirement, never Start.
	if checkpoint.Run == "" && checkpoint.Result == nil {
		if err := b.machine.Prepare(ctx, admission); err != nil {
			return err
		}
		if err := b.delivery.Ready(ctx, admission); err != nil {
			return err
		}
		checkpoint.Started = true
		start, _ := json.Marshal(checkpoint)
		if err := lease.StartExternal(ctx, start); err != nil {
			return err
		}
		run, err := b.machine.Start(ctx, claim.OperationID, admission)
		var terminal flowruntime.Failure
		switch {
		case errors.As(err, &terminal) && !terminal.FlowRuntimeRetryable():
			// A host that exhausted its starts has released its machine.
			// Settle failed rather than boot the machine again on every retry.
			checkpoint.Result = &ReviewObservation{State: jobs.StateFailed, Error: terminal.FlowRuntimeCode()}
		case err != nil:
			return err
		case run == "":
			return errors.New("review machine returned no run")
		default:
			checkpoint.Run = run
		}
		raw, _ := json.Marshal(checkpoint)
		if _, err := lease.Checkpoint(ctx, raw); err != nil {
			return err
		}
	}
	if checkpoint.Result == nil {
		observation, err := b.machine.Observe(ctx, checkpoint.Run, admission)
		if err != nil {
			return err
		}
		if !observation.State.Terminal() {
			raw, _ := json.Marshal(checkpoint)
			return lease.Defer(ctx, raw, time.Second)
		}
		if observation.State == jobs.StateCompleted && (!json.Valid(observation.Change) || string(observation.Change) == "null" || len(observation.Change) == 0) {
			observation = ReviewObservation{State: jobs.StateFailed, Error: "review_findings_missing"}
		}
		checkpoint.Result = &observation
		raw, _ := json.Marshal(checkpoint)
		if _, err := lease.Checkpoint(ctx, raw); err != nil {
			return err
		}
	}
	// Retirement is reconciled before the terminal receipt. A crash or delivery
	// failure replays this checkpoint without relaunching or observing again.
	if err := b.machine.Retire(ctx, claim.OperationID, admission); err != nil {
		return err
	}
	result := checkpoint.Result
	if result.State == jobs.StateCompleted {
		if err := b.delivery.Deliver(ctx, claim.OperationID, admission, result.Change); err != nil {
			return err
		}
	}
	raw, _ := json.Marshal(result)
	if result.State == jobs.StateCompleted {
		return lease.Complete(ctx, raw)
	}
	if result.State == jobs.StateCancelled {
		return lease.ExternalCancelled(ctx, raw)
	}
	return lease.Fail(ctx, raw)
}

// homeRuns projects the durable review requests onto the existing Home card.
func (b *ReviewBackground) homeRuns(ctx context.Context, repository int64) ([]map[string]any, error) {
	rows, err := b.service.store.Query(ctx, `SELECT id::text,state,payload FROM product_job_requests WHERE tenant_id=$1 AND operation=$2 AND state NOT IN ('completed','cancelled') ORDER BY created_at,id`, fmt.Sprintf("repository:%d", repository), reviewOperation)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, state string
		var payload []byte
		if err := rows.Scan(&id, &state, &payload); err != nil {
			return nil, err
		}
		var job reviewJob
		if err := json.Unmarshal(payload, &job); err != nil {
			return nil, err
		}
		if job.Admission.RepositoryID != repository || job.Admission.Number <= 0 {
			return nil, errors.New("invalid durable review admission")
		}
		switch state {
		case "accepted", "dispatching":
			state = "queued"
		case "uncertain":
			state = "failed"
		case "running", "waiting", "failed":
		default:
			return nil, fmt.Errorf("invalid review state %q", state)
		}
		run := map[string]any{"id": id, "title": fmt.Sprintf("Review · #%d", job.Admission.Number), "state": state, "actions": []any{}}
		if queue, ok := b.machine.(interface{ QueuePosition(string) int }); ok {
			if position := queue.QueuePosition(id); position > 0 {
				run["state"] = "waiting"
				run["detail"] = fmt.Sprintf("waiting for a machine #%d", position)
			}
		}
		result = append(result, run)
	}
	return result, rows.Err()
}
