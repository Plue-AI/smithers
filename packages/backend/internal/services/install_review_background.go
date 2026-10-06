package services

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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
	Run    string             `json:"run,omitempty"`
	Result *ReviewObservation `json:"result,omitempty"`
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
	bound, repository, err := lockInstallWriteCredential(ctx, tx, middleware.AuthInfoFromContext(ctx))
	if err != nil {
		return ReviewAdmission{}, err
	}
	if repository != admission.RepositoryID {
		return ReviewAdmission{}, reviewNonMember()
	}
	decision, err := Authorize(bound, db.New(tx), "review")
	if err != nil {
		return ReviewAdmission{}, err
	}
	if decision.UserID != admission.RequesterID {
		return ReviewAdmission{}, reviewNonMember()
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
	if err = b.service.reviewMembers(ctx, admission); err != nil {
		return ReviewAdmission{}, err
	}
	payload, _ := json.Marshal(reviewJob{Request: request, Admission: admission})
	credential, _ := json.Marshal(middleware.CredentialOf(middleware.AuthInfoFromContext(bound)))
	receipt, err := b.store.AdmitInTx(ctx, tx, jobs.Admission{Scope: reviewScope(repository, admission.RequesterID), Operation: reviewOperation, RequestID: admission.IdempotencyKey, Payload: payload, AuthorizationContext: credential, EffectPolicy: jobs.EffectIdempotent})
	if errors.Is(err, jobs.ErrPayloadConflict) {
		return ReviewAdmission{}, todoRequestMismatch()
	}
	if err != nil {
		return ReviewAdmission{}, err
	}
	if err = tx.Commit(ctx); err != nil {
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
	if checkpoint.Run == "" {
		var credential middleware.Credential
		if err := json.Unmarshal(claim.AuthorizationContext, &credential); err != nil {
			return err
		}
		info, err := middleware.ReloadCredential(ctx, b.service.queries(), credential, time.Now())
		if err != nil && !errors.Is(err, middleware.ErrCredentialGone) {
			return err
		}
		if errors.Is(err, middleware.ErrCredentialGone) || !middleware.BindInstallCredential(info) || info.User.ID != admission.RequesterID {
			return lease.Fail(ctx, json.RawMessage(`{"class":"permission","code":"permission"}`))
		}
		bound := middleware.ContextWithAuthInfo(ctx, info)
		if _, err := Authorize(bound, b.service.queries(), "review"); err != nil {
			return lease.Fail(ctx, json.RawMessage(`{"class":"permission","code":"permission"}`))
		}
		if err := b.service.reviewMembers(ctx, admission); err != nil {
			var refusal *TodoControlError
			if errors.As(err, &refusal) && refusal.Class == "permission" {
				return lease.Fail(ctx, json.RawMessage(`{"class":"permission","code":"permission"}`))
			}
			return err
		}
		if err := b.machine.Prepare(ctx, admission); err != nil {
			return err
		}
		if err := b.delivery.Ready(ctx, admission); err != nil {
			return err
		}
		if err := lease.StartExternal(ctx, json.RawMessage(`{"kind":"review"}`)); err != nil {
			return err
		}
		run, err := b.machine.Start(ctx, claim.OperationID, admission)
		if err != nil {
			return err
		}
		if run == "" {
			return errors.New("review machine returned no run")
		}
		checkpoint.Run = run
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
