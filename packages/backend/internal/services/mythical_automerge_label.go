package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Only an authenticated GitHub event from a currently eligible linked person
// grants standing approval. A label's presence alone never grants authority.
func (s *MythicalService) observeAutomergeLabel(ctx context.Context, admission pgx.Tx, repositoryID int64, gh mythicalGitHubRepo, event mythicalIssueEvent) error {
	approved := event.Event == "labeled"
	if event.ID <= 0 || event.Issue <= 0 || event.Pull {
		return nil
	}
	var user int64
	account := event.Actor
	var binding mythicalMergeBinding
	if approved {
		if event.ViaApp || !gitHubPerson(&event.Actor) || event.Actor.ID <= 0 {
			return nil
		}
		role, err := s.todoLabelMember(ctx, repositoryID, gh, event.Actor)
		if err != nil {
			return err
		}
		if role != "owner" && role != "admin" {
			return nil
		}
		err = s.store.QueryRow(ctx, `SELECT user_id FROM oauth_accounts WHERE provider IN ('github','workos') AND provider_user_id=$1 ORDER BY id LIMIT 1`, strconv.FormatInt(event.Actor.ID, 10)).Scan(&user)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := s.standingMergePerson(ctx, s.store, user); err != nil {
			err = mythicalAuthorityRefusal(err)
			var refusal *TodoControlError
			if errors.As(err, &refusal) && (refusal.Status == 401 || refusal.Status == 403) {
				return nil
			}
			return err
		}
		_, account, err = s.maintainerPerson(ctx, repositoryID, user, "pre-approve a TODO on GitHub")
		if err != nil {
			err = mythicalAuthorityRefusal(err)
			var refusal *TodoControlError
			if errors.As(err, &refusal) && (refusal.Status == 401 || refusal.Status == 403) {
				return nil
			}
			return err
		}
		if account.ID != event.Actor.ID {
			return nil
		}
		binding, err = s.mergeBinding(ctx, repositoryID)
		if err != nil {
			return err
		}
	}
	return s.withTodoLabelTransaction(ctx, admission, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM repositories WHERE id=$1 FOR SHARE`, repositoryID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repositoryID); err != nil {
			return err
		}
		key := fmt.Sprintf("todo-automerge:%d:%d:%d", repositoryID, event.Issue, event.ID)
		var consumed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM install_settings WHERE key=$1)`, key).Scan(&consumed); err != nil {
			return err
		}
		if consumed {
			return nil
		}
		q := db.New(tx)
		// A replayed older grant cannot revive a grant a later event removed.
		cursorKey := fmt.Sprintf("todo-automerge-cursor:%d:%d", repositoryID, event.Issue)
		if row, err := q.GetInstallSetting(ctx, cursorKey); err == nil {
			var latest int64
			if err := json.Unmarshal(row.Value, &latest); err != nil {
				return err
			}
			if event.ID <= latest {
				return nil
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		cursor, _ := json.Marshal(event.ID)
		if err := q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: cursorKey, Value: cursor}); err != nil {
			return err
		}
		item, err := q.GetActiveMythicalItemByIssue(ctx, repositoryID, event.Issue)
		if errors.Is(err, pgx.ErrNoRows) {
			return q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(`{"ignored":true}`)})
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_items WHERE id=$1 FOR UPDATE`, item.ID); err != nil {
			return err
		}
		item, err = q.GetMythicalItem(ctx, item.ID)
		if err != nil {
			return err
		}
		if !mythicalIsTodo(item) || mythicalSettledStates[item.State] {
			return nil
		}
		if approved {
			if err := lockMergeFacts(ctx, tx, item, "", user, binding); err != nil {
				return err
			}
			if _, err := s.standingMergePerson(ctx, tx, user); err != nil {
				return err
			}
			accounts, err := q.ListUserOAuthAccounts(ctx, user)
			if err != nil {
				return err
			}
			if linked, _ := mythicalLinkedGitHub(accounts); linked != account.ID {
				return mythicalMergeAccountMoved()
			}
		} else {
			// Removal revokes a label grant regardless of who removed the label.
			// It never revokes a separate session/default grant.
			approval := mythicalChecksOf(item).Preapproval
			if approval == nil || approval.LabelIssue != event.Issue {
				return q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(`{"ignored":true}`)})
			}
		}
		item = recordMythicalPreapproval(item, user, account, event.Event == "labeled", "github", event.Issue, s.now())
		if _, err := q.SaveMythicalItem(ctx, item); err != nil {
			return err
		}
		if err := q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(`{"approved":true}`)}); err != nil {
			return err
		}
		stack, err := q.GetMythicalStack(ctx, repositoryID)
		if err != nil {
			return err
		}
		s.itemChanged(ctx, q, stack, item.ID)
		return nil
	})
}
