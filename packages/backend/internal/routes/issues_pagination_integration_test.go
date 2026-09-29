//go:build integration

package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestNativeIssueAndCommentListsRejectLegacyLaterPages(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	queries := db.New(pool)
	ctx := context.Background()
	owner := routesIntegrationCreateUser(t, pool, "pagination_owner")
	repo := routesIntegrationCreateRepo(t, pool, owner, "pagination_public", true)

	// Gaps make a row offset different from an issue number.
	_, err := pool.Exec(ctx, `INSERT INTO issues(repository_id,number,title,author_id)
		SELECT $1,n,'issue', $2 FROM generate_series(2,24,2) n`, repo.ID, owner.ID)
	require.NoError(t, err)
	var targetID, otherID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM issues WHERE repository_id=$1 AND number=24`, repo.ID).Scan(&targetID))
	require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM issues WHERE repository_id=$1 AND number=2`, repo.ID).Scan(&otherID))
	// Allocate global IDs on another issue before creating the target comments.
	_, err = pool.Exec(ctx, `INSERT INTO issue_comments(issue_id,user_id,body)
		SELECT $1,$2,'other' FROM generate_series(1,10)`, otherID, owner.ID)
	require.NoError(t, err)
	var commentIDs []int64
	rows, err := pool.Query(ctx, `INSERT INTO issue_comments(issue_id,user_id,body)
		SELECT $1,$2,'target' FROM generate_series(1,12) RETURNING id`, targetID, owner.ID)
	require.NoError(t, err)
	for rows.Next() {
		var id int64
		require.NoError(t, rows.Scan(&id))
		commentIDs = append(commentIDs, id)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	require.Len(t, commentIDs, 12)
	require.Greater(t, commentIDs[0], int64(10))

	handler := &IssueHandler{Service: services.NewIssueService(queries)}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
		r.Use(middleware.LoadRepoContext(queries))
		r.With(middleware.RequireRepoPermission(middleware.PermissionRead)).Get("/issues", handler.ListIssues)
		r.With(middleware.RequireRepoPermission(middleware.PermissionRead)).Get("/issues/{number}/comments", handler.ListIssueComments)
	})
	server := httptest.NewServer(router)
	defer server.Close()
	client := routesIntegrationAuthenticatedClient(t, server, routesIntegrationCreateSessionCookie(t, queries, owner))
	issuesPath := fmt.Sprintf("/api/repos/%s/%s/issues", repo.Owner, repo.Name)
	commentsPath := issuesPath + "/24/comments"
	getIssues := func(path string, status int) ([]services.IssueResponse, string) {
		resp := routesIntegrationDoRequest(t, client, server.URL, http.MethodGet, path, nil)
		require.Equal(t, status, resp.StatusCode)
		link := resp.Header.Get("Link")
		if status != http.StatusOK {
			require.Contains(t, string(routesIntegrationReadBody(t, resp)), "page-based pagination is not supported")
			return nil, link
		}
		var items []services.IssueResponse
		routesIntegrationDecodeJSON(t, resp, &items)
		return items, link
	}
	getComments := func(path string, status int) ([]services.IssueCommentResponse, string) {
		resp := routesIntegrationDoRequest(t, client, server.URL, http.MethodGet, path, nil)
		require.Equal(t, status, resp.StatusCode)
		link := resp.Header.Get("Link")
		if status != http.StatusOK {
			require.Contains(t, string(routesIntegrationReadBody(t, resp)), "page-based pagination is not supported")
			return nil, link
		}
		var items []services.IssueCommentResponse
		routesIntegrationDecodeJSON(t, resp, &items)
		return items, link
	}
	issues, link := getIssues(issuesPath+"?page=1&per_page=5", http.StatusOK)
	require.Len(t, issues, 5)
	for i, issue := range issues {
		require.Equal(t, int64(24-2*i), issue.Number)
	}
	require.Contains(t, link, `rel="next"`)
	issues, _ = getIssues(issuesPath+"?cursor="+encodeIDCursor(16)+"&limit=5", http.StatusOK)
	require.Len(t, issues, 5)
	for i, issue := range issues {
		require.Equal(t, int64(14-2*i), issue.Number)
	}
	getIssues(issuesPath+"?page=2&per_page=5", http.StatusBadRequest)

	comments, link := getComments(commentsPath+"?page=1&per_page=5", http.StatusOK)
	require.Len(t, comments, 5)
	for i, comment := range comments {
		require.Equal(t, commentIDs[i], comment.ID)
	}
	require.Contains(t, link, `rel="next"`)
	comments, _ = getComments(commentsPath+"?cursor="+encodeIDCursor(commentIDs[4])+"&limit=5", http.StatusOK)
	require.Len(t, comments, 5)
	for i, comment := range comments {
		require.Equal(t, commentIDs[i+5], comment.ID)
	}
	getComments(commentsPath+"?page=2&per_page=5", http.StatusBadRequest)
}
