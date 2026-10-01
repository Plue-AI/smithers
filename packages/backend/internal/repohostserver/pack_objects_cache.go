package repohostserver

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Clone pack cache (smithersai/plue#780).
//
// A clone pays git pack-objects for every object it receives, and a shallow
// clone cannot use reachability bitmaps: a depth-200 clone of
// smithersai/smithers cost about a minute of repo-host CPU. Hosted CI boots
// one guest per job, so twenty guests cloned the same commit at once, saturated
// repo-host, and timed out in fetch admission.
//
// upload-pack still negotiates and checks every want against the refs the
// caller may see. Only its pack-objects step goes through
// uploadpack.packObjectsHook, which runs this binary again (see init). The
// hook keys the pack on the repository, pack-objects arguments, and the
// revision list upload-pack writes to its stdin. Requests with the same key
// share one pack: the first builds it under a per-key lock while the rest wait,
// then all stream the same file. Fetches that send haves are incremental and
// rarely repeat, so they bypass the cache.
//
// A cached pack is reused for at most the TTL. --include-tag means a tag
// created during that window is not sent; the next fetch picks it up.
const (
	packObjectsCacheDirEnv      = "SMITHERS_PACK_OBJECTS_CACHE_DIR"
	packObjectsCacheMaxBytesEnv = "SMITHERS_PACK_OBJECTS_CACHE_MAX_BYTES"
	packObjectsCacheTTLEnv      = "SMITHERS_PACK_OBJECTS_CACHE_TTL"

	packObjectsCacheDirName = ".pack-objects-cache@"

	defaultPackObjectsCacheMaxBytes int64 = 4 << 30
	defaultPackObjectsCacheTTL            = 10 * time.Minute

	// maxPackObjectsInput bounds the revision list the hook buffers. It
	// lists wants, shallow boundaries, and haves, never objects.
	maxPackObjectsInput = 64 << 20
)

// packObjectsCache is the server-side setting the hook inherits through the
// upload-pack environment. A nil cache disables the hook.
type packObjectsCache struct {
	dir      string
	maxBytes int64
	ttl      time.Duration
	hook     string
}

// newPackObjectsCache resolves Config into a cache, or nil when disabled.
// LoadConfig enables it by default (packObjectsCacheFromEnv).
func newPackObjectsCache(cfg Config) (*packObjectsCache, error) {
	dir := strings.TrimSpace(cfg.PackObjectsCacheDir)
	if dir == "" {
		return nil, nil
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve pack cache dir: %w", err)
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, fmt.Errorf("create pack cache dir: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate repo-host executable for the pack cache hook: %w", err)
	}
	c := &packObjectsCache{dir: abs, maxBytes: cfg.PackObjectsCacheMaxBytes, ttl: cfg.PackObjectsCacheTTL, hook: exe}
	if c.maxBytes <= 0 {
		c.maxBytes = defaultPackObjectsCacheMaxBytes
	}
	if c.ttl <= 0 {
		c.ttl = defaultPackObjectsCacheTTL
	}
	return c, nil
}

// hookConfig is the protected git configuration that routes pack-objects
// through the hook. git honors uploadpack.packObjectsHook only from system,
// global, or command-line scope; GIT_CONFIG_COUNT is command-line scope.
func (c *packObjectsCache) hookConfig() []string {
	if c == nil {
		return nil
	}
	return []string{"uploadpack.packObjectsHook", shellQuoteArg(c.hook)}
}

// hookEnv carries the cache settings to the hook process.
func (c *packObjectsCache) hookEnv() []string {
	if c == nil {
		return nil
	}
	return []string{
		packObjectsCacheDirEnv + "=" + c.dir,
		packObjectsCacheMaxBytesEnv + "=" + strconv.FormatInt(c.maxBytes, 10),
		packObjectsCacheTTLEnv + "=" + c.ttl.String(),
	}
}

func shellQuoteArg(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// init turns this process into the pack-objects hook when git started it as
// one. git runs the hook as `<hook> git [options] pack-objects <args>`, with
// upload-pack's environment. Both markers are required, so neither a stray
// environment variable nor a stray argument changes how the server starts.
func init() {
	dir := os.Getenv(packObjectsCacheDirEnv)
	if dir == "" || !isPackObjectsHookInvocation(os.Args[1:]) {
		return
	}
	os.Exit(runPackObjectsHook(os.Args[1:], dir, os.Stdin, os.Stdout, os.Stderr))
}

func isPackObjectsHookInvocation(args []string) bool {
	if len(args) < 2 || args[0] != "git" {
		return false
	}
	for _, arg := range args[1:] {
		if arg == "pack-objects" {
			return true
		}
	}
	return false
}

// runPackObjectsHook serves one pack-objects run and returns its exit code.
func runPackObjectsHook(args []string, dir string, stdin io.Reader, stdout, stderr io.Writer) int {
	input, err := io.ReadAll(io.LimitReader(stdin, maxPackObjectsInput+1))
	if err != nil {
		fmt.Fprintf(stderr, "pack cache: read revisions: %v\n", err)
		return 128
	}
	if len(input) > maxPackObjectsInput {
		fmt.Fprintln(stderr, "pack cache: revision list too large")
		return 128
	}
	env := packObjectsChildEnv(os.Environ())
	run := func(out io.Writer) int { return runPackObjects(args, env, input, out, stderr) }

	cwd, err := os.Getwd()
	if err != nil || !packObjectsCacheable(input) {
		return run(stdout)
	}
	cache := packObjectsHookCache{dir: dir, maxBytes: envInt64(packObjectsCacheMaxBytesEnv, defaultPackObjectsCacheMaxBytes), ttl: envDuration(packObjectsCacheTTLEnv, defaultPackObjectsCacheTTL)}
	return cache.serve(packObjectsKey(cwd, args, input), stdout, run)
}

// packObjectsCacheable reports whether the revision list asks for a pack
// that other callers are likely to ask for too: no haves or extra edges
// after --not.
func packObjectsCacheable(input []byte) bool {
	scanner := bufio.NewScanner(bytes.NewReader(input))
	scanner.Buffer(make([]byte, 0, 4096), maxPackObjectsInput)
	afterNot := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case line == "":
		case line == "--not":
			afterNot = true
		case afterNot, strings.HasPrefix(line, "^"):
			return false
		}
	}
	return scanner.Err() == nil
}

