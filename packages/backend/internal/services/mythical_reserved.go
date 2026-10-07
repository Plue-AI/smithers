package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// ReservedStackInput carries immutable work, never run or machine authority.
// An empty candidate request authorizes transport before the guest opens JJ.
type ReservedStackInput struct {
	RequestID  string                    `json:"requestId"`
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
func (s *MythicalService) ReservedStackOperation(ctx context.Context, repository int64, workspace, command string, input ReservedStackInput) (ReservedStackResult, int, error) {
	empty := ReservedStackResult{}
	if !s.installAuthorization || command != "stack.candidate" && command != "stack.propose" {
		return empty, 0, confirmationPermission()
	}
	subject, err := ResolveReservedStackSubject(ctx, s.queries(), repository, workspace)
	if err != nil {
		return empty, 0, err
	}
	// Keep the caller's pointer/slice out of the admitted immutable work.
	if input.Source != nil {
		source := *input.Source
		source.ParentCommitIDs = append([]string(nil), source.ParentCommitIDs...)
		input.Source = &source
	}
	subject, err = BindReservedStackPayload(subject, command, input)
	if err != nil {
		return empty, 0, err
	}
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
	if _, err = authorizeStackCandidate(live, q, subject); err != nil {
		return empty, 0, err
	}
	item, err := q.GetMythicalItemByNumber(live, repository, subject.TodoNumber)
	if err != nil {
		return empty, 0, err
	}
	if mythicalSettledStates[item.State] {
		return empty, 0, pkgerrors.Conflict("TODO is closed")
	}
	if mythicalMergeFenced(item) || item.PausedAt.Valid {
		return empty, 202, nil
	}
	stack, err := q.GetMythicalStack(live, repository)
	if err != nil {
		return empty, 0, err
	}
	step := mythicalItemStep{s: s, q: q, r: &mythicalRun{row: stack, mainTip: stack.LandedMain}, items: items}
	prefix := step.prefix(item)
	if !codingCommitID.MatchString(prefix) || item.CandidateHead == "" && item.BaseCommit != prefix || item.CandidateHead != "" && item.CandidateBase != prefix {
		return empty, 0, pkgerrors.Conflict("rebase pending")
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
		// Both preflight and posted snapshots require every execution provider
		// before any guest observation or persistence.
		if s.launcher == nil || machine.sourceReader == nil || machine.runtime == nil || machine.runtime.Isolation() != workspaceapi.IsolationSandboxed || len(item.Plan) == 0 {
			return empty, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "candidate verification unavailable")
		}
		if input.Source == nil {
			return empty, 204, tx.Commit(live)
		}
	}
	if command == "stack.propose" && (input.Generation != item.Generation || !item.CandidateVerified || item.CandidateBase != prefix) {
		return empty, 0, pkgerrors.Conflict("candidate changed")
	}
	_, tree, err := machine.observeWorkspaceHeadTree(live, row)
	if err != nil {
		return empty, 0, err
	}
	if command == "stack.candidate" {
		// Equal bytes can reuse a verified candidate or its still-running
		// checks. An observed invalidation requires a fresh generation.
		reusable := item.CandidateVerified || item.State == "verifying" && item.VerifyOutcome == ""
		if input.Source.TreeID != tree {
			return empty, 0, pkgerrors.Conflict("candidate is no longer the live revision")
		}
		// A prefix rebase consumed this immutable capture already. Its sealed
		// invocation cannot put the old-prefix bytes back into pending work.
		var integration struct {
			Kind string `json:"kind"`
			Head string `json:"head"`
		}
		if json.Unmarshal(item.Integration, &integration) == nil && integration.Kind == "captured" && integration.Head == input.Source.CommitID && item.CandidateHead != input.Source.CommitID && mythicalChecksOf(item).Capture == nil {
			previous, err := machine.workspaceCommitTree(live, row, item.CandidateHead)
			if err != nil {
				return empty, 0, err
			}
			if previous != tree {
				return empty, 0, pkgerrors.Conflict("candidate prefix changed")
			}
			return ReservedStackResult{Generation: item.Generation, Base: item.CandidateBase, Head: item.CandidateHead}, 200, tx.Commit(live)
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
				return ReservedStackResult{Generation: item.Generation, Base: item.CandidateBase, Head: item.CandidateHead}, 200, tx.Commit(live)
			}
		}
		// An exact sealed-source replay returns its recorded generation without
		// reviving invalidated verification or allocating another generation.
		if item.CandidateHead == input.Source.CommitID && item.CandidateBase == prefix && mythicalChecksOf(item).Capture == nil {
			return ReservedStackResult{Generation: item.Generation, Base: item.CandidateBase, Head: item.CandidateHead}, 200, tx.Commit(live)
		}
		pending := mythicalChecksOf(item).Capture
		if pending != nil && pending.Head == input.Source.CommitID || len(item.PendingOp) > 0 || item.State == "verifying" && item.VerifyOutcome == "" {
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
		checks := mythicalChecksOf(item)
		checks.Capture, checks.Land, checks.Review = &captured, nil, nil
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
			return empty, 0, pkgerrors.Conflict("candidate changed")
		}
		if item.State == "proposed" && item.PRHead != "" && len(item.PendingOp) == 0 {
			return ReservedStackResult{Generation: item.Generation, Head: item.PRHead}, 200, tx.Commit(live)
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
	if err != nil || id.String() != input.RequestID || command != "stack.candidate" && command != "stack.propose" || command == "stack.propose" && (input.Generation <= 0 || input.Source != nil) || command == "stack.candidate" && input.Generation != 0 {
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
