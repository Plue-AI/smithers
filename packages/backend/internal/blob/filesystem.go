package blob

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	filesystemTransferPath        = "/api/blob-transfer/"
	filesystemKeyFile             = ".smithers-transfer-key"
	filesystemLockFile            = ".smithers.lock"
	filesystemObjectsDir          = ".objects"
	filesystemTempDir             = ".tmp"
	filesystemTransferIdleTimeout = 30 * time.Second
)

var (
	ErrStorageFull   = errors.New("blob storage has no available capacity")
	ErrInvalidUpload = errors.New("blob upload failed validation")
)

// FilesystemConfig configures the durable single-owner blob adapter. MaxBytes
// is a logical object quota; zero means no additional global limit. ReserveBytes
// is kept free for PostgreSQL, API logs, and atomic filesystem operations.
type FilesystemConfig struct {
	Root          string
	PublicBaseURL string
	SigningKey    []byte
	MaxBytes      int64
	ReserveBytes  int64
}

// FilesystemStore stores immutable product objects under one persistent data
// root. Uploads are spooled and fsynced before an atomic publication, so an
// interrupted request or process crash never exposes a partial object.
type FilesystemStore struct {
	root          string
	fsRoot        *os.Root
	lockFile      *os.File
	publicBaseURL string
	signingKey    []byte
	maxBytes      int64
	reserveBytes  int64
	idleTimeout   time.Duration
	now           func() time.Time

	quotaMu  sync.Mutex
	used     int64
	reserved int64
	// mutationMu serializes publication, promotion, and deletion inside the one
	// supported local app process. It complements the services' durable
	// ownership fences and keeps filesystem mutations in a definite order.
	mutationMu sync.Mutex
	closeOnce  sync.Once
	closeErr   error
}

type transferClaims struct {
	Version     int    `json:"v"`
	Operation   string `json:"op"`
	Key         string `json:"key"`
	Owner       string `json:"owner"`
	ExpiresUnix int64  `json:"exp"`
	ContentType string `json:"content_type,omitempty"`
	SizeLimit   int64  `json:"size_limit"`
	ExactSize   bool   `json:"exact_size,omitempty"`
	CreateOnly  bool   `json:"create_only,omitempty"`
}

// NewFilesystemStore opens a durable store, removes abandoned upload spools,
// and reconstructs quota accounting from committed objects. When SigningKey is
// omitted, a 256-bit key is created once inside Root and reused after restart.
func NewFilesystemStore(cfg FilesystemConfig) (*FilesystemStore, error) {
	if strings.TrimSpace(cfg.Root) == "" {
		return nil, errors.New("filesystem blob root is required")
	}
	if cfg.MaxBytes < 0 || cfg.ReserveBytes < 0 {
		return nil, errors.New("filesystem blob quota and reserve must be non-negative")
	}
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(cfg.PublicBaseURL), "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return nil, errors.New("filesystem blob public base URL must be an absolute http(s) URL")
	}
	root, err := filepath.Abs(cfg.Root)
	if err != nil {
		return nil, fmt.Errorf("resolve filesystem blob root: %w", err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create filesystem blob root: %w", err)
	}
	if info, err := os.Lstat(root); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("filesystem blob root must be a real directory")
	}
	fsRoot, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("open filesystem blob root: %w", err)
	}
	lockFile, err := fsRoot.OpenFile(filesystemLockFile, os.O_RDWR|os.O_CREATE|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		_ = fsRoot.Close()
		return nil, fmt.Errorf("open filesystem blob owner lock: %w", err)
	}
	lockInfo, err := lockFile.Stat()
	if err != nil || !lockInfo.Mode().IsRegular() || lockInfo.Mode().Perm()&0o077 != 0 {
		_ = lockFile.Close()
		_ = fsRoot.Close()
		return nil, errors.New("filesystem blob owner lock must be a private regular file")
	}
	if err := unix.Flock(int(lockFile.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = lockFile.Close()
		_ = fsRoot.Close()
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return nil, errors.New("filesystem blob root is already owned by another process")
		}
		return nil, fmt.Errorf("lock filesystem blob root: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = unix.Flock(int(lockFile.Fd()), unix.LOCK_UN)
			_ = lockFile.Close()
			_ = fsRoot.Close()
		}
	}()

	// The exclusive owner may now reclaim spools left by a crashed predecessor.
	// Acquiring the lock first prevents an overlapping process from deleting a
	// live upload.
	if err := fsRoot.RemoveAll(filesystemTempDir); err != nil {
		return nil, fmt.Errorf("remove incomplete blob uploads: %w", err)
	}
	if err := fsRoot.Mkdir(filesystemTempDir, 0o700); err != nil {
		return nil, fmt.Errorf("create blob upload directory: %w", err)
	}
	if err := ensurePrivateDirectory(fsRoot, filesystemObjectsDir); err != nil {
		return nil, fmt.Errorf("create blob object directory: %w", err)
	}

	key, err := loadOrCreateSigningKey(fsRoot, cfg.SigningKey)
	if err != nil {
		return nil, err
	}
	used, err := committedBytes(fsRoot)
	if err != nil {
		return nil, err
	}
	if cfg.MaxBytes > 0 && used > cfg.MaxBytes {
		return nil, fmt.Errorf("committed blobs use %d bytes, exceeding configured quota %d", used, cfg.MaxBytes)
	}
	s := &FilesystemStore{
		root: root, fsRoot: fsRoot, lockFile: lockFile,
		publicBaseURL: strings.TrimRight(base.String(), "/"),
		signingKey:    key, maxBytes: cfg.MaxBytes, reserveBytes: cfg.ReserveBytes,
		idleTimeout: filesystemTransferIdleTimeout, now: time.Now, used: used,
	}
	if err := s.checkDiskHeadroom(0); err != nil {
		return nil, err
	}
	cleanup = false
	return s, nil
}