func packObjectsKey(repository string, args []string, input []byte) string {
	h := sha256.New()
	h.Write([]byte(repository))
	for _, arg := range args {
		h.Write([]byte{0})
		h.Write([]byte(arg))
	}
	h.Write([]byte{0, 0})
	h.Write(input)
	return hex.EncodeToString(h.Sum(nil))
}

// packObjectsChildEnv removes the hook markers so the real pack-objects (and
// anything it starts) cannot re-enter the hook.
func packObjectsChildEnv(environ []string) []string {
	env := make([]string, 0, len(environ))
	for _, kv := range environ {
		if strings.HasPrefix(kv, packObjectsCacheDirEnv+"=") ||
			strings.HasPrefix(kv, packObjectsCacheMaxBytesEnv+"=") ||
			strings.HasPrefix(kv, packObjectsCacheTTLEnv+"=") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

// runPackObjects runs the command git asked the hook to run.
func runPackObjects(args, env []string, input []byte, stdout, stderr io.Writer) int {
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = env
	cmd.Stdin = bytes.NewReader(input)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() > 0 {
			return exitErr.ExitCode()
		}
		fmt.Fprintf(stderr, "pack cache: run pack-objects: %v\n", err)
		return 128
	}
	return 0
}

type packObjectsHookCache struct {
	dir      string
	maxBytes int64
	ttl      time.Duration
	now      func() time.Time
}

func (c packObjectsHookCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// serve streams the cached pack for key, building it first when it is
// missing or older than the TTL. Concurrent callers for one key wait on its
// lock instead of building the same pack again. Any cache failure falls back
// to running pack-objects straight to stdout.
func (c packObjectsHookCache) serve(key string, stdout io.Writer, run func(io.Writer) int) int {
	packPath := filepath.Join(c.dir, key+".pack")
	lock, err := os.OpenFile(filepath.Join(c.dir, key+".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return run(stdout)
	}
	defer lock.Close()
	// The kernel drops the lock if this process dies, so a killed builder
	// never strands its waiters.
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return run(stdout)
	}
	unlock := func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }

	if pack, ok := c.openFresh(packPath); ok {
		unlock()
		return streamPack(pack, stdout)
	}

	tmp, err := os.CreateTemp(c.dir, key+".*.tmp")
	if err != nil {
		unlock()
		return run(stdout)
	}
	code := run(tmp)
	closeErr := tmp.Close()
	if code != 0 || closeErr != nil {
		_ = os.Remove(tmp.Name())
		unlock()
		if code == 0 {
			// The pack is lost; let git fail the fetch rather than send part.
			return 128
		}
		return code
	}
	info, statErr := os.Stat(tmp.Name())
	cacheable := statErr == nil && info.Size() <= c.maxBytes
	served := tmp.Name()
	if cacheable && os.Rename(tmp.Name(), packPath) == nil {
		served = packPath
	}
	pack, err := os.Open(served)
	if served != packPath {
		// Too large to keep, or not renamed: serve it once and drop it.
		_ = os.Remove(served)
	}
	unlock()
	if err != nil {
		return 128
	}
	code = streamPack(pack, stdout)
	c.evict(packPath)
	return code
}

// openFresh opens packPath when it exists within the TTL, refreshing its
// modification time so eviction keeps recently served packs.
func (c packObjectsHookCache) openFresh(packPath string) (*os.File, bool) {
	info, err := os.Stat(packPath)
	if err != nil {
		return nil, false
	}
	now := c.clock()
	if now.Sub(info.ModTime()) > c.ttl {
		_ = os.Remove(packPath)
		return nil, false
	}
	pack, err := os.Open(packPath)
	if err != nil {
		return nil, false
	}
	_ = os.Chtimes(packPath, now, info.ModTime())
	return pack, true
}

func streamPack(pack *os.File, stdout io.Writer) int {
	defer pack.Close()
	if _, err := io.Copy(stdout, pack); err != nil {
		return 128
	}
	return 0
}

// evict removes expired packs, temporary files, and locks, then the least
// recently served packs until the cache fits maxBytes. keep is the pack just
// served; an open pack stays readable after removal.
func (c packObjectsHookCache) evict(keep string) {
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	now := c.clock()
	type pack struct {
		path string
		size int64
		at   time.Time
	}
	var packs []pack
	var total int64
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		path := filepath.Join(c.dir, entry.Name())
		expired := now.Sub(info.ModTime()) > c.ttl
		switch {
		case strings.HasSuffix(entry.Name(), ".pack"):
			if expired {
				_ = os.Remove(path)
				continue
			}
			packs = append(packs, pack{path: path, size: info.Size(), at: info.ModTime()})
			total += info.Size()
		case expired:
			// A temp file of a builder that died, or an idle lock.
			_ = os.Remove(path)
		}
	}
	sort.Slice(packs, func(i, j int) bool { return packs[i].at.Before(packs[j].at) })
	for _, p := range packs {
		if total <= c.maxBytes {
			return
		}
		if p.path == keep {
			continue
		}
		if os.Remove(p.path) == nil {
			total -= p.size
		}
	}
}

