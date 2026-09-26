package services

import (
	"context"
	"path"
	"sort"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type WikiBacklink struct {
	PageID  int64  `json:"page_id"`
	Path    string `json:"path"`
	Heading string `json:"heading,omitempty"`
	Embed   bool   `json:"embed"`
}
type WikiIndexPage struct {
	WikiPageResponse
	Metadata  WikiMetadata   `json:"metadata"`
	Backlinks []WikiBacklink `json:"backlinks"`
}
type WikiIndex struct {
	Pages   []WikiIndexPage `json:"pages"`
	Folders []string        `json:"folders"`
	Tags    []string        `json:"tags"`
}

func (s *WikiService) GetWikiIndex(ctx context.Context, viewer *db.User, owner, repo string) (WikiIndex, error) {
	result := WikiIndex{Pages: []WikiIndexPage{}, Folders: []string{}, Tags: []string{}}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return result, err
	}
	if err = s.requireReadAccess(ctx, repository, viewer); err != nil {
		return result, err
	}
	// An authoritative listing uses stable IDs, not updated_at pagination, so
	// edits during a scan cannot hide or duplicate pages. One SQL snapshot.
	store, ok := s.queries.(interface {
		ListWikiIndex(context.Context, db.ListWikiIndexParams) ([]db.ListWikiIndexRow, error)
	})
	if !ok {
		return result, wikiUnavailable("wiki index is unavailable")
	}
	rows, err := store.ListWikiIndex(ctx, db.ListWikiIndexParams{RepositoryID: repository.ID, Visibility: wikiVisibility(ctx)})
	if err != nil {
		return result, pkgerrors.Internal("failed to read wiki index").WithCause(err)
	}
	for _, row := range rows {
		page := WikiIndexPage{WikiPageResponse: WikiPageResponse{ID: row.ID, Slug: row.Slug, Title: row.Title, Revision: row.Revision, Visibility: row.Visibility, Path: row.Path, ContentDigest: row.ContentDigest, Attachment: wikiAttachment(row.Attachment), Author: WikiAuthorSummary{ID: row.AuthorID, Login: row.AuthorUsername}, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, Metadata: ParseWikiMarkdown(row.Body), Backlinks: []WikiBacklink{}}
		result.Pages = append(result.Pages, page)
		result.Tags = append(result.Tags, page.Metadata.Tags...)
		for dir := path.Dir(row.Path); dir != "." && dir != "/"; dir = path.Dir(dir) {
			result.Folders = append(result.Folders, dir)
		}
	}
	sort.Slice(result.Pages, func(i, j int) bool { return result.Pages[i].Path < result.Pages[j].Path })
	resolveWikiLinks(result.Pages)
	result.Tags = wikiUnique(result.Tags)
	result.Folders = wikiUnique(result.Folders)
	return result, nil
}
