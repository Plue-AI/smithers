package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

var memberLoginPattern = regexp.MustCompile(`(?i)^[a-z0-9](?:[a-z0-9]|-(?:[a-z0-9])){0,38}$`)

// ValidMemberLogin reports a well-formed GitHub username.
func ValidMemberLogin(login string) bool {
	return len(login) <= 39 && memberLoginPattern.MatchString(login)
}

func memberError(status int, class, code, message string) error {
	return &AccessError{Status: status, Class: class, Code: code, Message: message}
}

type memberRepository struct {
	Owner string `json:"owner_login"`
	Name  string `json:"repository_name"`
	ID    int64  `json:"repository_id"`
}

func (m *Members) repository(ctx context.Context) (memberRepository, error) {
	var repo memberRepository
	setting, err := db.New(m.Pool).GetInstallSetting(ctx, "github.repository")
	if err == nil {
		err = json.Unmarshal(setting.Value, &repo)
	}
	if err != nil || repo.ID <= 0 || !gitHubAppComponent.MatchString(repo.Owner) || !gitHubAppComponent.MatchString(repo.Name) {
		return repo, memberError(http.StatusServiceUnavailable, "infra", "unavailable", "Repository unavailable")
	}
	return repo, nil
}

func memberAPI() *landingGitHubAPI {
	return &landingGitHubAPI{client: &http.Client{Timeout: 15 * time.Second}, baseURL: func() string {
		if base := os.Getenv(envGitHubAppAPIBaseURL); base != "" {
			return base
		}
		return defaultGitHubAPIBaseURL
	}}
}

// installationAccess is an installation token for the install's repository,
// found through the App JWT; a caller never names the installation.
func (m *Members) installationAccess(ctx context.Context, repo memberRepository) (string, error) {
	if m.Credentials == nil {
		return "", ErrGitHubAppNotConfigured
	}
	jwt, err := m.Credentials.AppJWT(ctx)
	if err != nil {
		return "", err
	}
	api := memberAPI()
	var installation struct {
		ID int64 `json:"id"`
	}
	status, err := api.request(ctx, jwt, http.MethodGet, landingGitHubRepoPath(repo.Owner, repo.Name)+"/installation", nil, &installation)
	if err != nil || status != http.StatusOK || installation.ID <= 0 {
		return "", memberError(http.StatusServiceUnavailable, "infra", "github_unavailable", "GitHub unavailable")
	}
	var access struct {
		Token string `json:"token"`
	}
	status, err = api.request(ctx, jwt, http.MethodPost, fmt.Sprintf("/app/installations/%d/access_tokens", installation.ID), nil, &access)
	if err != nil || status != http.StatusCreated || access.Token == "" {
		return "", memberError(http.StatusServiceUnavailable, "infra", "github_unavailable", "GitHub unavailable")
	}
	return access.Token, nil
}

// githubMemberRole seeds a role from GitHub's answer. GitHub's legacy
// permission reports maintain as write, so role_name decides: admin or
// maintain is a Maintainer (collaborators admin), write a Member.
func githubMemberRole(permission, role string) string {
	if permission == "admin" || role == "admin" || role == "maintain" {
		return "admin"
	}
	if permission == "write" || role == "write" {
		return "write"
	}
	return ""
}

func (m *Members) permission(ctx context.Context, token string, repo memberRepository, login string) (string, error) {
	var out struct {
		Permission string `json:"permission"`
		Role       string `json:"role_name"`
	}
	status, err := memberAPI().request(ctx, token, http.MethodGet, landingGitHubRepoPath(repo.Owner, repo.Name)+"/collaborators/"+login+"/permission", nil, &out)
	if err != nil || (status != http.StatusOK && status != http.StatusNotFound) {
		return "", memberError(http.StatusServiceUnavailable, "infra", "github_unavailable", "GitHub unavailable")
	}
	return githubMemberRole(out.Permission, out.Role), nil
}