// packObjectsCacheFromEnv enables the cache under StoragePath unless
// SMITHERS_REPO_HOST_PACK_CACHE_DIR is "off" or names another directory.
func packObjectsCacheFromEnv(cfg *Config) error {
	switch dir := strings.TrimSpace(os.Getenv("SMITHERS_REPO_HOST_PACK_CACHE_DIR")); dir {
	case "off":
		cfg.PackObjectsCacheDir = ""
		return nil
	case "":
		cfg.PackObjectsCacheDir = filepath.Join(cfg.StoragePath, packObjectsCacheDirName)
	default:
		cfg.PackObjectsCacheDir = dir
	}
	if raw := strings.TrimSpace(os.Getenv("SMITHERS_REPO_HOST_PACK_CACHE_MAX_BYTES")); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n <= 0 {
			return fmt.Errorf("SMITHERS_REPO_HOST_PACK_CACHE_MAX_BYTES must be a positive byte count")
		}
		cfg.PackObjectsCacheMaxBytes = n
	}
	if raw := strings.TrimSpace(os.Getenv("SMITHERS_REPO_HOST_PACK_CACHE_TTL")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return fmt.Errorf("SMITHERS_REPO_HOST_PACK_CACHE_TTL must be a positive duration")
		}
		cfg.PackObjectsCacheTTL = d
	}
	return nil
}

func envInt64(name string, fallback int64) int64 {
	if n, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(name)), 10, 64); err == nil && n > 0 {
		return n
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	if d, err := time.ParseDuration(strings.TrimSpace(os.Getenv(name))); err == nil && d > 0 {
		return d
	}
	return fallback
}