func ensurePrivateDirectory(root *os.Root, name string) error {
	err := root.Mkdir(name, 0o700)
	if err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("path is not a real directory")
	}
	return syncRootDirectory(root, path.Dir(name))
}

func loadOrCreateSigningKey(root *os.Root, configured []byte) ([]byte, error) {
	if len(configured) > 0 {
		if len(configured) < 32 {
			return nil, errors.New("filesystem blob signing key must be at least 32 bytes")
		}
		return append([]byte(nil), configured...), nil
	}
	if info, statErr := root.Lstat(filesystemKeyFile); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
			return nil, errors.New("filesystem blob signing key file must be a private regular file")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect filesystem blob signing key: %w", statErr)
	}
	key, err := root.ReadFile(filesystemKeyFile)
	if err == nil {
		if len(key) != 32 {
			return nil, errors.New("filesystem blob signing key file is invalid")
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read filesystem blob signing key: %w", err)
	}
	key = make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate filesystem blob signing key: %w", err)
	}
	f, err := root.OpenFile(filesystemKeyFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0o600)
	if errors.Is(err, os.ErrExist) {
		return loadOrCreateSigningKey(root, nil)
	}
	if err != nil {
		return nil, fmt.Errorf("create filesystem blob signing key: %w", err)
	}
	_, writeErr := f.Write(key)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		_ = root.Remove(filesystemKeyFile)
		return nil, fmt.Errorf("persist filesystem blob signing key: %w", err)
	}
	if err := syncRootDirectory(root, "."); err != nil {
		return nil, err
	}
	return key, nil
}

type filesystemFileID struct {
	device uint64
	inode  uint64
}

func filesystemIdentity(info os.FileInfo) (filesystemFileID, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return filesystemFileID{}, false
	}
	return filesystemFileID{device: uint64(stat.Dev), inode: uint64(stat.Ino)}, true
}

func filesystemLinkCount(info os.FileInfo) uint64 {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 1
	}
	return uint64(stat.Nlink)
}

func committedBytes(root *os.Root) (int64, error) {
	var total int64
	seen := make(map[filesystemFileID]struct{})
	err := fs.WalkDir(root.FS(), filesystemObjectsDir, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			if id, ok := filesystemIdentity(info); ok {
				if _, duplicate := seen[id]; duplicate {
					return nil
				}
				seen[id] = struct{}{}
			}
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("scan filesystem blobs: %w", err)
	}
	return total, nil
}

