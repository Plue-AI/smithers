// Package externalsessions finds the transcripts of agents a person runs
// beside Smithers on this machine, Codex and Claude Code, and reads them as
// raw JSONL from a byte offset (mvp.md M-38). It never parses a record: the
// app decodes the lines with @smthrs/harness/ExternalTranscript, so every
// host serves the same bytes and one decoder reads them.
//
// Only the agents' own session directories are read. A caller names a
// session by id or unique prefix, never by path; a file is a candidate only
// when it is a regular file whose name carries a session id.
//
// A root may be a link (a dotfiles home) only when its real path is inside
// the real path of the account's own home and not under
// <home>/.smithers/accounts/, where a person keeps other accounts' homes.
// A root linked anywhere else yields no sessions; it is not an error. Roots
// are resolved again on every Find, since a link can change. Nothing
// beneath a root is followed: a session file is opened relative to its
// root's real directory with no symlink at any component (openat2 with
// RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS on Linux, otherwise one O_NOFOLLOW
// openat per component), so a directory swapped for a link after Find is
// refused, not read (spec §9.6.6).
package externalsessions

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// Agent is an agent whose transcripts this package finds; its values are
// ExternalTranscript's agent kinds.
type Agent string

const (
	Codex      Agent = "codex"
	ClaudeCode Agent = "claude-code"
)

// Name is the agent's name in words a person reads.
func (a Agent) Name() string {
	if a == ClaudeCode {
		return "Claude Code"
	}
	return "Codex"
}

// ParseAgent accepts the agents this package serves.
func ParseAgent(value string) (Agent, bool) {
	switch Agent(value) {
	case Codex, ClaudeCode:
		return Agent(value), true
	}
	return "", false
}

// IDPattern is a session id or a prefix of at least four characters.
var IDPattern = regexp.MustCompile(`^[0-9a-f-]{4,36}$`)

const (
	// ChunkLimit bounds one read: whole lines up to 4 MiB.
	ChunkLimit = 4 << 20
	// LineLimit bounds the one line a read returns when that line alone is
	// longer than ChunkLimit.
	LineLimit = 64 << 20
)

// Refusal is why a session was not found or read, with the HTTP status
// and the §6.2.3 error class each host answers it with. Its message names
// no path and carries no OS error text.
type Refusal struct {
	Status  int
	Class   string
	Code    string
	Message string
}

func (r *Refusal) Error() string { return r.Message }

func refuse(status int, code, message string) *Refusal {
	return &Refusal{Status: status, Class: "user", Code: code, Message: message}
}

// errGone is a session file that is no longer where it was found, or is no
// longer a regular file beneath its root without a link.
var errGone = refuse(http.StatusNotFound, "source_not_found", "The session file is gone.")

// errUnreadable is a session file the account could not read.
var errUnreadable = &Refusal{Status: http.StatusServiceUnavailable, Class: "infra", Code: "source_unreadable", Message: "The session file could not be read."}

// Finder finds sessions under the directories of the account this process
// runs as.
type Finder struct {
	// Home is the account's home directory.
	Home string
	// Getenv reads CODEX_HOME and CLAUDE_CONFIG_DIR.
	Getenv func(string) string
	// Remember keeps a found session this long, so a session followed
	// every second is not looked for every second (a Claude Code home
	// holds thousands of transcripts). Zero looks every time.
	Remember time.Duration
	// Now is the clock Remember reads; nil is time.Now.
	Now func() time.Time

	mu    sync.Mutex
	found map[string]remembered
}

type remembered struct {
	session Session
	until   time.Time
}