// AdmitGitHub runs before a sign-in writes any identity: the GitHub account
// must hold an active roster row, found by its immutable GitHub id, and
// write access on GitHub now. The owner's own account and the claim before
// any owner exists are the exceptions.
func (m *Members) AdmitGitHub(ctx context.Context, id int64, login string) error {
	owner, err := db.New(m.Pool).GetSelfHostOwner(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var ownerGitHubID string
	err = m.Pool.QueryRow(ctx, `SELECT provider_user_id FROM oauth_accounts WHERE user_id=$1 AND provider='workos'`, owner.ID).Scan(&ownerGitHubID)
	if err == nil && ownerGitHubID == strconv.FormatInt(id, 10) {
		return nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	repo, err := m.repository(ctx)
	if err != nil {
		return err
	}
	var listed bool
	err = m.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaborators WHERE repository_id=$1 AND github_id=$2 AND suspended_at IS NULL)`, repo.ID, id).Scan(&listed)
	if err != nil {
		return err
	}
	if !listed {
		return memberError(http.StatusForbidden, "permission", "not_a_member", "Not a member")
	}
	token, err := m.installationAccess(ctx, repo)
	if err != nil {
		return err
	}
	role, err := m.permission(ctx, token, repo, login)
	if err != nil {
		return err
	}
	if role == "" {
		return memberError(http.StatusForbidden, "permission", "needs_github_access", "Needs access on GitHub ↗")
	}
	return nil
}

// LinkGitHub binds the roster row a maintainer added by username to the
// account that signed in with that GitHub id.
func (m *Members) LinkGitHub(ctx context.Context, id, userID int64, login string) error {
	repo, err := m.repository(ctx)
	if err != nil {
		// No repository is bound yet (the owner signs in during setup), so
		// no roster row can name this account.
		return nil
	}
	_, err = m.Pool.Exec(ctx, `UPDATE collaborators SET user_id=$3,github_login=$4 WHERE repository_id=$1 AND github_id=$2 AND suspended_at IS NULL AND (user_id IS NULL OR user_id=$3)`, repo.ID, id, userID, login)
	return err
}

// Add puts a GitHub user on the roster. Their role seeds from their GitHub
// permission; a person without write access there is refused with no row.
func (m *Members) Add(ctx context.Context, login string) error {
	if _, err := Authorize(ctx, db.New(m.Pool), "members.write"); err != nil {
		return err
	}
	if !ValidMemberLogin(login) {
		return memberError(http.StatusBadRequest, "user", "invalid_login", "Enter a GitHub username")
	}
	repo, err := m.repository(ctx)
	if err != nil {
		return err
	}
	token, err := m.installationAccess(ctx, repo)
	if err != nil {
		return err
	}
	var user struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	status, err := memberAPI().request(ctx, token, http.MethodGet, "/users/"+login, nil, &user)
	if err != nil || (status != http.StatusOK && status != http.StatusNotFound) {
		return memberError(http.StatusServiceUnavailable, "infra", "github_unavailable", "GitHub unavailable")
	}
	if status == http.StatusNotFound || user.ID <= 0 || !ValidMemberLogin(user.Login) {
		return memberError(http.StatusNotFound, "user", "unknown_github_user", "Unknown GitHub user")
	}
	role, err := m.permission(ctx, token, repo, user.Login)
	if err != nil {
		return err
	}
	if role == "" {
		return memberError(http.StatusForbidden, "permission", "needs_github_access", "Needs access on GitHub ↗")
	}
	tx, _, err := m.memberMutation(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	githubID := strconv.FormatInt(user.ID, 10)
	// A person already on the roster, by GitHub id or by account, keeps their
	// row and role: adding again changes nothing.
	tag, err := tx.Exec(ctx, `INSERT INTO collaborators(repository_id,github_id,github_login,user_id,permission)
 VALUES($1,$2,$3,(SELECT user_id FROM oauth_accounts WHERE provider='workos' AND provider_user_id=$4),$5)
 ON CONFLICT DO NOTHING`, repo.ID, user.ID, user.Login, githubID, role)
	if err != nil {
		return err
	}
	// Removal barred the account from signing in; being added again lifts it.
	if tag.RowsAffected() == 1 {
		if _, err = tx.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=(SELECT user_id FROM oauth_accounts WHERE provider='workos' AND provider_user_id=$1) AND id<>(SELECT user_id FROM self_host_owners WHERE singleton)`, githubID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// MemberProjection is one Members card row (packages/rpc MembersCard).
type MemberProjection struct {
	Login       string           `json:"login"`
	Name        string           `json:"name"`
	AvatarURL   string           `json:"avatar_url"`
	ColorIndex  int              `json:"color_index"`
	Role        string           `json:"role"`
	NeedsAccess bool             `json:"needs_access"`
	Suspended   bool             `json:"suspended"`
	Actions     []map[string]any `json:"actions"`
}

// MembersProjection is the Members card.
type MembersProjection struct {
	Members   []MemberProjection `json:"members"`
	AccessURL string             `json:"access_url"`
}

// List is the roster: the owner first, then everyone added, in order.
func (m *Members) List(ctx context.Context) (MembersProjection, error) {
	out := MembersProjection{Members: []MemberProjection{}}
	decision, err := Authorize(ctx, db.New(m.Pool), "members.list")
	if err != nil {
		return out, err
	}
	repo, err := m.repository(ctx)
	if err != nil {
		return out, err
	}
	out.AccessURL = "https://github.com/" + repo.Owner + "/" + repo.Name + "/settings/access"
	rows, err := m.Pool.Query(ctx, `SELECT coalesce(c.github_login,u.username),coalesce(nullif(u.display_name,''),c.github_login,u.username),c.permission,c.suspended_at IS NOT NULL,coalesce(c.user_id=o.user_id,false)
 FROM collaborators c LEFT JOIN users u ON u.id=c.user_id CROSS JOIN self_host_owners o
 WHERE c.repository_id=$1 AND (c.user_id IS NOT NULL OR c.github_id IS NOT NULL)
 ORDER BY coalesce(c.user_id=o.user_id,false) DESC,c.id`, repo.ID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	canWrite := decision.Role.rank() >= InstallMaintainer.rank()
	for rows.Next() {
		var row MemberProjection
		var permission string
		var owner bool
		if err = rows.Scan(&row.Login, &row.Name, &permission, &row.Suspended, &owner); err != nil {
			return out, err
		}
		row.Role = string(InstallMember)
		if permission == "admin" {
			row.Role = string(InstallMaintainer)
		}
		if owner {
			row.Role = string(InstallOwner)
		}
		row.AvatarURL = "https://github.com/" + row.Login + ".png"
		row.ColorIndex = len(out.Members) % 6
		row.Actions = []map[string]any{}
		if canWrite && !owner {
			row.Actions = []map[string]any{{"tag": "members.role", "label": "Role", "args": map[string]string{"login": row.Login}}, {"tag": "members.remove", "label": "Remove", "args": map[string]string{"login": row.Login}}}
		}
		out.Members = append(out.Members, row)
	}
	return out, rows.Err()
}

// ChangeRole sets a member's role. The owner's role never changes.
func (m *Members) ChangeRole(ctx context.Context, login, role string) error {
	if _, err := Authorize(ctx, db.New(m.Pool), "members.write"); err != nil {
		return err
	}
	if !ValidMemberLogin(login) {
		return memberError(http.StatusBadRequest, "user", "invalid_login", "Enter a GitHub username")
	}
	if role != string(InstallMember) && role != string(InstallMaintainer) && role != string(InstallOwner) {
		return memberError(http.StatusBadRequest, "user", "invalid_role", "Invalid role")
	}
	repo, err := m.repository(ctx)
	if err != nil {
		return err
	}
	tx, owner, err := m.memberMutation(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	id, userID, err := lockMemberRow(ctx, tx, repo.ID, login)
	if err != nil {
		return err
	}
	if role == string(InstallOwner) || (userID != nil && *userID == owner) {
		return memberError(http.StatusForbidden, "permission", "owner_immutable", "Owner cannot be changed")
	}
	permission := "write"
	if role == string(InstallMaintainer) {
		permission = "admin"
	}
	if _, err = tx.Exec(ctx, `UPDATE collaborators SET permission=$2 WHERE id=$1`, id, permission); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// lockMemberRow locks login's roster row, matched case-insensitively.
func lockMemberRow(ctx context.Context, tx pgx.Tx, repositoryID int64, login string) (int64, *int64, error) {
	var id int64
	var userID *int64
	err := tx.QueryRow(ctx, `SELECT c.id,c.user_id FROM collaborators c LEFT JOIN users u ON u.id=c.user_id
 WHERE c.repository_id=$1 AND lower(coalesce(c.github_login,u.username))=lower($2) FOR UPDATE OF c`, repositoryID, login).Scan(&id, &userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, memberError(http.StatusNotFound, "user", "not_found", "Member not found")
	}
	return id, userID, err
}
