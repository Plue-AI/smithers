package services

import (
	"context"
	"errors"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func (h policyHost) GetBookmark(_ context.Context, _, _, name string) (repohost.Bookmark, error) {
	if name != "main" {
		return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
	}
	entries, _, _ := h.ListBookmarks(context.Background(), "", "", "", 1)
	return entries[0], nil
}
func (h policyHost) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	file, err := h.GetFileAtChange(ctx, owner, repo, commit, path)
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
		return file, &repohost.StatusError{StatusCode: 404, Code: "file_not_found"}
	}
	return file, err
}
func (failingPolicy) GetBookmark(context.Context, string, string, string) (repohost.Bookmark, error) {
	return repohost.Bookmark{}, errors.New("repo host unavailable")
}
func (h failingPolicy) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	file, err := h.GetFileAtChange(ctx, owner, repo, commit, path)
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
		return file, &repohost.StatusError{StatusCode: 404, Code: "file_not_found"}
	}
	return file, err
}
func (h *machineHost) GetBookmark(_ context.Context, _, _, name string) (repohost.Bookmark, error) {
	if h.fail == "bookmarks" {
		return repohost.Bookmark{}, errors.New("repo host unavailable")
	}
	for _, entry := range h.bookmarks {
		if entry.Name == name {
			return entry, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}
func (h *machineHost) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	file, err := h.GetFileAtChange(ctx, owner, repo, commit, path)
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
		return file, &repohost.StatusError{StatusCode: 404, Code: "file_not_found"}
	}
	return file, err
}

func (h policyTestHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	if name != "main" {
		return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
	}
	entries, _, _ := h.ListBookmarks(ctx, owner, repo, "", 1)
	return entries[0], nil
}
func (unreadablePolicyHost) GetBookmark(context.Context, string, string, string) (repohost.Bookmark, error) {
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 503}
}
func (h policyTestHost) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	file, err := h.GetFileAtChange(ctx, owner, repo, commit, path)
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
		return file, &repohost.StatusError{StatusCode: 404, Code: "file_not_found"}
	}
	return file, err
}
func (h invokedFlowTestSources) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	file, err := h.GetFileAtChange(ctx, owner, repo, commit, path)
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
		return file, &repohost.StatusError{StatusCode: 404, Code: "file_not_found"}
	}
	return file, err
}
