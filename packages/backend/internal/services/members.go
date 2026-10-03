package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitHubSignIn is one completed GitHub sign-in on the install. Identity
// comes from GitHub's API with the person's own token, never from the
// caller.
type GitHubSignIn struct {
	GitHubUserID int64
	Login        string
	Name         string
	// Email is GitHub-verified, or empty.
	Email string
	// SetupTokenDigest is set when the sign-in started from the setup URL.
	SetupTokenDigest string
}

// InstallRepository is the install's one GitHub repository and an
// installation token that may read its collaborators.
type InstallRepository struct {
	Owner, Name, Token string
}

// InstallRepositoryReader answers the install's repository for the sign-in
// gate's push check (spec §5.1.2). found is false until setup records one.
type InstallRepositoryReader interface {
	InstallRepository(ctx context.Context) (repository InstallRepository, found bool, err error)
}

// SignInGate decides whether a GitHub sign-in may enter the install.
type SignInGate interface {
	AdmitSignIn(ctx context.Context, signIn GitHubSignIn) (db.User, error)
}

// MemberService owns the install's roster at sign-in (spec §5.1). Until
// T-ACC-02 adds members, the roster is the owner.
type MemberService struct {
	pool       *pgxpool.Pool
	repository InstallRepositoryReader
	github     *landingGitHubAPI
}

func NewMemberService(pool *pgxpool.Pool, repository InstallRepositoryReader) *MemberService {
	return &MemberService{pool: pool, repository: repository,
		github: &landingGitHubAPI{client: observability.NewHTTPClient(10 * time.Second), baseURL: githubAPIBaseURL}}
}

// AdmitSignIn admits a GitHub sign-in and answers the users row it signs in
// as. Before the install has an owner, only a sign-in carrying the current
// setup token may claim it. Afterwards the person must be on the roster.
// Either way the person must have push access or higher on the install's
// repository; a GitHub failure refuses (fail closed). Setup claims the owner
// before the owner picks the repository (spec §16.2), so until one is
// recorded the owner passes without a push check and anyone else is refused.
func (s *MemberService) AdmitSignIn(ctx context.Context, signIn GitHubSignIn) (db.User, error) {
	if signIn.GitHubUserID <= 0 || strings.TrimSpace(signIn.Login) == "" {
		return db.User{}, pkgerrors.BadRequest("GitHub returned no account")
	}
	queries := db.New(s.pool)
	hasOwner, err := queries.InstallHasOwner(ctx)
	if err != nil {
		return db.User{}, pkgerrors.Internal("failed to read the install owner").WithCause(err)
	}
	if !hasOwner {
		return s.claimOwner(ctx, signIn)
	}
	member, err := queries.GetSignInMember(ctx, pgtype.Int8{Int64: signIn.GitHubUserID, Valid: true})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.User{}, pkgerrors.New(pkgerrors.CodeNotAMember, "not a member of this install")
		}
		return db.User{}, pkgerrors.Internal("failed to read the roster").WithCause(err)
	}
	if err := s.requirePush(ctx, signIn.Login, member.Role == memberRoleOwner); err != nil {
		return db.User{}, err
	}
	user, err := queries.GetUserByID(ctx, member.UserID)
	if err != nil {
		return db.User{}, pkgerrors.Internal("failed to load the member").WithCause(err)
	}
	return user, nil
}

// VerifySetupToken checks a sign-in's setup token before the GitHub round
// trip without consuming it; only the claim consumes it. Once the install has
// an owner the token plays no part, and the roster decides at the callback.
func (s *MemberService) VerifySetupToken(ctx context.Context, token string) error {
	queries := db.New(s.pool)
	hasOwner, err := queries.InstallHasOwner(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to read the install owner").WithCause(err)
	}
	if hasOwner {
		return nil
	}
	stored, err := queries.GetInstallSetting(ctx, setupTokenKey)
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Internal("failed to read the setup token").WithCause(err)
	}
	if err != nil || !setupTokenMatches(stored, SetupTokenDigest(token)) {
		return errSetupTokenInvalid()
	}
	return nil
}