// Roots are the directories agent writes sessions under: its configured
// home first, then its default home. Nothing else on the machine is read;
// other homes a person keeps for the same agent (one per subscription, say)
// are theirs to point CODEX_HOME or CLAUDE_CONFIG_DIR at.
func (f *Finder) Roots(agent Agent) []string {
	env, defaultHome, sessions := "CODEX_HOME", ".codex", "sessions"
	if agent == ClaudeCode {
		env, defaultHome, sessions = "CLAUDE_CONFIG_DIR", ".claude", "projects"
	}
	var roots []string
	if f.Getenv != nil {
		if configured := f.Getenv(env); configured != "" {
			roots = append(roots, filepath.Join(configured, sessions))
		}
	}
	if f.Home == "" {
		return roots
	}
	roots = append(roots, filepath.Join(f.Home, defaultHome, sessions))
	unique := roots[:0]
	seen := map[string]bool{}
	for _, root := range roots {
		if !seen[root] {
			seen[root] = true
			unique = append(unique, root)
		}
	}
	return unique
}

// root is one root a Find reads: shown is the path as configured, real
// its real path, which every open starts from.
type root struct{ shown, real string }

// roots are agent's Roots that the link rule admits, resolved now.
func (f *Finder) roots(agent Agent) []root {
	home := ""
	if f.Home != "" {
		if real, err := filepath.EvalSymlinks(f.Home); err == nil {
			home = real
		}
	}
	var admitted []root
	seen := map[string]bool{}
	for _, shown := range f.Roots(agent) {
		shown, err := filepath.Abs(shown)
		if err != nil {
			continue
		}
		real, err := filepath.EvalSymlinks(shown)
		if err != nil || seen[real] {
			continue
		}
		if linked(shown, real) && !inHome(real, home) {
			continue
		}
		seen[real] = true
		admitted = append(admitted, root{shown: shown, real: real})
	}
	return admitted
}

// linked reports whether the agent home or its sessions directory in
// shown (the last two components) is a link: real differs from shown with
// only the directories above the agent home resolved.
func linked(shown, real string) bool {
	agentHome := filepath.Dir(shown)
	above, err := filepath.EvalSymlinks(filepath.Dir(agentHome))
	if err != nil {
		return true
	}
	return filepath.Join(above, filepath.Base(agentHome), filepath.Base(shown)) != real
}

// inHome reports whether real is inside home and not under its
// .smithers/accounts directory.
func inHome(real, home string) bool {
	within := func(path, dir string) bool {
		rel, err := filepath.Rel(dir, path)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	return home != "" && within(real, home) && !within(real, filepath.Join(home, ".smithers", "accounts"))
}

// Session is one found transcript: Path is where it was found, as the
// configured root names it; it is opened relative to its root's real
// directory.
type Session struct {
	Agent Agent
	ID    string
	Path  string
	root  string
	rel   string
}

var codexRollout = regexp.MustCompile(`^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+)\.jsonl$`)

type candidate struct {
	id, rel  string
	root     root
	modified int64
}

// candidates lists every session file of agent under root whose id starts
// with prefix. Codex keeps rollouts in dated directories at any depth;
// Claude Code keeps one file per session in each project's directory. The
// walk starts at the root's real path, so no link is followed.
func candidates(agent Agent, at root, prefix string) []candidate {
	var found []candidate
	add := func(id, path string) {
		if !strings.HasPrefix(id, prefix) {
			return
		}
		rel, err := filepath.Rel(at.real, path)
		if err != nil {
			return
		}
		if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() {
			found = append(found, candidate{id: id, rel: rel, root: at, modified: info.ModTime().UnixNano()})
		}
	}
	root := at.real
	if agent == Codex {
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				if entry != nil && entry.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if entry.Type().IsRegular() {
				if match := codexRollout.FindStringSubmatch(entry.Name()); match != nil {
					add(match[1], path)
				}
			}
			return nil
		})
		return found
	}
	projects, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(root, project.Name()))
		if err != nil {
			continue
		}
		for _, file := range files {
			id, ok := strings.CutSuffix(file.Name(), ".jsonl")
			if ok && file.Type().IsRegular() && IDPattern.MatchString(id) {
				add(id, filepath.Join(root, project.Name(), file.Name()))
			}
		}
	}
	return found
}

