package compose

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// repositorySourceFiles lets an isolated runtime key prepared environments by
// file contents at a revision. It reads data through the product repository
// client; nothing from the repository executes on the host.
type repositorySourceFiles struct{ client *repohost.Client }

func splitRepositorySlug(slug string) (string, string, error) {
	owner, name, ok := strings.Cut(strings.TrimSpace(slug), "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", "", fmt.Errorf("repository slug %q is invalid", slug)
	}
	return owner, name, nil
}

func (r repositorySourceFiles) ResolveSourceRevision(ctx context.Context, repository, revision string) (string, error) {
	owner, name, err := splitRepositorySlug(repository)
	if err != nil {
		return "", err
	}
	revision = strings.TrimSpace(revision)
	if len(revision) == 40 && strings.Trim(revision, "0123456789abcdef") == "" {
		return revision, nil
	}
	cursor := ""
	for page := 0; page < 100; page++ {
		bookmarks, next, err := r.client.ListBookmarks(ctx, owner, name, cursor, 100)
		if err != nil {
			return "", err
		}
		for _, bookmark := range bookmarks {
			if bookmark.Name == revision {
				return bookmark.TargetCommitID, nil
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	return "", fmt.Errorf("bookmark %q is not found", revision)
}

func (r repositorySourceFiles) ReadSourceFile(ctx context.Context, source workspaceapi.WorkspaceSource, path string) ([]byte, error) {
	owner, name, err := splitRepositorySlug(source.Repository)
	if err != nil {
		return nil, err
	}
	file, err := r.client.GetFileAtChange(ctx, owner, name, source.Revision, path)
	var status *repohost.StatusError
	if errors.As(err, &status) && status.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%s: %w", path, fs.ErrNotExist)
	}
	if err != nil {
		return nil, err
	}
	if file.TooLarge {
		return nil, fmt.Errorf("%s is too large to key an environment", path)
	}
	if file.Encoding == "base64" {
		return base64.StdEncoding.DecodeString(file.Content)
	}
	return []byte(file.Content), nil
}

var _ workspaceapi.SourceFiles = repositorySourceFiles{}