// claimOwner makes the sign-in the install's owner when it carries the
// current setup token and the person may push, then deletes the token. The
// token row is locked for the claim, so of two concurrent claims one wins
// and the other finds no token.
func (s *MemberService) claimOwner(ctx context.Context, signIn GitHubSignIn) (db.User, error) {
	if signIn.SetupTokenDigest == "" {
		return db.User{}, errSetupTokenInvalid()
	}
	queries := db.New(s.pool)
	stored, err := queries.GetInstallSetting(ctx, setupTokenKey)
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
		return db.User{}, pkgerrors.Internal("failed to read the setup token").WithCause(err)
	}
	if err != nil || !setupTokenMatches(stored, signIn.SetupTokenDigest) {
		return db.User{}, errSetupTokenInvalid()
	}
	if err := s.requirePush(ctx, signIn.Login, true); err != nil {
		return db.User{}, err
	}

	var owner db.User
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := db.New(tx)
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", installSetupOwnerLockID); err != nil {
			return err
		}
		locked, err := q.LockInstallSetting(ctx, setupTokenKey)
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return errSetupTokenInvalid()
			}
			return pkgerrors.Internal("failed to lock the setup token").WithCause(err)
		}
		if !setupTokenMatches(locked, signIn.SetupTokenDigest) {
			return errSetupTokenInvalid()
		}
		owner, err = ownerUser(ctx, q, signIn)
		if err != nil {
			return err
		}
		if _, err := q.CreateOwnerMember(ctx, db.CreateOwnerMemberParams{
			UserID:       owner.ID,
			GithubUserID: pgtype.Int8{Int64: signIn.GitHubUserID, Valid: true},
			Login:        signIn.Login,
		}); err != nil {
			if isUniqueViolation(err) {
				return errSetupTokenInvalid()
			}
			return pkgerrors.Internal("failed to record the owner").WithCause(err)
		}
		if _, err := q.DeleteInstallSetting(ctx, setupTokenKey); err != nil {
			return pkgerrors.Internal("failed to delete the setup token").WithCause(err)
		}
		return nil
	})
	if err != nil {
		var apiErr *pkgerrors.APIError
		if stdErrors.As(err, &apiErr) {
			return db.User{}, apiErr
		}
		return db.User{}, pkgerrors.Internal("failed to claim the install").WithCause(err)
	}
	return owner, nil
}

// githubOAuthProvider is the oauth_accounts provider label of GitHub sign-in
// (historical; see CompleteGitHubOAuth).
const githubOAuthProvider = "workos"

// ownerUser is the claimant's users row: the one already linked to this
// GitHub account, or a new one.
func ownerUser(ctx context.Context, q *db.Queries, signIn GitHubSignIn) (db.User, error) {
	account, err := q.GetOAuthAccountByProviderUserID(ctx, db.GetOAuthAccountByProviderUserIDParams{
		Provider: githubOAuthProvider, ProviderUserID: strconv.FormatInt(signIn.GitHubUserID, 10),
	})
	if err == nil {
		user, err := q.GetUserByID(ctx, account.UserID)
		if err != nil {
			return db.User{}, pkgerrors.Internal("failed to load the owner").WithCause(err)
		}
		return user, nil
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return db.User{}, pkgerrors.Internal("failed to read the GitHub account").WithCause(err)
	}
	email := pgtype.Text{String: signIn.Email, Valid: signIn.Email != ""}
	user, err := q.CreateOwnerUser(ctx, db.CreateOwnerUserParams{
		Username:      signIn.Login,
		LowerUsername: strings.ToLower(signIn.Login),
		Email:         email,
		LowerEmail:    pgtype.Text{String: strings.ToLower(signIn.Email), Valid: signIn.Email != ""},
		DisplayName:   firstNonEmpty(signIn.Name, signIn.Login),
	})
	if err != nil {
		if isUniqueViolation(err) {
			return db.User{}, pkgerrors.Conflict("username or email is already in use")
		}
		return db.User{}, pkgerrors.Internal("failed to create the owner").WithCause(err)
	}
	return user, nil
}

// memberRoleOwner is the members.role of the install's owner.
const memberRoleOwner = "owner"