// Find is the session whose id starts with prefix. A session copied into
// several homes reads the copy written last; a prefix that names more than
// one session is refused. A found session is remembered for Remember while
// its file is still there; a refusal is never remembered.
func (f *Finder) Find(agent Agent, prefix string) (Session, error) {
	if !IDPattern.MatchString(prefix) {
		return Session{}, refuse(http.StatusBadRequest, "invalid_request", fmt.Sprintf("A %s session id or a prefix of at least four characters is required.", agent.Name()))
	}
	key := string(agent) + ":" + prefix
	now := time.Now
	if f.Now != nil {
		now = f.Now
	}
	if f.Remember > 0 {
		f.mu.Lock()
		hit, ok := f.found[key]
		f.mu.Unlock()
		// A hit stands while its root is still admitted and its file is
		// still a regular file beneath it with no link on the way.
		if ok && now().Before(hit.until) && f.admits(agent, hit.session.root) {
			if _, err := hit.session.Size(); err == nil {
				return hit.session, nil
			}
		}
	}
	session, err := f.find(agent, prefix)
	if err == nil && f.Remember > 0 {
		f.mu.Lock()
		if f.found == nil {
			f.found = map[string]remembered{}
		}
		for each, entry := range f.found {
			if !now().Before(entry.until) {
				delete(f.found, each)
			}
		}
		f.found[key] = remembered{session: session, until: now().Add(f.Remember)}
		f.mu.Unlock()
	}
	return session, err
}

// admits reports whether real is the real path of one of agent's roots
// now.
func (f *Finder) admits(agent Agent, real string) bool {
	for _, each := range f.roots(agent) {
		if each.real == real {
			return true
		}
	}
	return false
}

func (f *Finder) find(agent Agent, prefix string) (Session, error) {
	var found []candidate
	for _, root := range f.roots(agent) {
		found = append(found, candidates(agent, root, prefix)...)
	}
	ids := map[string]bool{}
	for _, each := range found {
		ids[each.id] = true
	}
	switch len(ids) {
	case 0:
		return Session{}, refuse(http.StatusNotFound, "source_not_found", fmt.Sprintf("No %s session %s on this machine.", agent.Name(), prefix))
	case 1:
	default:
		names := make([]string, 0, len(ids))
		for id := range ids {
			names = append(names, id)
		}
		sort.Strings(names)
		return Session{}, refuse(http.StatusConflict, "ambiguous_session", fmt.Sprintf("%s matches %d %s sessions: %s.", prefix, len(names), agent.Name(), strings.Join(names, ", ")))
	}
	newest := found[0]
	for _, each := range found[1:] {
		if each.modified > newest.modified {
			newest = each
		}
	}
	return Session{Agent: agent, ID: newest.id, Path: filepath.Join(newest.root.shown, newest.rel), root: newest.root.real, rel: newest.rel}, nil
}

// open opens the session's file beneath its root with no link at any
// component, and only while it is a regular file. Every failure is a
// Refusal: errGone when the file is not there as found, errUnreadable when
// the account cannot read it.
func (s Session) open() (*os.File, error) {
	if s.root == "" || s.rel == "" || !filepath.IsLocal(s.rel) {
		return nil, errGone
	}
	fd, err := openBeneath(s.root, s.rel)
	if err != nil {
		return nil, openRefusal(err)
	}
	file := os.NewFile(uintptr(fd), s.ID)
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, errUnreadable
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errGone
	}
	return file, nil
}

// openRefusal maps an open's error: a missing component, a link, or a
// component that is not a directory is gone; anything else is unreadable.
func openRefusal(err error) *Refusal {
	switch {
	case errors.Is(err, unix.ENOENT), errors.Is(err, unix.ELOOP), errors.Is(err, unix.ENOTDIR), errors.Is(err, unix.EXDEV):
		return errGone
	}
	return errUnreadable
}

// openFlags open a session file: read only, never a link, and without
// blocking on a FIFO swapped in for it.
const openFlags = unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK

