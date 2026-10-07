package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Standing approvals record a person, not an expiring login or a revision.
type mythicalPreapprovalEvent struct {
	By       string    `json:"by"`
	User     int64     `json:"user"`
	Approved bool      `json:"approved"`
	Via      string    `json:"via"`
	At       time.Time `json:"at"`
}

func mythicalMergeApproval(item db.MythicalItem) *mythicalLand {
	checks := mythicalChecksOf(item)
	op, _ := decodeMythicalOutbound(item.PendingOp)
	if op.Precondition != "preapproved" {
		return checks.Land
	}
	if !checks.Automerge || checks.Preapproval == nil {
		return nil
	}
	approval := *checks.Preapproval
	approval.Head, approval.Generation = item.PRHead, item.Generation
	return &approval
}

// standingMergePerson rechecks the current roster and user without requiring
// the browser session that originally granted a standing approval to stay open.
func (s *MythicalService) standingMergePerson(ctx context.Context, conn db.DBTX, user int64) (mergeStanding, error) {
	standing := mergeStanding{userID: user, session: true, expires: s.now().Add(time.Hour)}
	role, err := InstallRoleOf(ctx, db.New(conn), user)
	if err != nil {
		return standing, err
	}
	var active, prohibited bool
	var deleted bool
	if err := conn.QueryRow(ctx, `SELECT is_active, prohibit_login, deleted_at IS NOT NULL FROM users WHERE id = $1`, user).Scan(&active, &prohibited, &deleted); err != nil {
		return standing, err
	}
	standing.user, standing.enabled = role != "", role != "" && active && !prohibited && !deleted
	standing.maintainer = role == InstallOwner || role == InstallMaintainer
	_, err = standing.person(s.now())
	return standing, err
}

// PreapproveTodo changes the existing checks record under the same stack/item
// locks as Merge. Removal can cancel an unsent intent; a sent request is kept
// for lookup because removing approval cannot undo a remote merge.
func (s *MythicalService) PreapproveTodo(ctx context.Context, repositoryID, userID, number int64, approved bool) (MythicalItemView, error) {
	if err := RequireMergeSession(ctx, userID); err != nil {
		return MythicalItemView{}, err
	}
	session := middleware.AuthInfoFromContext(ctx).SessionHash
	person, account, _, err := s.mergeApprover(ctx, repositoryID, session)
	if err != nil {
		return MythicalItemView{}, err
	}
	if person != userID {
		return MythicalItemView{}, mythicalMergeForbidden()
	}
	binding, err := s.mergeBinding(ctx, repositoryID)
	if err != nil {
		return MythicalItemView{}, err
	}
	var saved db.MythicalItem
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM repositories WHERE id = $1 FOR SHARE`, repositoryID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, repositoryID); err != nil {
			return err
		}
		q := db.New(tx)
		item, err := q.GetMythicalItemByNumber(ctx, repositoryID, number)
		if errors.Is(err, pgx.ErrNoRows) {
			return &TodoControlError{Status: http.StatusNotFound, Class: "user", Code: "todo_not_found", Message: "TODO not found"}
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_items WHERE id = $1 FOR UPDATE`, item.ID); err != nil {
			return err
		}
		item, err = q.GetMythicalItem(ctx, item.ID)
		if err != nil {
			return err
		}
		if !mythicalIsTodo(item) || mythicalSettledStates[item.State] {
			return mythicalMergeConflict("state", "Only an unmerged TODO can be pre-approved")
		}
		if err := lockMergeFacts(ctx, tx, item, session, 0, binding); err != nil {
			return err
		}
		standing, err := readMergeStanding(ctx, tx, session)
		if err != nil {
			return err
		}
		if _, err := standing.person(s.now()); err != nil {
			return err
		}
		accounts, err := q.ListUserOAuthAccounts(ctx, userID)
		if err != nil {
			return err
		}
		if linked, _ := mythicalLinkedGitHub(accounts); linked != account.ID {
			return mythicalMergeAccountMoved()
		}
		checks := mythicalChecksOf(item)
		if approved && checks.Preapproval != nil && checks.Automerge || !approved && checks.Preapproval == nil && !checks.Automerge {
			saved = item
			return nil
		}
		item = recordMythicalPreapproval(item, userID, account, approved, "session", 0, s.now())
		saved, err = q.SaveMythicalItem(ctx, item)
		return err
	})
	if err != nil {
		return MythicalItemView{}, err
	}
	if stack, err := s.queries().GetMythicalStack(ctx, repositoryID); err == nil {
		s.itemChanged(ctx, s.queries(), stack, saved.ID)
	}
	return mythicalItemView(saved), nil
}

const todoPreapprovalDefaultKey = "todo.preapproval_default"

// SetTodoPreapprovalDefault changes only the creation default. Existing TODOs
// retain their own approvals and approval history.
func (s *MythicalService) SetTodoPreapprovalDefault(ctx context.Context, userID int64, approved bool) error {
	if err := RequireMergeSession(ctx, userID); err != nil {
		return err
	}
	repositoryID, err := InstallRepositoryID(ctx, s.queries())
	if err != nil {
		return err
	}
	person, account, _, err := s.mergeApprover(ctx, repositoryID, middleware.AuthInfoFromContext(ctx).SessionHash)
	if err != nil {
		return err
	}
	if person != userID {
		return mythicalMergeForbidden()
	}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR SHARE`, userID); err != nil {
			return err
		}
		var owner int64
		if err := tx.QueryRow(ctx, `SELECT user_id FROM self_host_owners WHERE singleton FOR UPDATE`).Scan(&owner); err != nil {
			return err
		}
		if owner != userID {
			return mythicalMergeForbidden()
		}
		standing, err := readMergeStanding(ctx, tx, middleware.AuthInfoFromContext(ctx).SessionHash)
		if err != nil {
			return err
		}
		if _, err := standing.person(s.now()); err != nil {
			return err
		}
		var approval *mythicalLand
		if approved {
			approval = &mythicalLand{StandingUser: userID, By: account.Login, Account: account.ID, At: s.now().UTC()}
		}
		raw, err := json.Marshal(approval)
		if err != nil {
			return err
		}
		return db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: todoPreapprovalDefaultKey, Value: raw})
	})
}

// All approval doors update the same record; dispatch uses the same predicate.
func recordMythicalPreapproval(item db.MythicalItem, user int64, account gitHubActor, approved bool, via string, issue int64, at time.Time) db.MythicalItem {
	checks := mythicalChecksOf(item)
	checks.Automerge = approved
	checks.Preapproval, checks.PreapprovalFailure = nil, nil
	if approved {
		checks.Preapproval = &mythicalLand{StandingUser: user, By: account.Login, Account: account.ID, LabelIssue: issue, At: at.UTC()}
	}
	checks.PreapprovalEvents = append(checks.PreapprovalEvents, mythicalPreapprovalEvent{By: account.Login, User: user, Approved: approved, Via: via, At: at.UTC()})
	item.Checks = checks.encode()
	item.NextAttemptAt.Valid = false
	return item
}
