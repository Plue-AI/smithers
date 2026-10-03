package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
)

// A server bundle carries the archive alongside its manifest under one prefix.
// Source checkouts have no such directory and retain explicit registry images.
func (c *cli) imagePullPolicy(ctx context.Context, image string) (string, error) {
	c.imageOnce.Do(func() { c.imageGate = make(chan struct{}, 1) })
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case c.imageGate <- struct{}{}:
	}
	defer func() { <-c.imageGate }()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if c.loadedImage != "" {
		if image != c.loadedImage {
			return "", fmt.Errorf("%w: bundled image does not match configured image %q", ErrUnavailable, image)
		}
		return "never", nil
	}
	directory := filepath.Join(filepath.Dir(c.binary), "..", "share", "microsandbox")
	if _, err := os.Stat(directory); errors.Is(err, os.ErrNotExist) {
		return "if-missing", nil
	} else if err != nil {
		return "", fmt.Errorf("%w: inspect bundled image directory: %w", ErrUnavailable, err)
	}
	manifestPath := filepath.Join(directory, "base-image.json")
	contents, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", fmt.Errorf("%w: read bundled image manifest: %w", ErrUnavailable, err)
	}
	var manifest struct {
		Image   string `json:"image"`
		Archive string `json:"archive"`
		SHA256  string `json:"sha256"`
	}
	if err := json.Unmarshal(contents, &manifest); err != nil {
		return "", fmt.Errorf("%w: decode bundled image manifest: %w", ErrUnavailable, err)
	}
	if manifest.Image != DefaultImage || manifest.Image != image {
		return "", fmt.Errorf("%w: bundled image must match pinned and configured image %q", ErrUnavailable, DefaultImage)
	}
	if manifest.Archive != "base-image.oci.tar" {
		return "", fmt.Errorf("%w: invalid bundled image archive name %q", ErrUnavailable, manifest.Archive)
	}
	checksum, err := hex.DecodeString(manifest.SHA256)
	if err != nil || len(checksum) != sha256.Size {
		return "", fmt.Errorf("%w: invalid bundled image checksum", ErrUnavailable)
	}
	archivePath := filepath.Join(directory, manifest.Archive)
	archive, err := os.Open(archivePath)
	if err != nil {
		return "", fmt.Errorf("%w: open bundled image archive: %w", ErrUnavailable, err)
	}
	defer archive.Close()
	info, err := archive.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("%w: bundled image archive must be a readable regular file", ErrUnavailable)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, contextImageReader{ctx: ctx, reader: archive}); err != nil {
		return "", fmt.Errorf("%w: checksum bundled image archive: %w", ErrUnavailable, err)
	}
	if hex.EncodeToString(hash.Sum(nil)) != manifest.SHA256 {
		return "", fmt.Errorf("%w: bundled image archive checksum mismatch", ErrUnavailable)
	}
	if _, err := c.run(ctx, nil, "image", "load", "--input", archivePath, "--tag", image); err != nil {
		return "", fmt.Errorf("%w: load bundled image: %w", ErrUnavailable, err)
	}
	c.loadedImage = image
	return "never", nil
}

// Hashing a large archive must honour caller cancellation as image load does.
type contextImageReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextImageReader) Read(data []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(data)
}

func (c *cli) imageCreateArgs(ctx context.Context, image string, diskMiB int, flags []string) ([]string, error) {
	policy, err := c.imagePullPolicy(ctx, image)
	if err != nil {
		return nil, err
	}
	return append([]string{"create", image, "--pull", policy, "--root-disk", strconv.Itoa(diskMiB) + "M"}, flags...), nil
}
