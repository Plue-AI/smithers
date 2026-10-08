package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// ReservedStackInput carries immutable work, never run or machine authority.
// An empty candidate request authorizes transport before the guest opens JJ.
type ReservedStackInput struct {
	RequestID  string                    `json:"requestId"`
	Plan       json.RawMessage           `json:"plan,omitempty"`
	Source     *repohost.WorkspaceSource `json:"source,omitempty"`
	Generation int64                     `json:"generation,omitempty"`
}

type ReservedStackResult struct {
	Generation int64  `json:"generation,omitempty"`
	Base       string `json:"base,omitempty"`
	Head       string `json:"head,omitempty"`
}

// ReservedStackOperation admits through the current stored run, serializes with
// reports and publication, and requests the existing engine. Only that engine's
// runClaimed advances candidates, launches verify and records/pushes proposals.
// Pending work answers 202, so transport can recheck without holding DB locks.
func (s *MythicalService) ReservedStackOperation(ctx context.Context, repository int64, workspace, command string, input ReservedStackInput) (result ReservedStackResult, status int, retErr error) {
	empty := ReservedStackResult{}
	stage := "reserved_configuration"
	defer func() {
		if retErr != nil {
			s.logger.Warn("source_refused: "+stage, "repository", repository, "workspace", workspace, "request", input.RequestID, "operation", command)
		}
	}()
	if !s.installAuthorization || command != "stack.candidate" && command != "stack.propose" {
		return empty, 0, confirmationPermission()
	}
	stage = "reserved_subject"
	subject, err := ResolveReservedStackSubject(ctx, s.queries(), repository, workspace)
	if err != nil {
		return empty, 0, err
	}
	// Keep the caller's pointer/slice out of the admitted immutable work.
	input.Plan = append(json.RawMessage(nil), input.Plan...)
	if input.Source != nil {
		source := *input.Source
		source.ParentCommitIDs = append([]string(nil), source.ParentCommitIDs...)
		input.Source = &source
	}
	stage = "reserved_payload"
	subject, err = BindReservedStackPayload(subject, command, input)
	if err != nil {
		return empty, 0, err
	}
	stage = "reserved_authorize"
	decision, err := Authorize(ctx, s.queries(), command, subject)
	if err != nil {
		return empty, 0, err
	}
	ctx = WithInstallAuthorization(ctx, command, decision, subject)
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return empty, 0, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	defer func() {
		if retErr != nil && input.Source != nil {
			s.logger.Warn("mythical.reserved_source_refused", "operation", command, "todo", subject.TodoNumber, "commit", input.Source.CommitID, "tree", input.Source.TreeID, "error", retErr)
		}
	}()
	defer func() {
		var busy *pgconn.PgError
		if errors.As(retErr, &busy) && (busy.Code == "55P03" || busy.Code == "40P01" || busy.Code == "40001") {
			// Projection may hold this TODO's stream before taking its stack.
			// Roll back the whole operation and obtain fresh authority on poll.
			result, status, retErr = empty, 202, nil
		}
	}()
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '100ms'"); err != nil {
		return empty, 0, err
	}
	stage = "reserved_credential"
	live, repo, err := lockInstallWriteCredential(ctx, tx, middleware.AuthInfoFromContext(ctx))
	if err != nil {
		return empty, 0, err
	}
	if repo != repository {
		return empty, 0, confirmationPermission()
	}
	if _, err = tx.Exec(live, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
		return empty, 0, err
	}
	q := db.New(tx)
	items, err := q.LockMythicalStackOrder(live, repository)
	if err != nil {
		return empty, 0, err
	}
	if _, err = tx.Exec(live, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, workspace); err != nil {
		return empty, 0, err
	}
	if refusal := identity.NewMemberBoundary(q).AuthorizeMember(identity.WithMemberRoute(live), middleware.UserFromContext(live).ID); refusal != nil {
		return empty, 0, refusal
	}
	item, err := q.GetMythicalItemByNumber(live, repository, subject.TodoNumber)
	if err != nil {
		return empty, 0, err
	}
	// The engine may finish capture between the authorized snapshot and
	// this stack lock. No work runs under that stale generation: let the
	// same immutable request obtain a fresh decision on its next poll.
	if item.Generation != subject.Generation && item.RequestRunID == subject.RunID && item.WorkspaceID == subject.WorkspaceID && item.BaseCommit == subject.Base {
		return empty, 202, tx.Commit(live)
	}
	stage = "reserved_locked_authorize"
	if _, err = authorizeStackCandidate(live, q, subject); err != nil {
		return empty, 0, err
	}
	// Completed immutable work replays its own receipt before evaluating
	// today's generation, prefix or live tree. Authorization above is current.
	if command != "stack.candidate" || input.Source != nil {
		if result, found, err := replayReservedStack(live, tx, item, command, input); err != nil || found {
			if err != nil {
				return empty, 0, err
			}
			return result, 200, tx.Commit(live)
		}
	}
	complete := func(result ReservedStackResult) (ReservedStackResult, int, error) {
		if err := s.recordReservedStack(live, tx, item, command, input, result); err != nil {
			return empty, 0, err
		}
		return result, 200, tx.Commit(live)
	}
	if mythicalSettledStates[item.State] {
		s.logger.Warn("source_refused: reserved_todo_closed", "workspace", workspace, "run", subject.RunID)
		return empty, 0, pkgerrors.Conflict("source_refused: reserved_todo_closed")
	}
	if mythicalMergeFenced(item) || item.PausedAt.Valid {
		return empty, 202, nil
	}
	if pending := mythicalChecksOf(item).ProposalInput; command == "stack.candidate" && input.Source != nil && pending != nil {
		same, err := reservedStackInputsEqual(live, tx, *pending, input)
		if err != nil {
			return empty, 0, err
		}
		if pending.RequestID == input.RequestID && !same {
			s.logger.Warn("source_refused: reserved_request_changed", "workspace", workspace, "run", subject.RunID)
			return empty, 0, pkgerrors.Conflict("source_refused: reserved_request_changed")
		}
		if same && mythicalChecksOf(item).ProposalRun == item.RequestRunID && mythicalChecksOf(item).ProposalHead == input.Source.CommitID && item.State == "integrating" {
			// Its exact admitted snapshot is already owned by the engine. A
			// native rewrite may move the live tree before verification records
			// this invocation's result; polling must not submit those bytes again.
			return empty, 202, tx.Commit(live)
		}
	}
	stack, err := q.GetMythicalStack(live, repository)
	if err != nil {
		return empty, 0, err
	}
	retained, err := q.ListMythicalUnfoldedMerges(live, repository, stack.LandedMain)
	if err != nil {
		return empty, 0, err
	}
	items = append(items, retained...)
	step := mythicalItemStep{s: s, q: q, r: &mythicalRun{row: stack, mainTip: stack.LandedMain}, items: items}
	prefix := step.prefix(item)
	initialBase := mythicalAttemptPrefix(item)
	initialMoved := command == "stack.candidate" && item.CandidateHead == "" && codingCommitID.MatchString(initialBase) && initialBase != prefix
	var integration struct{ Kind, Head, Tree string }
	_ = json.Unmarshal(item.Integration, &integration)
	consumedSource := command == "stack.candidate" && input.Source != nil && integration.Kind == "captured" && integration.Head == input.Source.CommitID && integration.Tree == input.Source.TreeID
	if !codingCommitID.MatchString(prefix) || !initialMoved && (item.CandidateHead == "" && initialBase != prefix || item.CandidateHead != "" && item.CandidateBase != prefix) {
		checks := mythicalChecksOf(item)
		if command == "stack.candidate" && input.Source != nil &&
			checks.ProposalRun == item.RequestRunID && checks.ProposalHead == input.Source.CommitID &&
			((checks.Capture != nil && checks.Capture.Head == input.Source.CommitID && checks.Capture.Tree == input.Source.TreeID &&
				!checks.Capture.Stale && !checks.Capture.Conflict) ||
				(checks.Rebase != nil && !checks.Rebase.Rebased)) && codingCommitID.MatchString(prefix) {
			// The sealed invocation is waiting for its own fenced rebase. It
			// cannot republish old bytes or allocate obsolete-prefix checks.
			if _, err := q.RequestMythicalStack(live, repository); err != nil {
				return empty, 0, err
			}
			return empty, 202, tx.Commit(live)
		}
		if consumedSource && checks.ProposalRun == item.RequestRunID && checks.ProposalHead == input.Source.CommitID && checks.Rebase != nil && !checks.Rebase.Rebased {
			return empty, 202, tx.Commit(live)
		}
		s.logger.Warn("source_refused: reserved_prefix_mismatch", "actual", initialBase, "expected", prefix, "candidate_base", item.CandidateBase)
		return empty, 0, pkgerrors.Conflict("source_refused: reserved_prefix_mismatch")
	}
	lanes, ok := s.lanes.(*workspaceMythicalLanes)
	if !ok || lanes.workspaces == nil {
		return empty, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "candidate machine unavailable")
	}
	machine := *lanes.workspaces
	machine.q, machine.transactions = q, tx
	row, err := q.GetWorkspace(live, workspace)
	if err != nil {
		return empty, 0, err
	}
	if _, pinned := mythicalPinOf(item); !pinned || !mythicalChecksOf(item).RunAttached {
		return empty, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "packaged TODO binding unavailable")
	}
	if command == "stack.candidate" {
		if len(input.Plan) > 0 {
			encoded, err := json.Marshal(map[string]json.RawMessage{"plan": input.Plan})
			if err != nil {
				return empty, 0, pkgerrors.BadRequest("invalid candidate plan")
			}
			item.Plan = mythicalPlanSummaryJSON(encoded)
			if len(item.Plan) == 0 {
				return empty, 0, pkgerrors.BadRequest("candidate plan has no changes")
			}
		}
		// Both preflight and posted snapshots require every execution provider
		// before any guest observation or persistence.
		if s.launcher == nil || machine.sourceReader == nil || machine.runtime == nil || machine.runtime.Isolation() != workspaceapi.IsolationSandboxed || len(item.Plan) == 0 {
			return empty, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "candidate verification unavailable")
		}
		if input.Source == nil {
			return empty, 204, tx.Commit(live)
		}
	}
	// Candidate acknowledges a generation while its checks still run, so a
	// proposal of that generation waits for them instead of refusing. A
	// passing projection still waits for the engine to accept the checks.
	checking := item.State == "verifying" && (item.VerifyOutcome == "" || item.VerifyOutcome == "passed")
	if command == "stack.propose" && (input.Generation != item.Generation || !item.CandidateVerified && !checking || item.CandidateBase != prefix) {
		s.logger.Warn("source_refused: reserved_candidate_changed", "actual_generation", input.Generation, "expected_generation", item.Generation, "actual_base", item.CandidateBase, "expected_base", prefix)
		return empty, 0, pkgerrors.Conflict("source_refused: reserved_candidate_changed")
	}
	_, tree, err := machine.observeWorkspaceHeadTree(live, row)
	if err != nil {
		return empty, 0, err
	}
	if command == "stack.candidate" {
		// Equal bytes can reuse a verified candidate or its still-running
		// checks. An observed invalidation requires a fresh generation.
		reusable := item.CandidateVerified || checking
		// A prefix rebase consumed this immutable capture already. Its sealed
		// invocation cannot put the old-prefix bytes back into pending work.
		// Bind its original tree before comparing the rebased candidate to
		// the live machine; these are different trees after a prefix move.
		if json.Unmarshal(item.Integration, &integration) == nil && integration.Kind == "captured" && integration.Head == input.Source.CommitID && item.CandidateHead != input.Source.CommitID && mythicalChecksOf(item).Capture == nil {
			if integration.Tree != input.Source.TreeID {
				s.logger.Warn("source_refused: reserved_capture_tree_mismatch", "actual", input.Source.TreeID, "expected", integration.Tree)
				return empty, 0, pkgerrors.Conflict("source_refused: reserved_capture_tree_mismatch")
			}
			previous, err := machine.workspaceCommitTree(live, row, item.CandidateHead)
			if err != nil {
				return empty, 0, err
			}
			if previous != tree {
				s.logger.Warn("source_refused: reserved_candidate_prefix_mismatch", "actual", tree, "expected", previous)
				return empty, 0, pkgerrors.Conflict("source_refused: reserved_candidate_prefix_mismatch")
			}
			return complete(ReservedStackResult{Generation: item.Generation, Base: item.CandidateBase, Head: item.CandidateHead})
		}
		if input.Source.TreeID != tree {
			s.logger.Warn("source_refused: reserved_live_tree_mismatch", "actual", input.Source.TreeID, "expected", tree)
			return empty, 0, pkgerrors.Conflict("source_refused: reserved_live_tree_mismatch")
		}
		if _, err := machine.reportRetainedSource(live, row, ReportWorkspaceHeadInput{RetainSource: input.Source}); err != nil {
			return empty, 0, err
		}
		if item.CandidateHead != "" && item.CandidateBase == prefix {
			previous, err := machine.workspaceCommitTree(live, row, item.CandidateHead)
			if err != nil {
				return empty, 0, err
			}
			if previous == tree && reusable && mythicalChecksOf(item).Capture == nil {
				return complete(ReservedStackResult{Generation: item.Generation, Base: item.CandidateBase, Head: item.CandidateHead})
			}
		}
		// An exact sealed-source replay returns its recorded generation without
		// reviving invalidated verification or allocating another generation.
		if item.CandidateHead == input.Source.CommitID && item.CandidateBase == prefix && mythicalChecksOf(item).Capture == nil {
			return complete(ReservedStackResult{Generation: item.Generation, Base: item.CandidateBase, Head: item.CandidateHead})
		}
		pending := mythicalChecksOf(item).Capture
		if pending != nil && pending.Head == input.Source.CommitID || len(item.PendingOp) > 0 || checking {
			if pending != nil && pending.Head == input.Source.CommitID && pending.Tree == tree {
				checks := mythicalChecksOf(item)
				if checks.ProposalRun != item.RequestRunID || checks.ProposalHead != pending.Head || checks.ProposalInput == nil {
					checks.ProposalRun, checks.ProposalHead = item.RequestRunID, pending.Head
					checks.ProposalInput = &input
					if !checking && len(item.PendingOp) == 0 {
						item.CandidateBase, item.CandidateVerified = prefix, false
						item.State, item.Reason = "integrating", ""
					}
					item.Checks = checks.encode()
					if _, err := q.SaveMythicalItem(live, item); err != nil {
						return empty, 0, err
					}
				}
			}
			if _, err := q.RequestMythicalStack(live, repository); err != nil {
				return empty, 0, err
			}
			return empty, 202, tx.Commit(live)
		}
		var plan map[string]json.RawMessage
		if json.Unmarshal(item.Plan, &plan) != nil {
			return empty, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "candidate verification unavailable")
		}
		// Keep bytes pending until runClaimed pins them and atomically records
		// the next generation with its separate verification launch.
		captured := MachineCapturePending{Head: input.Source.CommitID, Tree: tree, Base: item.CandidateHead, Onto: input.Source.CommitID,
			SourceRef: repohost.WorkspaceSourceRef(workspace, input.Source.CommitID)}
		if captured.Base == "" {
			captured.Base = prefix
		}
		item.CandidateBase, item.CandidateVerified = prefix, false
		item.State, item.Reason = "integrating", ""
		if initialMoved {
			// The first sealed result may arrive after its predecessor publishes.
			// Retain its actual old base; the worker's existing native rebase must
			// advance it before allocating verification or accepting a proposal.
			captured.Base = initialBase
			item.CandidateBase, item.CandidateHead = initialBase, captured.Head
			item = *step.invalidatePrefix(item)
		}
		checks := mythicalChecksOf(item)
		checks.Capture, checks.Land, checks.Review = &captured, nil, nil
		// This run now waits on stack.propose for its acceptance.
		checks.ProposalRun, checks.ProposalHead = item.RequestRunID, captured.Head
		checks.ProposalInput = &input
		item.Checks = checks.encode()
		encoded, err := json.Marshal(captured)
		if err != nil {
			return empty, 0, err
		}
		if _, err := tx.Exec(live, `UPDATE workspaces SET head_commit_id=$2,head_change_id=$3,capture_pending=$4 WHERE id=$1`, workspace, captured.Head, input.Source.ChangeID, encoded); err != nil {
			return empty, 0, err
		}
		if _, err := q.SaveMythicalItem(live, item); err != nil {
			return empty, 0, err
		}
	} else {
		candidateTree, err := machine.workspaceCommitTree(live, row, item.CandidateHead)
		if err != nil {
			return empty, 0, err
		}
		if candidateTree != tree {
			// A changed head invalidates this generation even if a later report is equal.
			item.CandidateVerified = false
			checks := mythicalChecksOf(item)
			checks.Land = nil
			item.Checks = checks.encode()
			if _, err := q.SaveMythicalItem(live, item); err != nil {
				return empty, 0, err
			}
			if _, err := q.RequestMythicalStack(live, repository); err != nil {
				return empty, 0, err
			}
			if err := tx.Commit(live); err != nil {
				return empty, 0, err
			}
			s.logger.Warn("source_refused: reserved_candidate_changed", "actual_generation", input.Generation, "expected_generation", item.Generation, "actual_base", item.CandidateBase, "expected_base", prefix)
			return empty, 0, pkgerrors.Conflict("source_refused: reserved_candidate_changed")
		}
		if item.State == "proposed" && item.PRHead != "" && len(item.PendingOp) == 0 {
			// The run saw its acceptance; review may now take its machine.
			// Cleared once: a replay returns its receipt above.
			if checks := mythicalChecksOf(item); checks.ProposalRun != "" {
				checks.ProposalRun, checks.ProposalHead = "", ""
				item.Checks = checks.encode()
				acceptTodoWatchdog(&item, s.now())
				if item, err = q.SaveMythicalItem(live, item); err != nil {
					return empty, 0, err
				}
				if _, err := q.RequestMythicalStack(live, repository); err != nil {
					return empty, 0, err
				}
			}
			return complete(ReservedStackResult{Generation: item.Generation, Head: item.PRHead})
		}
	}
	if _, err := q.RequestMythicalStack(live, repository); err != nil {
		return empty, 0, err
	}
	return empty, 202, tx.Commit(live)
}