func cleanObjectKey(key string) (string, error) {
	if key == "" || strings.TrimSpace(key) != key || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") || strings.ContainsRune(key, 0) || path.Clean(key) != key {
		return "", errors.New("invalid blob object key")
	}
	for i, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." || (i == 0 && (part == filesystemTempDir || part == filesystemKeyFile || part == filesystemLockFile || part == filesystemObjectsDir)) {
			return "", errors.New("invalid blob object key")
		}
	}
	return key, nil
}

func (s *FilesystemStore) objectName(key string) (string, error) {
	key, err := cleanObjectKey(key)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(key))
	encoded := hex.EncodeToString(digest[:])
	return path.Join(filesystemObjectsDir, encoded[:2], encoded), nil
}

func (s *FilesystemStore) ensureParent(key string) (string, error) {
	name, err := s.objectName(key)
	if err != nil {
		return "", err
	}
	dir := path.Dir(name)
	if err := ensurePrivateDirectory(s.fsRoot, dir); err != nil {
		return "", err
	}
	return name, nil
}

// Close releases the single-owner lock. Production keeps the store for the
// process lifetime; tests and embedded callers may close it explicitly.
func (s *FilesystemStore) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		var unlockErr, lockCloseErr, rootCloseErr error
		if s.lockFile != nil {
			unlockErr = unix.Flock(int(s.lockFile.Fd()), unix.LOCK_UN)
			lockCloseErr = s.lockFile.Close()
		}
		if s.fsRoot != nil {
			rootCloseErr = s.fsRoot.Close()
		}
		s.closeErr = errors.Join(unlockErr, lockCloseErr, rootCloseErr)
	})
	return s.closeErr
}

func ownerScope(key string) (string, error) {
	parts := strings.Split(key, "/")
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "repos" {
			if id, err := strconv.ParseInt(parts[i+1], 10, 64); err == nil && id > 0 {
				return "repository:" + parts[i+1], nil
			}
		}
	}
	if len(parts) > 1 {
		switch parts[0] {
		case "lfs-pending", "agent-logs", "build-cache":
			if id, err := strconv.ParseInt(parts[1], 10, 64); err == nil && id > 0 {
				return "repository:" + parts[1], nil
			}
		case "snapshots":
			return "system:snapshots", nil
		}
	}
	return "", errors.New("blob transfer key has no owner scope")
}

func (s *FilesystemStore) signTransfer(claims transferClaims) (string, error) {
	key, err := cleanObjectKey(claims.Key)
	if err != nil {
		return "", err
	}
	owner, err := ownerScope(key)
	if err != nil {
		return "", err
	}
	claims.Key = key
	claims.Owner = owner
	claims.Version = 1
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, s.signingKey)
	_, _ = mac.Write(payload)
	token := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return s.publicBaseURL + filesystemTransferPath + token, nil
}

