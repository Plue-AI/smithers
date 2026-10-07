package services

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A fetched check snapshot is a wakeup, never approval or proof of readiness.
// The existing merge worker rechecks current authority, head and protection.
// The request and delivery receipt commit together; stale heads wake nothing.
func (s *MythicalService) consumeGitHubCheckTodos(ctx context.Context, tx pgx.Tx, fetched gitHubFetchedObject) (json.RawMessage, error) {
	source, err := lockFetchedRepo(ctx, tx, fetched.Repo)
	if err != nil {
		return nil, err
	}
	if s.installGitHubSync == nil || source.GithubRepositoryID.Int64 != fetched.GitHubRepository || source.InstallationID.Int64 != fetched.Installation {
		return nil, gitHubFetchUnavailable()
	}
	if err := s.installGitHubSync.authorizeFetched(ctx, source); err != nil {
		return nil, err
	}
	var snapshot struct {
		Head string `json:"head"`
	}
	if json.Unmarshal(fetched.Object, &snapshot) != nil || !mythicalHead.MatchString(snapshot.Head) {
		return nil, gitHubFetchUnavailable()
	}
	q := db.New(tx)
	install, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return nil, err
	}
	repositories, err := q.ListRepositoryIDsForGitHubSource(ctx, source.OwnerLogin, source.RepoName)
	if err != nil {
		return nil, err
	}
	woken := 0
	for _, repository := range repositories {
		if repository != install {
			continue
		}
		owner, repo, err := resolveGitHubDestination(ctx, q, nil, 0, repository, "", "")
		if err != nil {
			return nil, err
		}
		if !strings.EqualFold(owner, source.OwnerLogin) || !strings.EqualFold(repo, source.RepoName) {
			continue
		}
		items, err := q.ListMythicalGitHubBranchItems(ctx, repository)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if !mythicalTodo(item) || !item.PRNumber.Valid || item.PRNumber.Int64 != fetched.Number || item.PRHead != snapshot.Head || mythicalSettledStates[item.State] {
				continue
			}
			affected, err := q.RequestMythicalStack(ctx, repository)
			if err != nil {
				return nil, err
			}
			woken += int(affected)
			break
		}
	}
	return json.Marshal(map[string]any{"woken": woken, "head": snapshot.Head})
}
