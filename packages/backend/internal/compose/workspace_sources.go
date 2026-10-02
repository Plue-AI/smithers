package compose

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"path"
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
	bookmark, found, err := repohost.LookupBookmark(ctx, r.client, owner, name, revision)
	if err != nil {
		return "", err
	}
	if found {
		return bookmark.TargetCommitID, nil
	}
	return "", fmt.Errorf("bookmark %q is not found", revision)
}

func (r repositorySourceFiles) ReadSourceFile(ctx context.Context, source workspaceapi.WorkspaceSource, filename string) ([]byte, error) {
	if strings.ContainsAny(filename, "*?[") {
		return r.readSourceGlob(ctx, source, filename)
	}
	return r.readSourceFile(ctx, source, filename)
}

// Directory metadata supplies literal paths, even when a filename contains
// glob metacharacters. Read those contents without starting another glob.
func (r repositorySourceFiles) readSourceFile(ctx context.Context, source workspaceapi.WorkspaceSource, filename string) ([]byte, error) {
	owner, name, err := splitRepositorySlug(source.Repository)
	if err != nil {
		return nil, err
	}
	file, err := r.client.GetFileAtChange(ctx, owner, name, source.Revision, filename)
	var status *repohost.StatusError
	if errors.As(err, &status) && status.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%s: %w", filename, fs.ErrNotExist)
	}
	if err != nil {
		return nil, err
	}
	if file.TooLarge {
		return nil, fmt.Errorf("%s is too large to key an environment", filename)
	}
	if file.Encoding == "base64" {
		return base64.StdEncoding.DecodeString(file.Content)
	}
	return []byte(file.Content), nil
}

// readSourceGlob enumerates metadata at the same immutable revision and reads
// only matching files. This supplies requirements*.txt and dependency member
// manifests without giving detection a working-tree reader or code execution.
func (r repositorySourceFiles) readSourceGlob(ctx context.Context, source workspaceapi.WorkspaceSource, pattern string) ([]byte, error) {
	if path.IsAbs(pattern) || path.Clean(pattern) != pattern || strings.ContainsAny(pattern, "\\\x00") {
		return nil, fmt.Errorf("invalid source glob %q", pattern)
	}
	if _, err := path.Match(pattern, ""); err != nil {
		return nil, err
	}
	owner, repo, err := splitRepositorySlug(source.Repository)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(pattern, "/")
	prefixes := []string{""}
	matches := map[string]string{}
	for index, part := range parts {
		if part == ".." {
			return nil, fmt.Errorf("invalid source glob %q", pattern)
		}
		var next []string
		for _, prefix := range prefixes {
			after := ""
			for {
				entries, err := r.client.ListDirectory(ctx, owner, repo, source.Revision, prefix, after, 512)
				var status *repohost.StatusError
				if errors.As(err, &status) && status.StatusCode == http.StatusNotFound {
					break
				}
				if err != nil {
					return nil, err
				}
				pageCursor := after
				for _, entry := range entries {
					if entry.Path <= pageCursor || strings.ContainsAny(entry.Path, "\\\x00") || path.Clean(entry.Path) != entry.Path || path.Dir(entry.Path) != strings.TrimSuffix(prefix, "/") && !(prefix == "" && path.Dir(entry.Path) == ".") {
						return nil, fmt.Errorf("invalid source directory entry %q", entry.Path)
					}
					pageCursor = entry.Path
					matched, _ := path.Match(part, path.Base(entry.Path))
					if !matched {
						continue
					}
					if index < len(parts)-1 {
						if entry.Kind == "dir" {
							next = append(next, entry.Path)
						}
					} else if entry.Kind == "file" {
						data, err := r.readSourceFile(ctx, source, entry.Path)
						if err != nil {
							return nil, err
						}
						matches[entry.Path] = string(data)
					}
					if len(next)+len(matches) > 4096 {
						return nil, fmt.Errorf("source glob %q has too many matches", pattern)
					}
				}
				if len(entries) < 512 {
					break
				}
				after = pageCursor
			}
		}
		prefixes = next
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("%s: %w", pattern, fs.ErrNotExist)
	}
	return json.Marshal(matches)
}

var _ workspaceapi.SourceFiles = repositorySourceFiles{}