// openBeneath opens rel beneath the directory root with no symlink at any
// component: openat2 where the kernel has it, otherwise openChain.
func openBeneath(root, rel string) (int, error) {
	dir, err := unix.Open(root, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	defer unix.Close(dir)
	if useOpenat2 {
		fd, err := openat2Beneath(dir, rel)
		if !errors.Is(err, errNoOpenat2) {
			return fd, err
		}
	}
	return openChain(dir, rel)
}

// useOpenat2 lets a test take openChain where openat2 is available.
var useOpenat2 = true

// openChain opens rel one component at a time from dir, each with
// O_NOFOLLOW, so a link at any component fails the open (ELOOP, or
// ENOTDIR for a directory link) instead of being followed.
func openChain(dir int, rel string) (int, error) {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	at := dir
	for i, part := range parts {
		flags := openFlags
		if i < len(parts)-1 {
			flags = unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_DIRECTORY
		}
		fd, err := unix.Openat(at, part, flags, 0)
		if at != dir {
			_ = unix.Close(at)
		}
		if err != nil {
			return -1, err
		}
		at = fd
	}
	return at, nil
}

// Size is the session file's size now, read through the same open as
// Read.
func (s Session) Size() (int64, error) {
	file, err := s.open()
	if err != nil {
		return 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return 0, errUnreadable
	}
	return info.Size(), nil
}

// Chunk is the complete lines from Offset: Text ends at a line boundary,
// Next is the offset after it, and EOF says the read reached the end of
// the file (an incomplete last line waits for its newline).
type Chunk struct {
	Offset int64
	Next   int64
	Text   []byte
	EOF    bool
}

// Read answers session's complete lines from offset, at most ChunkLimit
// bytes of them; when the first line alone is longer, that one line, up to
// LineLimit. Every error is a Refusal.
func Read(session Session, offset int64) (Chunk, error) {
	file, err := session.open()
	if err != nil {
		return Chunk{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Chunk{}, errUnreadable
	}
	size := info.Size()
	if offset < 0 || offset > size {
		return Chunk{}, refuse(http.StatusConflict, "offset_out_of_range", fmt.Sprintf("The session file is %d bytes, shorter than offset %d: it was replaced.", size, offset))
	}
	buffer := make([]byte, min(int64(ChunkLimit), size-offset))
	n, err := file.ReadAt(buffer, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return Chunk{}, errUnreadable
	}
	buffer = buffer[:n]
	end := offset + int64(n)
	if last := bytes.LastIndexByte(buffer, '\n'); last >= 0 {
		return Chunk{Offset: offset, Next: offset + int64(last) + 1, Text: buffer[:last+1], EOF: end >= size}, nil
	}
	if end >= size {
		return Chunk{Offset: offset, Next: offset, Text: []byte{}, EOF: true}, nil
	}
	// One line longer than a chunk: read on to its newline.
	line := buffer
	for int64(len(line)) < LineLimit && end < size {
		more := make([]byte, min(int64(ChunkLimit), size-end, LineLimit-int64(len(line))))
		m, err := file.ReadAt(more, end)
		if err != nil && !errors.Is(err, io.EOF) {
			return Chunk{}, errUnreadable
		}
		if newline := bytes.IndexByte(more[:m], '\n'); newline >= 0 {
			line = append(line, more[:newline+1]...)
			next := offset + int64(len(line))
			return Chunk{Offset: offset, Next: next, Text: line, EOF: next >= size}, nil
		}
		line = append(line, more[:m]...)
		end += int64(m)
		if m == 0 {
			break
		}
	}
	if end >= size {
		return Chunk{Offset: offset, Next: offset, Text: []byte{}, EOF: true}, nil
	}
	return Chunk{}, refuse(http.StatusUnprocessableEntity, "line_too_long", fmt.Sprintf("The line at byte %d is longer than %d MiB.", offset, LineLimit>>20))
}
