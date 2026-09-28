package services

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/google/uuid"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ObsidianSync is a local folder adapter. Root-relative filesystem operations
// keep paths contained even if a directory is replaced during a scan.
type ObsidianSync struct {
	root     *os.Root
	folder   string
	identity string
}

func NewObsidianSync(folder string) (*ObsidianSync, error) {
	absolute, err := filepath.Abs(folder)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("sync folder must be a directory, not a symlink")
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, err
	}
	return &ObsidianSync{root: root, folder: absolute, identity: fmt.Sprintf("%d:%d", syncFileNumber(info, "Dev"), syncFileNumber(info, "Ino"))}, nil
}
func (a *ObsidianSync) Close() error     { return a.root.Close() }
func (a *ObsidianSync) Provider() string { return "obsidian" }
func (a *ObsidianSync) Scope() string    { return a.folder + ":" + a.identity }
func syncFileNumber(info fs.FileInfo, field string) uint64 {
	value := reflect.ValueOf(info.Sys())
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return 0
	}
	number := value.FieldByName(field)
	if number.IsValid() && number.CanUint() {
		return number.Uint()
	}
	return 0
}
func (a *ObsidianSync) document(name string) (SyncDocument, error) {
	if err := validSyncPath(name); err != nil {
		return SyncDocument{}, err
	}
	// Refuse symlinks, including internal aliases, and shared hardlinks.
	parts := strings.Split(name, "/")
	for i := range parts {
		info, err := a.root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil {
			return SyncDocument{}, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return SyncDocument{}, fmt.Errorf("sync symlink refused: %s", name)
		}
	}
	file, err := a.root.Open(name)
	if err != nil {
		return SyncDocument{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return SyncDocument{}, err
	}
	if !info.Mode().IsRegular() || syncFileNumber(info, "Nlink") > 1 {
		return SyncDocument{}, fmt.Errorf("sync requires an unshared regular file: %s", name)
	}
	limit := int64(maxWikiAttachmentBytes)
	if isWikiMarkdownPath(name) {
		limit = maxWikiBodyBytes
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return SyncDocument{}, err
	}
	if int64(len(data)) > limit {
		return SyncDocument{}, fmt.Errorf("sync file exceeds content limit: %s", name)
	}
	if isWikiMarkdownPath(name) {
		if err = validWikiBody(string(data)); err != nil {
			return SyncDocument{}, err
		}
	}
	digest := wikiDigest(data)
	id := fmt.Sprintf("%d:%d", syncFileNumber(info, "Dev"), syncFileNumber(info, "Ino"))
	if syncFileNumber(info, "Ino") == 0 {
		id = name
	}
	media := mime.TypeByExtension(path.Ext(name))
	if media == "" {
		media = "application/octet-stream"
	}
	return SyncDocument{ID: id, Path: name, Digest: digest, Version: fmt.Sprintf("%s:%d", id, info.ModTime().UnixNano()), MediaType: media}, nil
}
func validSyncPath(name string) error {
	if !fs.ValidPath(name) || name == "." || strings.ContainsAny(name, "\\\x00") {
		return api.BadRequest("invalid sync path")
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return api.BadRequest("hidden sync path refused")
		}
	}
	return nil
}
func (a *ObsidianSync) Scan(ctx context.Context) ([]SyncDocument, error) {
	docs := []SyncDocument{}
	err := fs.WalkDir(a.root.FS(), ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if name == "." {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("sync symlink refused: %s", name)
		}
		if d.IsDir() {
			return nil
		}
		document, e := a.document(name)
		if e != nil {
			return e
		}
		docs = append(docs, document)
		return nil
	})
	return docs, err
}
func (a *ObsidianSync) Read(ctx context.Context, d SyncDocument) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	current, err := a.document(d.Path)
	if err != nil {
		return nil, err
	}
	if current != d {
		return nil, api.Conflict("provider content changed")
	}
	f, err := a.root.Open(d.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxWikiAttachmentBytes+1))
	if err != nil {
		return nil, err
	}
	if wikiDigest(data) != d.Digest {
		return nil, api.Conflict("provider content changed")
	}
	return data, nil
}
func (a *ObsidianSync) Apply(ctx context.Context, key string, expected, desired *SyncDocument, data []byte) (*SyncDocument, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if desired != nil {
		if err := validSyncPath(desired.Path); err != nil {
			return nil, err
		}
		if wikiDigest(data) != desired.Digest {
			return nil, fmt.Errorf("sync content digest mismatch")
		}
	}
	if expected != nil {
		if err := validSyncPath(expected.Path); err != nil {
			return nil, err
		}
	}
	// A replay may find the destination already written and the old path still
	// present (crash between write and rename cleanup). Verify both before cleanup.
	var current *SyncDocument
	if expected != nil {
		d, err := a.document(expected.Path)
		if err == nil {
			current = &d
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	var target *SyncDocument
	if desired != nil {
		d, err := a.document(desired.Path)
		if err == nil {
			target = &d
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	if sameSyncContent(target, desired) {
		if expected != nil && (desired == nil || expected.Path != desired.Path) && current != nil {
			if !sameSyncContent(current, expected) {
				return nil, api.Conflict("local sync conflict: " + expected.Path)
			}
			if err := a.remove(expected.Path); err != nil {
				return nil, err
			}
		}
		return target, nil
	}
	if expected != nil && !sameSyncContent(current, expected) {
		return nil, api.Conflict("local sync conflict: " + expected.Path)
	}
	if target != nil && (expected == nil || expected.Path != desired.Path) {
		return nil, api.Conflict("local sync destination exists")
	}
	if desired == nil {
		if current != nil {
			if err := a.remove(expected.Path); err != nil {
				return nil, err
			}
		}
		return nil, nil
	}
	if err := a.root.MkdirAll(path.Dir(desired.Path), 0700); err != nil {
		return nil, err
	}
	temp := path.Join(path.Dir(desired.Path), ".smithers-sync-"+uuid.NewString())
	f, err := a.root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	defer a.root.Remove(temp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	// Recheck after preparing bytes; do not replace an observed concurrent edit.
	if expected != nil {
		d, e := a.document(expected.Path)
		if e != nil || !sameSyncContent(&d, expected) {
			return nil, api.Conflict("local sync conflict")
		}
	}
	if expected == nil || expected.Path != desired.Path {
		// A link publishes a new destination without replacing a racing create.
		if err = a.root.Link(temp, desired.Path); err != nil {
			return nil, err
		}
		if err = a.root.Remove(temp); err != nil {
			return nil, err
		}
	} else if err = a.root.Rename(temp, desired.Path); err != nil {
		return nil, err
	}
	if expected != nil && expected.Path != desired.Path {
		if err = a.remove(expected.Path); err != nil {
			return nil, err
		}
	}
	if err = a.syncDirectory(path.Dir(desired.Path)); err != nil {
		return nil, err
	}
	d, err := a.document(desired.Path)
	return &d, err
}

func (a *ObsidianSync) syncDirectory(name string) error {
	for {
		dir, err := a.root.Open(name)
		if err != nil {
			return err
		}
		err = dir.Sync()
		closeErr := dir.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if name == "." {
			return nil
		}
		name = path.Dir(name)
	}
}
func (a *ObsidianSync) remove(name string) error {
	if err := a.root.Remove(name); err != nil {
		return err
	}
	return a.syncDirectory(path.Dir(name))
}