func (s *FilesystemStore) verifyTransfer(token string) (transferClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	mac := hmac.New(sha256.New, s.signingKey)
	_, _ = mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	var claims transferClaims
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Version != 1 {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	key, err := cleanObjectKey(claims.Key)
	owner, ownerErr := ownerScope(key)
	if err != nil || ownerErr != nil || claims.Owner != owner || claims.ExpiresUnix <= s.now().Unix() {
		return transferClaims{}, errors.New("expired or invalid transfer credential")
	}
	if claims.Operation != http.MethodGet && claims.Operation != http.MethodPut {
		return transferClaims{}, errors.New("invalid transfer operation")
	}
	claims.Key = key
	return claims, nil
}

func (s *FilesystemStore) SignedUploadURL(_ context.Context, key, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error) {
	if maxSizeBytes < 0 {
		return "", errors.New("upload size limit must be non-negative")
	}
	expiry = normalizeSignedURLExpiry(expiry)
	return s.signTransfer(transferClaims{Operation: http.MethodPut, Key: key, ContentType: contentType, SizeLimit: maxSizeBytes, ExpiresUnix: s.now().Add(expiry).Unix()})
}

func (s *FilesystemStore) SignedCreateOnlyUploadURL(_ context.Context, key, contentType string, exactSizeBytes int64, expiry time.Duration) (SignedUpload, error) {
	if exactSizeBytes < UnknownObjectSize {
		return SignedUpload{}, errors.New("upload size must be exact or unknown")
	}
	expiry = normalizeSignedURLExpiry(expiry)
	u, err := s.signTransfer(transferClaims{
		Operation: http.MethodPut, Key: key, ContentType: contentType,
		SizeLimit: exactSizeBytes, ExactSize: exactSizeBytes >= 0, CreateOnly: true,
		ExpiresUnix: s.now().Add(expiry).Unix(),
	})
	if err != nil {
		return SignedUpload{}, err
	}
	headers := map[string]string{}
	if contentType != "" {
		headers["Content-Type"] = contentType
	}
	return SignedUpload{URL: u, Header: headers}, nil
}

func (s *FilesystemStore) SignedDownloadURL(_ context.Context, key string, expiry time.Duration) (string, error) {
	expiry = normalizeSignedURLExpiry(expiry)
	return s.signTransfer(transferClaims{Operation: http.MethodGet, Key: key, SizeLimit: UnknownObjectSize, ExpiresUnix: s.now().Add(expiry).Unix()})
}

func (s *FilesystemStore) reserve(bytes int64) error {
	if bytes < 0 {
		return errors.New("negative blob reservation")
	}
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	if s.maxBytes > 0 && bytes > s.maxBytes-s.used-s.reserved {
		return ErrStorageFull
	}
	if err := s.checkDiskHeadroom(s.reserved + bytes); err != nil {
		return err
	}
	s.reserved += bytes
	return nil
}

func (s *FilesystemStore) releaseReservation(bytes int64) {
	s.quotaMu.Lock()
	s.reserved -= bytes
	if s.reserved < 0 {
		s.reserved = 0
	}
	s.quotaMu.Unlock()
}

// CheckHeadroom reports ErrStorageFull when the filesystem holding the store
// has less free space than ReserveBytes, so readiness can refuse work before
// its writes fail.
func (s *FilesystemStore) CheckHeadroom() error {
	return s.checkDiskHeadroom(0)
}

func (s *FilesystemStore) checkDiskHeadroom(pending int64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(s.root, &stat); err != nil {
		return fmt.Errorf("inspect blob filesystem capacity: %w", err)
	}
	available := filesystemAvailableBytes(&stat)
	if pending > available || available-pending < s.reserveBytes {
		return ErrStorageFull
	}
	return nil
}

func (s *FilesystemStore) writeObject(ctx context.Context, key string, body io.Reader, createOnly bool, exactSize, maxSize int64, expectedDigest string) (ObjectAttrs, error) {
	if _, err := cleanObjectKey(key); err != nil {
		return ObjectAttrs{}, err
	}
	reservation := exactSize
	if reservation < 0 {
		reservation = maxSize
	}
	if reservation < 0 {
		reservation = 0
	}
	if err := s.reserve(reservation); err != nil {
		return ObjectAttrs{}, err
	}
	defer func() { s.releaseReservation(reservation) }()

	temp, tempName, err := createRootTemp(s.fsRoot)
	if err != nil {
		return ObjectAttrs{}, err
	}
	defer func() {
		_ = temp.Close()
		_ = s.fsRoot.Remove(tempName)
	}()
	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: body}
	var source io.Reader = reader
	limit := maxSize
	if exactSize >= 0 {
		limit = exactSize
	}
	if limit >= 0 {
		source = io.LimitReader(source, limit+1)
	}
	destinationWriter := io.Writer(io.MultiWriter(temp, hash))
	if reservation == 0 {
		destinationWriter = &quotaWriter{store: s, writer: destinationWriter, reserved: &reservation}
	}
	size, copyErr := io.Copy(destinationWriter, source)
	if copyErr != nil {
		return ObjectAttrs{}, copyErr
	}
	if err := ctx.Err(); err != nil {
		return ObjectAttrs{}, err
	}
	if (exactSize >= 0 && size != exactSize) || (maxSize >= 0 && size > maxSize) {
		return ObjectAttrs{}, fmt.Errorf("%w: received %d bytes", ErrInvalidUpload, size)
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if expectedDigest != "" && !strings.EqualFold(expectedDigest, digest) {
		return ObjectAttrs{}, fmt.Errorf("%w: sha256 mismatch", ErrInvalidUpload)
	}
	if err := temp.Sync(); err != nil {
		return ObjectAttrs{}, err
	}
	if err := temp.Close(); err != nil {
		return ObjectAttrs{}, err
	}
	destination, err := s.ensureParent(key)
	if err != nil {
		return ObjectAttrs{}, err
	}
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	var previousSize int64
	if info, statErr := s.fsRoot.Lstat(destination); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return ObjectAttrs{}, errors.New("blob destination is not a regular file")
		}
		// Replacing one name releases bytes only when no promotion alias still
		// references the previous inode.
		if filesystemLinkCount(info) <= 1 {
			previousSize = info.Size()
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return ObjectAttrs{}, statErr
	}
	if createOnly {
		if err := s.fsRoot.Link(tempName, destination); err != nil {
			if errors.Is(err, os.ErrExist) {
				return ObjectAttrs{}, ErrObjectAlreadyExists
			}
			return ObjectAttrs{}, err
		}
	} else if err := s.fsRoot.Rename(tempName, destination); err != nil {
		return ObjectAttrs{}, err
	}
	s.quotaMu.Lock()
	s.used += size - previousSize
	s.quotaMu.Unlock()
	if err := syncRootDirectory(s.fsRoot, path.Dir(destination)); err != nil {
		if createOnly {
			_ = s.fsRoot.Remove(destination)
			s.quotaMu.Lock()
			s.used -= size
			s.quotaMu.Unlock()
		}
		return ObjectAttrs{}, err
	}
	return ObjectAttrs{Size: size, SHA256: digest}, nil
}

