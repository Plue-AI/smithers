package repohost

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
)

// WorkspaceSource contains only native immutable identity; operation IDs are
// local repository observations and must not be fabricated on the server.
type WorkspaceSource struct {
	ChangeID        string   `json:"change_id"`
	CommitID        string   `json:"commit_id"`
	TreeID          string   `json:"tree_id"`
	ParentCommitIDs []string `json:"parent_commit_ids"`
}

type WorkspaceSourceRequest struct {
	WorkspaceID string          `json:"workspace_id"`
	Source      WorkspaceSource `json:"source"`
}

type WorkspaceSourceReceipt struct {
	Status      string          `json:"status"`
	WorkspaceID string          `json:"workspace_id"`
	Ref         string          `json:"ref"`
	Source      WorkspaceSource `json:"source"`
}

var sourceChangeID = regexp.MustCompile(`^[k-z]{32}$`)

func (s WorkspaceSource) Validate() error {
	if !sourceChangeID.MatchString(s.ChangeID) || !fullSourceCommitID.MatchString(s.CommitID) || s.CommitID == "0000000000000000000000000000000000000000" || !fullSourceCommitID.MatchString(s.TreeID) || s.ParentCommitIDs == nil || len(s.ParentCommitIDs) > 16 {
		return fmt.Errorf("source requires full native commit, change, tree and parent identities")
	}
	for _, id := range s.ParentCommitIDs {
		if !fullSourceCommitID.MatchString(id) {
			return fmt.Errorf("source parent must be a full native commit ID")
		}
	}
	return nil
}

func (c *Client) ReadWorkspaceSource(ctx context.Context, owner, repo string, req WorkspaceSourceRequest) (WorkspaceSourceReceipt, error) {
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return WorkspaceSourceReceipt{}, fmt.Errorf("resolve storage set url: %w", err)
	}
	var result WorkspaceSourceReceipt
	err = c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(baseURL, owner, repo)+"/workspace-source", req, http.StatusOK, &result)
	return result, err
}

// DeletedWorkspaceRefs lists the refs DeleteWorkspaceRefs removed.
type DeletedWorkspaceRefs struct {
	Refs []string `json:"refs"`
}

// DeleteWorkspaceRefs deletes every ref under refs/smithers/workspaces/<id>/
// (the workspace's head and retained sources) once the workspace is gone.
func (c *Client) DeleteWorkspaceRefs(ctx context.Context, owner, repo, workspaceID string) (DeletedWorkspaceRefs, error) {
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return DeletedWorkspaceRefs{}, fmt.Errorf("resolve storage set url: %w", err)
	}
	var result DeletedWorkspaceRefs
	endpoint := repoByIDEndpoint(baseURL, owner, repo) + "/workspace-refs/" + url.PathEscape(workspaceID)
	err = c.doJSON(ctx, http.MethodDelete, endpoint, nil, http.StatusOK, &result)
	return result, err
}
