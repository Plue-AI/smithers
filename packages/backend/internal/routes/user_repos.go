package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type UserReposQuerier interface {
	CountReadableReposForUser(ctx context.Context, userID int64) (int64, error)
	ListReadableReposForUser(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error)
}

type UserReposHandler struct {
	Queries UserReposQuerier
}

type userReposEnvelope struct {
	Repos []userRepoRow `json:"repos"`
}

type userRepoRow struct {
	ID           int64  `json:"id"`
	RepositoryID int64  `json:"repository_id"`
	Owner        string `json:"owner"`
	RepoOwner    string `json:"repo_owner"`
	Name         string `json:"name"`
	RepoName     string `json:"repo_name"`
	FullName     string `json:"full_name"`
}

func NewUserReposHandler(queries UserReposQuerier) *UserReposHandler {
	return &UserReposHandler{Queries: queries}
}

// ListUserRepos handles GET /api/user/repos.
func (h *UserReposHandler) ListUserRepos(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	total, err := h.Queries.CountReadableReposForUser(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	rows, err := h.Queries.ListReadableReposForUser(r.Context(), db.ListReadableReposForUserParams{
		UserID:     user.ID,
		PageOffset: clampOffsetInt32(cursorToOffset(cursor)),
		PageSize:   int32(limit),
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	resp := userReposEnvelope{
		Repos: make([]userRepoRow, 0, len(rows)),
	}
	for _, row := range rows {
		fullName := row.Owner + "/" + row.Name
		resp.Repos = append(resp.Repos, userRepoRow{
			ID:           row.ID,
			RepositoryID: row.ID,
			Owner:        row.Owner,
			RepoOwner:    row.Owner,
			Name:         row.Name,
			RepoName:     row.Name,
			FullName:     fullName,
		})
	}

	setPaginationHeaders(w, r, cursor, limit, len(resp.Repos), total)
	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}