func createRootTemp(root *os.Root) (*os.File, string, error) {
	for range 100 {
		var entropy [16]byte
		if _, err := rand.Read(entropy[:]); err != nil {
			return nil, "", fmt.Errorf("generate blob spool name: %w", err)
		}
		name := path.Join(filesystemTempDir, "upload-"+hex.EncodeToString(entropy[:]))
		f, err := root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0o600)
		if err == nil {
			return f, name, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("could not allocate unique blob spool")
}

type quotaWriter struct {
	store    *FilesystemStore
	writer   io.Writer
	reserved *int64
}

func (w *quotaWriter) Write(p []byte) (int, error) {
	amount := int64(len(p))
	if err := w.store.reserve(amount); err != nil {
		return 0, err
	}
	*w.reserved += amount
	n, err := w.writer.Write(p)
	if unwritten := amount - int64(n); unwritten > 0 {
		w.store.releaseReservation(unwritten)
		*w.reserved -= unwritten
	}
	return n, err
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func syncRootDirectory(root *os.Root, dir string) error {
	f, err := root.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	return f.Sync()
}

func (s *FilesystemStore) Put(ctx context.Context, key, _ string, body io.Reader) error {
	_, err := s.writeObject(ctx, key, body, false, UnknownObjectSize, UnknownObjectSize, expectedKeyDigest(key))
	return err
}

func (s *FilesystemStore) PromoteCreateOnly(ctx context.Context, sourceKey, destinationKey string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	source, err := s.objectName(sourceKey)
	if err != nil {
		return err
	}
	info, err := s.fsRoot.Lstat(source)
	if errors.Is(err, os.ErrNotExist) {
		return ErrObjectNotFound
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		if err != nil {
			return err
		}
		return errors.New("blob source is not a regular file")
	}
	destination, err := s.ensureParent(destinationKey)
	if err != nil {
		return err
	}
	if err := s.fsRoot.Link(source, destination); err != nil {
		if errors.Is(err, os.ErrExist) {
			return ErrObjectAlreadyExists
		}
		return err
	}
	if err := syncRootDirectory(s.fsRoot, path.Dir(destination)); err != nil {
		_ = s.fsRoot.Remove(destination)
		return err
	}
	if err := s.fsRoot.Remove(source); err != nil {
		// Both names refer to the same immutable inode. Leaving the staging name
		// is safe and lets the existing cleanup worker retry removal.
		return err
	}
	_ = syncRootDirectory(s.fsRoot, path.Dir(source))
	return nil
}

func (s *FilesystemStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	name, err := s.objectName(key)
	if err != nil {
		return err
	}
	info, err := s.fsRoot.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("blob object is not a regular file")
	}
	if err := s.fsRoot.Remove(name); err != nil {
		return err
	}
	if filesystemLinkCount(info) <= 1 {
		s.quotaMu.Lock()
		s.used -= info.Size()
		if s.used < 0 {
			s.used = 0
		}
		s.quotaMu.Unlock()
	}
	return syncRootDirectory(s.fsRoot, path.Dir(name))
}

func (s *FilesystemStore) PurgeAllGenerations(ctx context.Context, key string) error {
	return s.Delete(ctx, key)
}

func (s *FilesystemStore) Exists(ctx context.Context, key string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	name, err := s.objectName(key)
	if err != nil {
		return false, err
	}
	info, err := s.fsRoot.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0, nil
}

func (s *FilesystemStore) Stat(ctx context.Context, key string) (ObjectAttrs, error) {
	if err := ctx.Err(); err != nil {
		return ObjectAttrs{}, err
	}
	name, err := s.objectName(key)
	if err != nil {
		return ObjectAttrs{}, err
	}
	info, err := s.fsRoot.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return ObjectAttrs{}, ErrObjectNotFound
	}
	if err != nil {
		return ObjectAttrs{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return ObjectAttrs{}, errors.New("blob object is not a regular file")
	}
	// Match the clustered adapter: Stat is metadata-only. Call ComputeSHA256
	// explicitly when a caller needs a content digest.
	return ObjectAttrs{Size: info.Size()}, nil
}

func (s *FilesystemStore) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	f, _, err := s.openObject(ctx, key)
	return f, err
}

