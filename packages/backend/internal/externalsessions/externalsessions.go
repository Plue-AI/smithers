// Package externalsessions finds the transcripts of agents a person runs
// beside Smithers on this machine, Codex and Claude Code, and reads them as
// raw JSONL from a byte offset (mvp.md M-38). It never parses a record: the
// app decodes the lines with @smthrs/harness/ExternalTranscript, so every
// host serves the same bytes and one decoder reads them.
//
// Only the agents' own session directories are read. A caller names a
// session by id or unique prefix, never by path; a file is a candidate only
// when it is a regular file whose name carries a session id. A root may be
// a link; no link under a root is followed.
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
	"syscall"
	"time"
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
// each host answers it with.
type Refusal struct {
	Status  int
	Code    string
	Message string
}

func (r *Refusal) Error() string { return r.Message }

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

// Roots are the directories agent writes sessions under, its configured
// home first, then its default home, then each Smithers account home of
// that agent. Account homes are listed on every call, so one added later
// is found.
func (f *Finder) Roots(agent Agent) []string {
	env, defaultHome, sessions, account := "CODEX_HOME", ".codex", "sessions", "codex"
	if agent == ClaudeCode {
		env, defaultHome, sessions, account = "CLAUDE_CONFIG_DIR", ".claude", "projects", "claude"
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
	accounts := filepath.Join(f.Home, ".smithers", "accounts")
	if entries, err := os.ReadDir(accounts); err == nil {
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), account) {
				roots = append(roots, filepath.Join(accounts, entry.Name(), sessions))
			}
		}
	}
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

// Session is one found transcript.
type Session struct {
	Agent Agent
	ID    string
	Path  string
}

var codexRollout = regexp.MustCompile(`^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+)\.jsonl$`)

type candidate struct {
	id, path string
	modified int64
}

// candidates lists every session file of agent under root whose id starts
// with prefix. Codex keeps rollouts in dated directories at any depth;
// Claude Code keeps one file per session in each project's directory.
func candidates(agent Agent, root, prefix string) []candidate {
	var found []candidate
	add := func(id, path string) {
		if !strings.HasPrefix(id, prefix) {
			return
		}
		if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() {
			found = append(found, candidate{id: id, path: path, modified: info.ModTime().UnixNano()})
		}
	}
	if agent == Codex {
		// A root may be a link (a dotfiles home): the trailing separator
		// follows it. Nothing under it is followed.
		_ = filepath.WalkDir(root+string(filepath.Separator), func(path string, entry fs.DirEntry, err error) error {
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
		return Session{}, &Refusal{http.StatusBadRequest, "invalid_request", fmt.Sprintf("A %s session id or a prefix of at least four characters is required.", agent.Name())}
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
		if info, err := os.Lstat(hit.session.Path); ok && now().Before(hit.until) && err == nil && info.Mode().IsRegular() {
			return hit.session, nil
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

func (f *Finder) find(agent Agent, prefix string) (Session, error) {
	var found []candidate
	for _, root := range f.Roots(agent) {
		found = append(found, candidates(agent, root, prefix)...)
	}
	ids := map[string]bool{}
	for _, each := range found {
		ids[each.id] = true
	}
	switch len(ids) {
	case 0:
		return Session{}, &Refusal{http.StatusNotFound, "source_not_found", fmt.Sprintf("No %s session %s on this machine.", agent.Name(), prefix)}
	case 1:
	default:
		names := make([]string, 0, len(ids))
		for id := range ids {
			names = append(names, id)
		}
		sort.Strings(names)
		return Session{}, &Refusal{http.StatusConflict, "ambiguous_session", fmt.Sprintf("%s matches %d %s sessions: %s.", prefix, len(names), agent.Name(), strings.Join(names, ", "))}
	}
	newest := found[0]
	for _, each := range found[1:] {
		if each.modified > newest.modified {
			newest = each
		}
	}
	return Session{Agent: agent, ID: newest.id, Path: newest.path}, nil
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

// Read answers path's complete lines from offset, at most ChunkLimit bytes
// of them; when the first line alone is longer, that one line, up to
// LineLimit.
func Read(path string, offset int64) (Chunk, error) {
	// A file swapped for a link since it was found is not followed.
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return Chunk{}, &Refusal{http.StatusNotFound, "source_not_found", "The session file is gone."}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Chunk{}, err
	}
	size := info.Size()
	if offset < 0 || offset > size {
		return Chunk{}, &Refusal{http.StatusConflict, "offset_out_of_range", fmt.Sprintf("The session file is %d bytes, shorter than offset %d: it was replaced.", size, offset)}
	}
	buffer := make([]byte, min(int64(ChunkLimit), size-offset))
	n, err := file.ReadAt(buffer, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return Chunk{}, err
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
			return Chunk{}, err
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
	return Chunk{}, &Refusal{http.StatusUnprocessableEntity, "line_too_long", fmt.Sprintf("The line at byte %d is longer than %d MiB.", offset, LineLimit>>20)}
}