// requirePush refuses a person without push access or higher on the
// install's repository, read live with an installation token. Before setup
// records the repository only the owner passes.
func (s *MemberService) requirePush(ctx context.Context, login string, owner bool) error {
	if s.repository == nil {
		return pkgerrors.Internal("the install repository is not configured")
	}
	repository, found, err := s.repository.InstallRepository(ctx)
	if err != nil {
		return err
	}
	if !found {
		if owner {
			return nil
		}
		return pkgerrors.New(pkgerrors.CodeInstallRepositoryUnset, "the install has no repository yet; the owner picks it in setup")
	}
	permission, err := readGitHubRepoPermission(ctx, s.github, repository.Token, repository.Owner, repository.Name, login)
	if err != nil {
		return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub did not answer whether you can push to "+repository.Owner+"/"+repository.Name).WithCause(err)
	}
	if !permission.CanPush() {
		refusal := pkgerrors.New(pkgerrors.CodeNeedsGitHubAccess, "needs access on GitHub: push to "+repository.Owner+"/"+repository.Name)
		// The repository's access page is where an admin grants it.
		refusal.Details = map[string]string{"fix": "https://github.com/" + url.PathEscape(repository.Owner) + "/" + url.PathEscape(repository.Name) + "/settings/access"}
		return refusal
	}
	return nil
}

// installRepositoryKey names the install_settings row recording the
// install's repository, {"owner","name"}. Setup writes it when the GitHub
// App is installed on the repository (spec §16.2 step 2).
const installRepositoryKey = "github_repository"

type installRepositorySetting struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
}

// SettingsInstallRepository reads the install's repository from
// install_settings and mints a read-only installation token for it with the
// GitHub App.
type SettingsInstallRepository struct {
	queries interface {
		GetInstallSetting(ctx context.Context, key string) (json.RawMessage, error)
	}
	installations *GitHubUserReposService
}

func NewSettingsInstallRepository(queries *db.Queries, installations *GitHubUserReposService) *SettingsInstallRepository {
	return &SettingsInstallRepository{queries: queries, installations: installations}
}

// PutInstallRepository records the install's repository.
func PutInstallRepository(ctx context.Context, queries interface {
	PutInstallSetting(ctx context.Context, arg db.PutInstallSettingParams) error
}, owner, name string) error {
	value, err := json.Marshal(installRepositorySetting{Owner: owner, Name: name})
	if err != nil {
		return err
	}
	return queries.PutInstallSetting(ctx, db.PutInstallSettingParams{Key: installRepositoryKey, Value: value})
}

func (r *SettingsInstallRepository) InstallRepository(ctx context.Context) (InstallRepository, bool, error) {
	raw, err := r.queries.GetInstallSetting(ctx, installRepositoryKey)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return InstallRepository{}, false, nil
		}
		return InstallRepository{}, false, pkgerrors.Internal("failed to read the install repository").WithCause(err)
	}
	var setting installRepositorySetting
	if err := json.Unmarshal(raw, &setting); err != nil || setting.Owner == "" || setting.Name == "" {
		return InstallRepository{}, false, pkgerrors.Internal("the install repository setting is invalid")
	}
	installation, found, err := r.installations.lookupRepoInstallation(ctx, setting.Owner, setting.Name)
	if err != nil {
		return InstallRepository{}, false, pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub did not answer for "+setting.Owner+"/"+setting.Name).WithCause(err)
	}
	if !found {
		return InstallRepository{}, false, pkgerrors.New(pkgerrors.CodeInstallRepositoryUnset, "the GitHub App is not installed on "+setting.Owner+"/"+setting.Name)
	}
	token, err := mintGitHubInstallationToken(ctx, installation.ID, &gitHubInstallationTokenScope{
		Repositories: []string{setting.Name},
		Permissions:  map[string]string{"metadata": "read"},
	})
	if err != nil {
		return InstallRepository{}, false, pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub did not issue a token for "+setting.Owner+"/"+setting.Name).WithCause(err)
	}
	return InstallRepository{Owner: setting.Owner, Name: setting.Name, Token: token.Token}, true, nil
}
