package services

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type WorkspaceSourceReader interface {
	ReadWorkspaceSource(context.Context, string, string, repohost.WorkspaceSourceRequest) (repohost.WorkspaceSourceReceipt, error)
}

func WithWorkspaceSourceReader(reader WorkspaceSourceReader) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.sourceReader = reader }
}

// This is an acknowledgement of a native immutable ref, not a second ledger.
type WorkspaceRetainedSource struct {
	repohost.WorkspaceSourceReceipt
	RepositoryID int64 `json:"repository_id"`
}

func (s *WorkspaceService) reportRetainedSource(ctx context.Context, workspace db.Workspace, input ReportWorkspaceHeadInput) (WorkspaceResponse, error) {
	if input.ChangeID != "" || input.CommitID != "" || input.Ahead != 0 || input.Behind != 0 || len(input.CodingOperations) != 0 {
		return WorkspaceResponse{}, pkgerrors.BadRequest("retain_source cannot be combined with a live head report")
	}
	if err := input.RetainSource.Validate(); err != nil {
		return WorkspaceResponse{}, pkgerrors.BadRequest(err.Error())
	}
	if s.sourceReader == nil {
		return WorkspaceResponse{}, &pkgerrors.APIError{Status: 503, Code: pkgerrors.CodeWorkspaceSourceUnavailable, Message: "native source verification unavailable"}
	}
	slug, err := s.workspaceRepoSlug(ctx, workspace.RepositoryID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	owner, repo, _ := strings.Cut(slug, "/")
	result, err := s.sourceReader.ReadWorkspaceSource(ctx, owner, repo, repohost.WorkspaceSourceRequest{WorkspaceID: workspace.ID, Source: *input.RetainSource})
	if err != nil {
		var upstream *repohost.StatusError
		if errors.As(err, &upstream) && upstream.StatusCode == http.StatusNotFound && upstream.Code == "workspace_source_missing" {
			return WorkspaceResponse{}, &pkgerrors.APIError{Status: 404, Code: pkgerrors.CodeWorkspaceSourceMissing, Message: "original source is not retained in this workspace"}
		}
		if errors.As(err, &upstream) && upstream.StatusCode == http.StatusConflict {
			return WorkspaceResponse{}, pkgerrors.Conflict("retained source does not match the requested native revision")
		}
		return WorkspaceResponse{}, &pkgerrors.APIError{Status: 503, Code: pkgerrors.CodeWorkspaceSourceUnavailable, Message: "native source could not be verified"}
	}
	if result.Status != "retained" || result.WorkspaceID != workspace.ID || result.Ref != repohost.WorkspaceSourceRef(workspace.ID, input.RetainSource.CommitID) || !reflect.DeepEqual(result.Source, *input.RetainSource) {
		return WorkspaceResponse{}, &pkgerrors.APIError{Status: 503, Code: pkgerrors.CodeWorkspaceSourceInvalidAck, Message: "native source acknowledgement did not match the requested revision"}
	}
	response := s.toWorkspaceResponse(workspace)
	response.RetainedSource = &WorkspaceRetainedSource{WorkspaceSourceReceipt: result, RepositoryID: workspace.RepositoryID}
	return response, nil
}

// WorkspaceRefDeleter removes a deleted workspace's refs from repo-host.
type WorkspaceRefDeleter interface {
	DeleteWorkspaceRefs(context.Context, string, string, string) (repohost.DeletedWorkspaceRefs, error)
}

func WithWorkspaceRefDeleter(deleter WorkspaceRefDeleter) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.refDeleter = deleter }
}

// deleteWorkspaceRefs deletes every refs/smithers/workspaces/<id>/ ref
// (#1990). It runs once the workspace can no longer run or push, and before
// its row is tombstoned, so a failure leaves the delete retryable.
func (s *WorkspaceService) deleteWorkspaceRefs(ctx context.Context, workspace db.Workspace) error {
	if s.refDeleter == nil {
		return nil
	}
	slug, err := s.workspaceRepoSlug(ctx, workspace.RepositoryID)
	if err != nil {
		return err
	}
	owner, repo, _ := strings.Cut(slug, "/")
	if _, err := s.refDeleter.DeleteWorkspaceRefs(ctx, owner, repo, workspace.ID); err != nil {
		return pkgerrors.Internal("delete workspace refs: " + err.Error())
	}
	return nil
}
