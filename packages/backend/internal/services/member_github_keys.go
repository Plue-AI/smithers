package services

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// SyncGitHubKeys imports public keys only into unprivileged host storage. The
// user lock serializes sign-in and polling; the roster lock fences removal.
func (m *Members) SyncGitHubKeys(ctx context.Context, userID int64, login string) error {
	if !ValidMemberLogin(login) {
		return fmt.Errorf("invalid GitHub key login")
	}
	tx, err := m.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var claimed bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM self_host_owners)`).Scan(&claimed); err != nil {
		return err
	}
	if !claimed {
		return nil
	} // The setup-token claim has not admitted this identity yet.
	// Owner setup precedes binding a repository. All other users must have a
	// current, linked, unsuspended roster row before any keys can be imported.
	var owner bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM self_host_owners WHERE user_id=$1)`, userID).Scan(&owner); err != nil {
		return err
	}
	if !owner {
		repositoryID, err := InstallRepositoryID(ctx, db.New(tx))
		if err != nil {
			return err
		}
		var id int64
		if err = tx.QueryRow(ctx, `SELECT c.id FROM collaborators c WHERE c.repository_id=$3 AND c.user_id=$1 AND lower(c.github_login)=lower($2) AND c.suspended_at IS NULL FOR SHARE OF c`, userID, login, repositoryID).Scan(&id); err != nil {
			return err
		}
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT NOT prohibit_login FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&active); err != nil {
		return err
	}
	if !active {
		return fmt.Errorf("member access revoked")
	}
	settingKey := fmt.Sprintf("github.keys.%d", userID)
	var raw []byte
	var validator struct {
		Login string `json:"login"`
		ETag  string `json:"etag"`
	}
	err = tx.QueryRow(ctx, `SELECT value FROM install_settings WHERE key=$1`, settingKey).Scan(&raw)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if len(raw) > 0 {
		if err = json.Unmarshal(raw, &validator); err != nil {
			return err
		}
	}
	etag := ""
	if validator.Login == login {
		etag = validator.ETag
	}
	// An incomplete paginated result must never revoke the keys on later pages.
	type githubKey struct {
		ID  int64  `json:"id"`
		Key string `json:"key"`
	}
	var keys []githubKey
	status, headers, err := m.api(15*time.Second).requestHeaders(ctx, "", http.MethodGet, "/users/"+url.PathEscape(login)+"/keys?per_page=100", etag, nil, &keys)
	if err != nil {
		return err
	}
	if status == http.StatusNotModified && etag != "" {
		return tx.Commit(ctx)
	}
	if status != http.StatusOK {
		return landingGitHubStatusError(status, login, "keys", "read SSH keys")
	}
	validatorETag := headers.Get("ETag")
	for page := 2; strings.Contains(headers.Get("Link"), `rel="next"`); page++ {
		if page > 100 {
			return GitHubRequestFailure(ctx, "GitHub SSH key list is too large")
		}
		validatorETag = "" // A later page can change independently of page one's ETag.
		var next []githubKey
		status, headers, err = m.api(15*time.Second).requestHeaders(ctx, "", http.MethodGet, fmt.Sprintf("/users/%s/keys?per_page=100&page=%d", url.PathEscape(login), page), "", nil, &next)
		if err != nil {
			return err
		}
		if status != http.StatusOK {
			return landingGitHubStatusError(status, login, "keys", "read SSH keys")
		}
		keys = append(keys, next...)
	}
	fingerprints := make([]string, 0, len(keys))
	for _, key := range keys {
		pub, canonical, err := parseAuthorizedKey(key.Key)
		if err != nil {
			return fmt.Errorf("invalid GitHub SSH key: %w", err)
		}
		if err = validatePublicKey(pub); err != nil {
			return err
		}
		fingerprint := fingerprintSHA256(pub)
		fingerprints = append(fingerprints, fingerprint)
		// A same-user manual key stays manual. A different user's key is refused
		// by the retained global fingerprint constraint, rolling back the diff.
		_, err = tx.Exec(ctx, `INSERT INTO ssh_keys(user_id,name,public_key,fingerprint,key_type,source) VALUES($1,$2,$3,$4,$5,'github') ON CONFLICT(user_id,fingerprint) DO NOTHING`, userID, fmt.Sprintf("GitHub %d", key.ID), canonical, fingerprint, normalizeKeyType(pub))
		if err != nil {
			return err
		}
	}
	rows, err := tx.Query(ctx, `DELETE FROM ssh_keys WHERE user_id=$1 AND source='github' AND NOT(fingerprint=ANY($2::text[])) RETURNING fingerprint`, userID, fingerprints)
	if err != nil {
		return err
	}
	removed, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	publisher := revocation.NewTransactionalDBPublisher(db.New(tx))
	for _, fingerprint := range removed {
		if err = publisher.Publish(ctx, revocation.Event{Kind: revocation.KindSSHKeyRevoked, UserID: userID, KeyFingerprint: fingerprint, Reason: "GitHub SSH key removed", ActorID: userID}); err != nil {
			return err
		}
	}
	raw, err = json.Marshal(map[string]string{"login": login, "etag": validatorETag})
	if err != nil {
		return err
	}
	if err = db.New(tx).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: settingKey, Value: raw}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Key failures are independent of the committed permission decisions.
func (m *Members) syncActivePermissionKeys(ctx context.Context, repositoryID int64) {
	rows, err := m.Pool.Query(ctx, `SELECT u.id,u.username FROM users u JOIN self_host_owners o ON o.user_id=u.id
 UNION SELECT c.user_id,c.github_login FROM collaborators c WHERE c.repository_id=$1 AND c.user_id IS NOT NULL AND c.suspended_at IS NULL AND NOT EXISTS(SELECT 1 FROM self_host_owners o WHERE o.user_id=c.user_id)`, repositoryID)
	if err != nil {
		slog.WarnContext(ctx, "members.keys.failed", "error", err)
		return
	}
	type keyMember struct {
		id    int64
		login string
	}
	members, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (keyMember, error) {
		var member keyMember
		err := r.Scan(&member.id, &member.login)
		return member, err
	})
	if err != nil {
		slog.WarnContext(ctx, "members.keys.failed", "error", err)
		return
	}
	for _, member := range members {
		if err := m.SyncGitHubKeys(ctx, member.id, member.login); err != nil {
			slog.WarnContext(ctx, "members.keys.failed", "user_id", member.id, "error", err)
		}
	}
}