// BindReservedStackPayload binds the concrete immutable candidate/proposal to
// the stored run subject before dispatch. Neither replay nor direct entry may
// replace the source, request identity, or requested generation afterward.
func BindReservedStackPayload(subject InstallSubject, command string, input ReservedStackInput) (InstallSubject, error) {
	id, err := uuid.Parse(input.RequestID)
	if err != nil || id.String() != input.RequestID || command != "stack.candidate" && command != "stack.propose" || command == "stack.propose" && (input.Generation <= 0 || input.Source != nil || len(input.Plan) > 0) || command == "stack.candidate" && input.Generation != 0 {
		return InstallSubject{}, pkgerrors.BadRequest("invalid stack operation")
	}
	if input.Source != nil {
		if err := input.Source.Validate(); err != nil {
			return InstallSubject{}, pkgerrors.BadRequest("invalid candidate source")
		}
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return InstallSubject{}, err
	}
	digest := sha256.Sum256(encoded)
	subject.PayloadDigest = hex.EncodeToString(digest[:])
	return subject, nil
}

// Reuse the durable operation journal, not a second generation/receipt table.
// The key belongs to an attempt and operation invocation; changing its payload
// is a conflict, while a later generation cannot change its completed result.
func reservedStackReceiptID(item db.MythicalItem, command, request string) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("reserved-stack/%d/%s/%s/%s/%s", item.RepositoryID, uuidString(item.ID), item.RequestRunID, command, request))).String()
}

