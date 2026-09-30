package repohost

import (
	"context"
	"net/http"
	"time"
)

const immutableFileCacheLimit = 1024

type immutableFileKey struct{ owner, repo, commit, path string }
type immutableFileRead struct {
	created time.Time
	done    chan struct{}
	file    FileContent
	err     error
}

// GetFileAtCommit shares immutable file reads across callers of this client.
// Callers must supply a commit ID, never a mutable change ID or bookmark.
// Successful reads (including absent files) are retained in a bounded cache;
// transient failures are retried. Cancellation releases only that caller.
func (c *Client) GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (FileContent, error) {
	if err := ctx.Err(); err != nil {
		return FileContent{}, err
	}
	key := immutableFileKey{owner, repo, commit, path}
	c.immutableFilesMu.Lock()
	if c.immutableFiles == nil {
		c.immutableFiles = make(map[immutableFileKey]*immutableFileRead)
	}
	read := c.immutableFiles[key]
	if read == nil {
		c.pruneImmutableFiles(immutableFileCacheLimit - 1)
		read = &immutableFileRead{done: make(chan struct{}), created: time.Now()}
		c.immutableFiles[key] = read
		go func() {
			// A request may outlive its first waiter, but never the read timeout.
			readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.immutableReadTimeout())
			defer cancel()
			file, err := c.GetFileAtChange(readCtx, owner, repo, commit, path)
			c.immutableFilesMu.Lock()
			read.file, read.err = file, err
			if err != nil && !IsFileNotFound(err) {
				delete(c.immutableFiles, key)
			}
			close(read.done)
			c.pruneImmutableFiles(immutableFileCacheLimit)
			c.immutableFilesMu.Unlock()
		}()
	}
	c.immutableFilesMu.Unlock()
	select {
	case <-ctx.Done():
		return FileContent{}, ctx.Err()
	case <-read.done:
		return read.file, read.err
	}
}

// pruneImmutableFiles evicts the oldest completed reads while holding the mutex.
// Active reads remain reachable so a second caller cannot duplicate their work.
func (c *Client) pruneImmutableFiles(limit int) {
	for len(c.immutableFiles) > limit {
		var oldest *immutableFileRead
		var oldestKey immutableFileKey
		for key, read := range c.immutableFiles {
			select {
			case <-read.done:
				if oldest == nil || read.created.Before(oldest.created) {
					oldest, oldestKey = read, key
				}
			default:
			}
		}
		if oldest == nil {
			return
		}
		delete(c.immutableFiles, oldestKey)
	}
}

// IsFileNotFound identifies an absent path at an existing immutable revision.
// Generic storage, revision, and routing 404s must never become cached absence.
func IsFileNotFound(err error) bool {
	status, ok := IsStatusError(err)
	return ok && status.StatusCode == http.StatusNotFound && status.Code == "file_not_found"
}

func (c *Client) immutableReadTimeout() time.Duration {
	if c.readTimeout > 0 {
		return c.readTimeout
	}
	return defaultReadTimeout
}