func (s *FilesystemStore) openObject(ctx context.Context, key string) (*os.File, os.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	name, err := s.objectName(key)
	if err != nil {
		return nil, nil, err
	}
	f, err := s.fsRoot.OpenFile(name, os.O_RDONLY|unix.O_NOFOLLOW, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, ErrObjectNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		_ = f.Close()
		if err != nil {
			return nil, nil, err
		}
		return nil, nil, errors.New("blob object is not a regular file")
	}
	return f, info, nil
}

func expectedKeyDigest(key string) string {
	parts := strings.Split(key, "/")
	if len(parts) < 2 {
		return ""
	}
	allowed := strings.Contains(key, "/lfs/") || strings.HasPrefix(key, "lfs-pending/") || strings.HasPrefix(key, "build-cache/")
	candidate := parts[len(parts)-1]
	if !allowed || len(candidate) != sha256.Size*2 {
		return ""
	}
	if _, err := hex.DecodeString(candidate); err != nil {
		return ""
	}
	return strings.ToLower(candidate)
}

// TransferHandler serves the application-owned URLs returned by the signing
// methods. The HMAC credential is the authorization: it is bound to one exact
// owner scope, object key, operation, size policy, and expiry.
func (s *FilesystemStore) TransferHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, filesystemTransferPath) {
			http.NotFound(w, r)
			return
		}
		token := strings.TrimPrefix(r.URL.Path, filesystemTransferPath)
		if len(token) > 8192 {
			http.Error(w, "invalid or expired blob transfer", http.StatusForbidden)
			return
		}
		claims, err := s.verifyTransfer(token)
		if err != nil {
			http.Error(w, "invalid or expired blob transfer", http.StatusForbidden)
			return
		}
		download := claims.Operation == http.MethodGet && (r.Method == http.MethodGet || r.Method == http.MethodHead)
		if r.Method != claims.Operation && !download {
			allowed := claims.Operation
			if claims.Operation == http.MethodGet {
				allowed = http.MethodGet + ", " + http.MethodHead
			}
			w.Header().Set("Allow", allowed)
			http.Error(w, "blob transfer operation not allowed", http.StatusMethodNotAllowed)
			return
		}
		if download {
			s.serveDownload(w, r, claims)
			return
		}
		s.serveUpload(w, r, claims)
	})
}