type reservedStackReceipt struct {
	Input  ReservedStackInput  `json:"input"`
	Result ReservedStackResult `json:"result"`
}

// Both checks and receipts persist as JSONB. Compare the submitted request in
// that same representation: key order and whitespace cannot change its identity.
// JSONB retains exact numeric values, array order and every source binding.
func reservedStackInputsEqual(ctx context.Context, tx pgx.Tx, previous, current ReservedStackInput) (bool, error) {
	left, err := json.Marshal(previous)
	if err != nil {
		return false, err
	}
	right, err := json.Marshal(current)
	if err != nil {
		return false, err
	}
	var same bool
	err = tx.QueryRow(ctx, `SELECT $1::jsonb = $2::jsonb`, string(left), string(right)).Scan(&same)
	return same, err
}

func replayReservedStack(ctx context.Context, tx pgx.Tx, item db.MythicalItem, command string, input ReservedStackInput) (ReservedStackResult, bool, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT authorization_context FROM product_job_requests WHERE id=$1`, reservedStackReceiptID(item, command, input.RequestID)).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReservedStackResult{}, false, nil
	}
	if err != nil {
		return ReservedStackResult{}, false, err
	}
	var stored reservedStackReceipt
	if json.Unmarshal(raw, &stored) != nil || stored.Result.Generation <= 0 || stored.Result.Head == "" {
		return ReservedStackResult{}, false, pkgerrors.Internal("invalid reserved operation receipt")
	}
	same, err := reservedStackInputsEqual(ctx, tx, stored.Input, input)
	if err != nil {
		return ReservedStackResult{}, false, err
	}
	if !same {
		return ReservedStackResult{}, false, pkgerrors.Conflict("stack operation request changed")
	}
	return stored.Result, true, nil
}

func (s *MythicalService) recordReservedStack(ctx context.Context, tx pgx.Tx, item db.MythicalItem, command string, input ReservedStackInput, result ReservedStackResult) error {
	id := reservedStackReceiptID(item, command, input.RequestID)
	fact, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "n": item.Number.Int64, "generation": result.Generation, "head": result.Head})
	if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(item), id, command+".completed", todoState(item), fact); err != nil {
		return err
	}
	metadata, err := json.Marshal(reservedStackReceipt{Input: input, Result: result})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE product_job_requests SET authorization_context=$2::jsonb WHERE id=$1`, id, metadata)
	return err
}

// todoRunAwaitsProposal reports a proposed TODO whose attached composition
// offered its candidate through stack.candidate and has not yet observed the
// acceptance through stack.propose. Review and lane release wait: retiring
// that machine would stop the run before it sees its own proposal. An ended
// run (RequestOutcome), another run or an observed acceptance ends the hold.
// A composition that delivers by lane submission never sets it.
func todoRunAwaitsProposal(item db.MythicalItem) bool {
	if item.State != "proposed" || item.WorkspaceID == "" || item.RequestOutcome != "" || item.RequestRunID == "" {
		return false
	}
	_, pinned := mythicalPinOf(item)
	checks := mythicalChecksOf(item)
	return pinned && checks.RunAttached && checks.ProposalRun == item.RequestRunID
}
