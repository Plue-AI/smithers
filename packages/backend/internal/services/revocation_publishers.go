package services

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// Revocation publishing. Every service that ends an authorization announces
// it here so live consumers (SSE streams, terminal WebSockets, SSH sessions,
// desktop relays, sandbox egress proxies) terminate within seconds instead of
// at their own end of life. Publishing is best effort after the revocation
// itself succeeded: the durable change is the authority, the announcement is
// latency.

// WithAuthRevocationPublisher announces token revocations from AuthService.
func WithAuthRevocationPublisher(p revocation.Publisher) AuthServiceOption {
	return func(s *AuthService) { s.revocations = p }
}

// WithAdminRevocationPublisher announces token and user revocations from
// AdminUserService.
func WithAdminRevocationPublisher(p revocation.Publisher) AdminUserServiceOption {
	return func(s *AdminUserService) { s.revocations = p }
}

// SetRevocationPublisher announces organization membership removals.
func (s *OrgService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces OAuth2 access-token revocations.
func (s *OAuth2Service) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces deleted SSH user keys.
func (s *SSHKeyService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces deleted deploy keys.
func (s *DeployKeyService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// WithAgentRevocationPublisher announces cancelled agent sessions.
func WithAgentRevocationPublisher(p revocation.Publisher) AgentServiceOption {
	return func(s *AgentService) { s.revocations = p }
}

// WithRepoRevocationPublisher announces collaborator removals.
func WithRepoRevocationPublisher(p revocation.Publisher) RepoServiceOption {
	return func(s *RepoService) { s.revocations = p }
}

// accessTokenHashReader is the optional store surface that lets a token
// revocation carry the hash live consumers were authorized under.
type accessTokenHashReader interface {
	GetAccessTokenHashByID(ctx context.Context, id int64) (db.GetAccessTokenHashByIDRow, error)
}

// workspaceLister resolves a user's workspace VMs in a repository so a
// repository-level revocation can name the SSH sessions it ends.
type workspaceLister interface {
	ListWorkspacesByRepo(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error)
}

type collaboratorLister interface {
	ListCollaboratorsByRepo(ctx context.Context, repositoryID int64) ([]db.Collaborator, error)
}

type workspaceGetter interface {
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
}

// workspaceVMIDs returns the VM ids of a user's live workspaces in a
// repository, or nil when the store cannot list them.
func workspaceVMIDs(ctx context.Context, store any, repositoryID, userID int64) []string {
	lister, ok := store.(workspaceLister)
	if !ok {
		return nil
	}
	var ids []string
	for offset := int32(0); ; offset += 200 {
		rows, err := lister.ListWorkspacesByRepo(ctx, db.ListWorkspacesByRepoParams{RepositoryID: repositoryID, UserID: userID, PageOffset: offset, PageSize: 200})
		if err != nil {
			return ids
		}
		for _, row := range rows {
			if row.VmID != "" {
				ids = append(ids, row.VmID)
			}
		}
		if len(rows) < 200 {
			break
		}
	}
	return ids
}

type orgRepositoryLister interface {
	ListOrgRepos(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error)
}

// organizationWorkspaceVMIDs resolves every repository owned by an
// organization, then names every live workspace VM the removed member owns in
// those repositories. SSH principals know the sandbox, not the organization,
// so the concrete VM ids are required to end those sessions.
func organizationWorkspaceVMIDs(ctx context.Context, store any, organizationID, userID int64) []string {
	repos, ok := store.(orgRepositoryLister)
	if !ok {
		return nil
	}
	seen := make(map[string]struct{})
	var ids []string
	for offset := int32(0); ; offset += 200 {
		rows, err := repos.ListOrgRepos(ctx, db.ListOrgReposParams{
			OrgID:      pgtype.Int8{Int64: organizationID, Valid: organizationID != 0},
			PageOffset: offset,
			PageSize:   200,
		})
		if err != nil {
			return ids
		}
		for _, repository := range rows {
			for _, id := range workspaceVMIDs(ctx, store, repository.ID, userID) {
				if _, exists := seen[id]; exists {
					continue
				}
				seen[id] = struct{}{}
				ids = append(ids, id)
			}
		}
		if len(rows) < 200 {
			break
		}
	}
	return ids
}

// collaboratorsOf lists a repository's collaborators before they are dropped,
// so the removal can be announced per user afterwards.
func (s *RepoService) collaboratorsOf(ctx context.Context, repositoryID int64) []db.Collaborator {
	if s == nil || s.revocations == nil {
		return nil
	}
	lister, ok := s.queries.(collaboratorLister)
	if !ok {
		return nil
	}
	rows, err := lister.ListCollaboratorsByRepo(ctx, repositoryID)
	if err != nil {
		return nil
	}
	return rows
}

// publishCollaboratorsRemoved announces every collaborator dropped from a
// repository, naming each user's workspace VMs so SSH sessions end too.
func (s *RepoService) publishCollaboratorsRemoved(ctx context.Context, repositoryID int64, removed []db.Collaborator, actorID int64, reason string) {
	if s == nil || s.revocations == nil {
		return
	}
	for _, collaborator := range removed {
		if !collaborator.UserID.Valid {
			continue
		}
		userID := collaborator.UserID.Int64
		revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
			Kind:         revocation.KindCollaboratorRemoved,
			UserID:       userID,
			RepositoryID: repositoryID,
			SandboxIDs:   workspaceVMIDs(ctx, s.queries, repositoryID, userID),
			Reason:       reason,
			ActorID:      actorID,
		})
	}
}

// adminActorID names the acting administrator for an event, or 0 when the
// mutation did not come through an admin route.
func adminActorID(ctx context.Context) int64 {
	if actor, ok := AdminAuditActorFromContext(ctx); ok {
		return actor.UserID
	}
	return 0
}

// SetRevocationPublisher announces token deletions.
func (s *AuthService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces admin token revocations and user suspensions.
func (s *AdminUserService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces cancelled agent sessions.
func (s *AgentService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// SetRevocationPublisher announces collaborator removals.
func (s *RepoService) SetRevocationPublisher(p revocation.Publisher) { s.revocations = p }

// teamGrants is the access a team conferred before a mutation: every member
// on every team repository, at the team's permission.
type teamGrants struct {
	permission string
	userIDs    []int64
	repos      []db.Repository
}

// teamGrantsOf snapshots a team's grants before a mutation removes some of
// them. userIDs or repos narrow the snapshot; nil lists every team member or
// team repository. It returns nothing when no publisher is wired.
func (s *OrgService) teamGrantsOf(ctx context.Context, team db.Team, userIDs []int64, repos []db.Repository) teamGrants {
	if s == nil || s.revocations == nil {
		return teamGrants{}
	}
	if userIDs == nil {
		for offset := int32(0); ; offset += 200 {
			rows, err := s.queries.ListTeamMembers(ctx, db.ListTeamMembersParams{TeamID: team.ID, PageOffset: offset, PageSize: 200})
			if err != nil {
				slog.Error("list team members for revocation failed", "team_id", team.ID, "error", err)
				break
			}
			for _, row := range rows {
				userIDs = append(userIDs, row.ID)
			}
			if len(rows) < 200 {
				break
			}
		}
	}
	if repos == nil {
		for offset := int32(0); ; offset += 200 {
			rows, err := s.queries.ListTeamRepos(ctx, db.ListTeamReposParams{TeamID: team.ID, PageOffset: offset, PageSize: 200})
			if err != nil {
				slog.Error("list team repositories for revocation failed", "team_id", team.ID, "error", err)
				break
			}
			repos = append(repos, rows...)
			if len(rows) < 200 {
				break
			}
		}
	}
	return teamGrants{permission: team.Permission, userIDs: userIDs, repos: repos}
}

// publishTeamAccessLost announces every (user, repository) pair whose
// effective permission fell below what the team granted before the mutation.
// A user who keeps that access through ownership, another team or a
// collaborator grant is left alone. When the permission cannot be resolved,
// the pair is announced: ending a stream the user may reopen is safer than
// leaving one open that should have closed.
func (s *OrgService) publishTeamAccessLost(ctx context.Context, grants teamGrants, actorID int64, reason string) {
	if s == nil || s.revocations == nil {
		return
	}
	granted := repoPermissionRank(grants.permission)
	perms, canResolve := s.queries.(RepoPermQuerier)
	for _, repository := range grants.repos {
		for _, userID := range grants.userIDs {
			if canResolve {
				permission, isOwner, err := repoPermissionForUser(ctx, perms, repository, userID)
				if err == nil && (isOwner || repoPermissionRank(permission) >= granted) {
					continue
				}
			}
			revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
				Kind:         revocation.KindCollaboratorRemoved,
				UserID:       userID,
				RepositoryID: repository.ID,
				SandboxIDs:   workspaceVMIDs(ctx, s.queries, repository.ID, userID),
				Reason:       reason,
				ActorID:      actorID,
			})
		}
	}
}

type teamMemberLister interface {
	ListTeamMembers(ctx context.Context, arg db.ListTeamMembersParams) ([]db.User, error)
}

type orgMemberLister interface {
	ListOrgMembers(ctx context.Context, arg db.ListOrgMembersParams) ([]db.ListOrgMembersRow, error)
}

// ownershipAccessHoldersOf lists the users whose access to a repository comes
// from its owner rather than a collaborator row: the personal owner, the
// owning organization's owners, and members of teams granted the repository.
// A transfer ends these grants, so the caller captures them before it.
func (s *RepoService) ownershipAccessHoldersOf(ctx context.Context, repository db.Repository) []int64 {
	if s == nil || s.revocations == nil {
		return nil
	}
	seen := make(map[int64]struct{})
	var ids []int64
	add := func(id int64) {
		if _, ok := seen[id]; ok || id <= 0 {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if repository.UserID.Valid {
		add(repository.UserID.Int64)
	}
	if !repository.OrgID.Valid {
		return ids
	}
	if members, ok := s.queries.(orgMemberLister); ok {
		for offset := int32(0); ; offset += 200 {
			rows, err := members.ListOrgMembers(ctx, db.ListOrgMembersParams{OrganizationID: repository.OrgID.Int64, PageOffset: offset, PageSize: 200})
			if err != nil {
				slog.Error("list organization owners for revocation failed", "repo_id", repository.ID, "error", err)
				break
			}
			for _, row := range rows {
				if row.Role == "owner" {
					add(row.ID)
				}
			}
			if len(rows) < 200 {
				break
			}
		}
	}
	if members, ok := s.queries.(teamMemberLister); ok {
		teams, err := s.queries.ListTeamReposByRepo(ctx, repository.ID)
		if err != nil {
			slog.Error("list repository teams for revocation failed", "repo_id", repository.ID, "error", err)
		}
		for _, team := range teams {
			for offset := int32(0); ; offset += 200 {
				rows, err := members.ListTeamMembers(ctx, db.ListTeamMembersParams{TeamID: team.TeamID, PageOffset: offset, PageSize: 200})
				if err != nil {
					slog.Error("list team members for revocation failed", "team_id", team.TeamID, "error", err)
					break
				}
				for _, row := range rows {
					add(row.ID)
				}
				if len(rows) < 200 {
					break
				}
			}
		}
	}
	return ids
}

// publishAccessLost announces each user who holds no grant on repository
// after an ownership change. repository is the post-change row.
func (s *RepoService) publishAccessLost(ctx context.Context, repository db.Repository, userIDs []int64, reason string) {
	if s == nil || s.revocations == nil {
		return
	}
	for _, userID := range userIDs {
		permission, isOwner, err := repoPermissionForUser(ctx, s.queries, repository, userID)
		if err == nil && (isOwner || permission != "") {
			continue
		}
		revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
			Kind:         revocation.KindCollaboratorRemoved,
			UserID:       userID,
			RepositoryID: repository.ID,
			SandboxIDs:   workspaceVMIDs(ctx, s.queries, repository.ID, userID),
			Reason:       reason,
		})
	}
}