func (s *FilesystemStore) serveUpload(w http.ResponseWriter, r *http.Request, claims transferClaims) {
	if claims.ContentType != "" && r.Header.Get("Content-Type") != claims.ContentType {
		http.Error(w, "content type does not match transfer credential", http.StatusBadRequest)
		return
	}
	if r.ContentLength >= 0 {
		if claims.ExactSize && r.ContentLength != claims.SizeLimit {
			http.Error(w, "content length does not match transfer credential", http.StatusBadRequest)
			return
		}
		if !claims.ExactSize && claims.SizeLimit > 0 && r.ContentLength > claims.SizeLimit {
			http.Error(w, "content length exceeds transfer credential", http.StatusRequestEntityTooLarge)
			return
		}
	}
	exact, maximum := int64(UnknownObjectSize), int64(UnknownObjectSize)
	if claims.ExactSize {
		exact = claims.SizeLimit
	} else if claims.SizeLimit > 0 {
		maximum = claims.SizeLimit
	}
	controller := http.NewResponseController(w)
	body := &idleDeadlineReader{
		controller: controller,
		reader:     r.Body,
		timeout:    s.idleTimeout,
	}
	attrs, err := s.writeObject(r.Context(), claims.Key, body, claims.CreateOnly, exact, maximum, expectedKeyDigest(claims.Key))
	// A long upload may outlive the server's ordinary absolute WriteTimeout.
	// Give the final response one bounded idle window without disabling limits.
	if deadlineErr := controller.SetWriteDeadline(time.Now().Add(s.idleTimeout)); deadlineErr != nil && !errors.Is(deadlineErr, http.ErrNotSupported) && err == nil {
		err = deadlineErr
	}
	switch {
	case err == nil:
		w.Header().Set("ETag", `"sha256:`+attrs.SHA256+`"`)
		w.WriteHeader(http.StatusCreated)
	case errors.Is(err, ErrObjectAlreadyExists):
		http.Error(w, "blob object already exists", http.StatusPreconditionFailed)
	case errors.Is(err, ErrStorageFull):
		http.Error(w, "blob storage capacity exceeded", http.StatusInsufficientStorage)
	case errors.Is(err, ErrInvalidUpload):
		http.Error(w, "blob upload failed validation", http.StatusUnprocessableEntity)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		http.Error(w, "blob upload interrupted", http.StatusRequestTimeout)
	case isNetworkTimeout(err):
		http.Error(w, "blob upload idle timeout", http.StatusRequestTimeout)
	default:
		http.Error(w, "blob upload failed", http.StatusInternalServerError)
	}
}

func (s *FilesystemStore) serveDownload(w http.ResponseWriter, r *http.Request, claims transferClaims) {
	reader, info, err := s.openObject(r.Context(), claims.Key)
	if errors.Is(err, ErrObjectNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "blob download failed", http.StatusInternalServerError)
		return
	}
	defer func() { _ = reader.Close() }()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("ETag", filesystemETag(info))
	w.Header().Set("Cache-Control", "private, no-store")
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(s.idleTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		http.Error(w, "blob download failed", http.StatusInternalServerError)
		return
	}
	deadlineWriter := &idleDeadlineResponseWriter{
		ResponseWriter: w,
		controller:     controller,
		timeout:        s.idleTimeout,
	}
	http.ServeContent(deadlineWriter, r, path.Base(claims.Key), info.ModTime(), reader)
}

type idleDeadlineReader struct {
	controller *http.ResponseController
	reader     io.Reader
	timeout    time.Duration
}

func (r *idleDeadlineReader) Read(p []byte) (int, error) {
	if r.timeout > 0 {
		if err := r.controller.SetReadDeadline(time.Now().Add(r.timeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
			return 0, err
		}
	}
	return r.reader.Read(p)
}

type idleDeadlineResponseWriter struct {
	http.ResponseWriter
	controller *http.ResponseController
	timeout    time.Duration
}

func (w *idleDeadlineResponseWriter) Write(p []byte) (int, error) {
	if w.timeout > 0 {
		if err := w.controller.SetWriteDeadline(time.Now().Add(w.timeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
			return 0, err
		}
	}
	return w.ResponseWriter.Write(p)
}

func isNetworkTimeout(err error) bool {
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
}

func filesystemETag(info os.FileInfo) string {
	if id, ok := filesystemIdentity(info); ok {
		return fmt.Sprintf(`"%x-%x-%x-%x"`, id.device, id.inode, info.Size(), info.ModTime().UnixNano())
	}
	return fmt.Sprintf(`"%x-%x"`, info.Size(), info.ModTime().UnixNano())
}

var _ Store = (*FilesystemStore)(nil)
var _ CreateOnlyUploadSigner = (*FilesystemStore)(nil)
var _ CreateOnlyPromoter = (*FilesystemStore)(nil)
var _ GenerationPurger = (*FilesystemStore)(nil)
var _ Putter = (*FilesystemStore)(nil)
var _ TransferHandlerProvider = (*FilesystemStore)(nil)
