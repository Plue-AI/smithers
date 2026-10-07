package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const MemberRecheckInterval = time.Hour

// MemberRecheckFailures counts skipped member reads, without member labels.
var MemberRecheckFailures = prometheus.NewCounter(prometheus.CounterOpts{Name: "smithers_member_recheck_failures_total", Help: "Member permission rechecks skipped because identity or permission could not be resolved."})

// Recheck asks GitHub for every roster member's permission now. A member
// GitHub confirms below write is suspended: in one transaction the row is
// marked and every credential they hold is revoked, as removal does. A
// suspended member GitHub reports with write again is restored; old
// credentials stay revoked, so they sign in again. An unbound repository,
// an installation failure changes nothing. A failed member lookup preserves
// that member while the other confirmed decisions are applied.
func (m *Members) Recheck(ctx context.Context) (result error) {
	if m == nil || m.Pool == nil {
		return nil
	}
	defer func() { result = errors.Join(result, m.recordPermissionHealth(ctx, result)) }()
	repo, err := m.repository(ctx)
	if err != nil {
		return err
	}
	token, err := m.installationAccess(ctx, repo)
	if err != nil {
		return err
	}
	if err = m.confirmInstallationRepository(ctx, token, repo); err != nil {
		return err
	}
	type row struct {
		id       int64
		githubID *int64
		login    string
		role     string
		resolved bool
	}
	rows, err := m.Pool.Query(ctx, `SELECT c.id,c.github_id
 FROM collaborators c CROSS JOIN self_host_owners o WHERE c.repository_id=$1 AND c.user_id IS DISTINCT FROM o.user_id ORDER BY c.id`, repo.ID)
	if err != nil {
		return err
	}
	members, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var out row
		err := r.Scan(&out.id, &out.githubID)
		return out, err
	})
	if err != nil {
		return err
	}
	if poll != nil {
		active := make(map[int64]bool, len(members))
		for _, member := range members {
			active[member.id] = true
		}
		poll.mu.Lock()
		if poll.binding == binding {
			for id := range poll.validators {
				if !active[id] {
					delete(poll.validators, id)
				}
			}
		}
		poll.mu.Unlock()
	}
	var failed []error
	// Stage all reads: an installation refusal must change no member, even
	// when a preceding member's lookup would otherwise revoke or restore.
	for i := range members {
		member := &members[i]
		if member.githubID == nil || *member.githubID <= 0 {
			err = fmt.Errorf("member %d data defect: missing github_id", member.id)
		} else {
			member.login, err = m.memberAccount(ctx, token, repo, *member.githubID)
			if err == nil && member.login != "" {
				member.role, err = m.permission(ctx, token, repo, member.login, *member.githubID)
			}
		}
		if err != nil {
			var refusal *memberInstallationRefusal
			if errors.As(err, &refusal) {
				return err
			}
			MemberRecheckFailures.Inc()
			slog.WarnContext(ctx, "members.recheck.failed", "member_id", member.id, "error", err)
			failed = append(failed, fmt.Errorf("member %d: %w", member.id, err))
		} else {
			member.resolved = true
		}
	}
	for _, member := range members {
		if !member.resolved {
			continue
		}
		changed, err := m.applyMemberRecheck(ctx, repo.ID, member.id, *member.githubID, member.login, member.role == "")
		if err != nil {
			return err
		}
		if changed {
			slog.InfoContext(ctx, "members.recheck", "login", member.login, "suspended", member.role == "")
		}
	}
	return errors.Join(failed...)
}

// Persist this required stream in install settings and project it through
// the existing GitHubSyncStreams aggregation, retaining the last success.
func (m *Members) recordPermissionHealth(ctx context.Context, err error) error {
	q := db.New(m.Pool)
	var stream GitHubSyncStream
	setting, readErr := q.GetInstallSetting(ctx, "github.permissions.health")
	if readErr == nil {
		if e := json.Unmarshal(setting.Value, &stream); e != nil {
			return e
		}
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return readErr
	}
	stream.Target = MemberRecheckInterval
	var refusal *memberInstallationRefusal
	if errors.As(err, &refusal) {
		stream.Cause = refusal.cause
	} else if err == nil {
		now := time.Now().UTC()
		stream.LastSuccessAt = &now
		stream.Cause = ""
		stream.RetryAt = nil
	}
	value, e := json.Marshal(stream)
	if e != nil {
		return e
	}
	return q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.permissions.health", Value: value})
}

// applyMemberRecheck fences a remote permission result to the original roster
// row and immutable GitHub account. The owner lock orders it with removal and
// sign-in; the row lock also orders LinkGitHub's account binding. Read the local
// user here, since a first sign-in may have completed during the GitHub request.
func (m *Members) applyMemberRecheck(ctx context.Context, repositoryID, id, githubID int64, login string, suspend bool) (bool, error) {
	tx, err := m.lockRoster(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var user *int64
	var suspended bool
	err = tx.QueryRow(ctx, `SELECT user_id,suspended_at IS NOT NULL FROM collaborators
 WHERE id=$1 AND repository_id=$2 AND github_id=$3 FOR UPDATE`, id, repositoryID, githubID).Scan(&user, &suspended)
	if errors.Is(err, pgx.ErrNoRows) {
		// Removal or replacement won. Its credentials and sign-in bar belong
		// to that newer decision, not this old permission read.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE collaborators SET
 github_login=CASE WHEN $2='' THEN github_login ELSE $2 END,
 suspended_at=CASE WHEN $3 THEN coalesce(suspended_at,now()) ELSE NULL END
 WHERE id=$1`, id, login, suspend); err != nil {
		return false, err
	}
	changed := suspended != suspend
	if changed && user != nil {
		if suspend {
			err = revokeMemberCredentials(ctx, tx, repositoryID, *user, 0)
		} else {
			_, err = tx.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, *user)
		}
		if err != nil {
			return false, err
		}
	}
	return changed, tx.Commit(ctx)
}
