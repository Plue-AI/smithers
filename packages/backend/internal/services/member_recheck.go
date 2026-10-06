package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const MemberRecheckInterval = time.Hour

type memberRecheckRow struct {
	id        int64
	login     string
	user      *int64
	suspended bool
	version   string
}

// Recheck is the explicit roster recheck. The periodic worker calls the same
// implementation through PollPermissions, with conditional-read validators.
func (m *Members) Recheck(ctx context.Context) error {
	if m == nil || m.Pool == nil {
		return nil
	}
	repo, err := m.repository(ctx)
	if err != nil {
		return nil
	}
	token, err := m.installationAccess(ctx, repo)
	if err != nil {
		return fmt.Errorf("members recheck: %w", err)
	}
	return m.recheckRepository(ctx, repo, token, nil, memberPollBinding{})
}

func (m *Members) recheckRepository(ctx context.Context, repo memberRepository, token string, poll *memberPermissionPoll, binding memberPollBinding) error {
	rows, err := m.Pool.Query(ctx, `SELECT c.id,coalesce(c.github_login,u.username),c.user_id,c.suspended_at IS NOT NULL,c.xmin::text
 FROM collaborators c LEFT JOIN users u ON u.id=c.user_id CROSS JOIN self_host_owners o
 WHERE c.repository_id=$1 AND c.user_id IS DISTINCT FROM o.user_id AND coalesce(c.github_login,u.username) IS NOT NULL ORDER BY c.id`, repo.ID)
	if err != nil {
		return err
	}
	members, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (memberRecheckRow, error) {
		var out memberRecheckRow
		err := r.Scan(&out.id, &out.login, &out.user, &out.suspended, &out.version)
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
	for _, member := range members {
		etag := ""
		if poll != nil {
			poll.mu.Lock()
			cached := poll.validators[member.id]
			if poll.binding == binding && cached.version == member.version {
				etag = cached.etag
			}
			poll.mu.Unlock()
		}
		role, nextETag, unchanged, err := m.readPermission(ctx, token, repo, member.login, etag)
		if err != nil {
			failed = append(failed, fmt.Errorf("%s: %w", member.login, err))
			continue
		}
		version, err := m.applyRecheckedPermission(ctx, repo, member, role, unchanged, poll, binding)
		if err != nil {
			failed = append(failed, fmt.Errorf("%s: %w", member.login, err))
			continue
		}
		if poll != nil {
			poll.mu.Lock()
			if poll.binding == binding {
				if nextETag != "" {
					poll.validators[member.id] = memberPermissionValidator{nextETag, version}
				} else {
					delete(poll.validators, member.id)
				}
			}
			poll.mu.Unlock()
		}
	}
	return errors.Join(failed...)
}

// An ETag is kept only after the corresponding roster effects commit. Recheck
// both the repository binding and row version under the same locks before
// accepting a body or 304, so stale reads cannot revoke or restore a new row.
func (m *Members) applyRecheckedPermission(ctx context.Context, repo memberRepository, member memberRecheckRow, role string, unchanged bool, poll *memberPermissionPoll, binding memberPollBinding) (string, error) {
	tx, err := m.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if poll != nil {
		current, err := lockFetchedRepo(ctx, tx, binding.stream.registry)
		if err != nil {
			return "", err
		}
		if permissionBinding(repo, current) != binding {
			return "", githubSyncUnavailable()
		}
		if err := poll.synced.authorizeFetched(ctx, current); err != nil {
			return "", err
		}
	}
	if _, err = tx.Exec(ctx, `SELECT user_id FROM self_host_owners FOR UPDATE`); err != nil {
		return "", err
	}
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='github.repository' FOR SHARE`).Scan(&raw); err != nil {
		return "", err
	}
	var current memberRepository
	if json.Unmarshal(raw, &current) != nil || current != repo {
		return "", githubSyncUnavailable()
	}
	var version, login string
	err = tx.QueryRow(ctx, `SELECT c.xmin::text,coalesce(c.github_login,u.username)
 FROM collaborators c LEFT JOIN users u ON u.id=c.user_id
 WHERE c.id=$1 AND c.repository_id=$2 FOR UPDATE OF c`, member.id, repo.ID).Scan(&version, &login)
	if err != nil {
		return "", err
	}
	if version != member.version || login != member.login {
		return "", fmt.Errorf("member changed during permission read")
	}
	if !unchanged {
		switch {
		case role == "" && !member.suspended:
			_, err = tx.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE id=$1`, member.id)
			if err == nil && member.user != nil {
				err = revokeMemberCredentials(ctx, tx, repo.ID, *member.user, 0)
			}
		case role != "" && member.suspended:
			_, err = tx.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE id=$1`, member.id)
			if err == nil && member.user != nil {
				_, err = tx.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, *member.user)
			}
		}
	}
	if err != nil {
		return "", err
	}
	if err = tx.QueryRow(ctx, `SELECT xmin::text FROM collaborators WHERE id=$1`, member.id).Scan(&version); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return version, nil
}
