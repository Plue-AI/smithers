package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/gitutil"
)

// The mythical stack's git engine: plain git plumbing over one bare scratch
// repository. Every commit it writes is a pure function of its inputs (tree,
// parent, identities, message and a service-minted change id), so a retry
// after a crash reproduces the same object ids and a compare-and-swap push
// replays idempotently. Nothing here moves a ref of the hosted repository;
// the service pushes the refs this engine computes.

var (
	mythicalSHA      = regexp.MustCompile(`^[0-9a-f]{40}$`)
	mythicalChangeID = regexp.MustCompile(`^[k-z]{32}$`)
)

// errMythicalConflict is a textual conflict in a three-way tree merge.
type errMythicalConflict struct {
	Paths []string
}

func (e *errMythicalConflict) Error() string {
	return "conflict in " + strings.Join(e.Paths, ", ")
}

// mythicalCommit is one git commit object, parsed. Author and Committer keep
// git's raw "Name <email> seconds zone" form so a rewrite never reformats them.
type mythicalCommit struct {
	ID        string
	Tree      string
	Parents   []string
	Author    string
	Committer string
	ChangeID  string
	Message   string
}

func (c mythicalCommit) Parent() string {
	if len(c.Parents) == 0 {
		return ""
	}
	return c.Parents[0]
}

// Subject is the first line of the message.
func (c mythicalCommit) Subject() string {
	subject, _, _ := strings.Cut(strings.TrimLeft(c.Message, "\n"), "\n")
	return strings.TrimSpace(subject)
}

type mythicalGit struct {
	dir string
}

func (g mythicalGit) command(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	// Object transport never consumes hooks or credential helpers from the
	// repository config. It replaces inherited executable configuration.
	cmd := gitHubMainPullCommand(ctx, append([]string{"-c", "core.hooksPath=" + os.DevNull,
		"-c", "credential.helper=", "-c", "core.sshCommand=/usr/bin/ssh",
		"-c", "protocol.ext.allow=never", "-c", "diff.external=",
		"--git-dir", g.dir}, args...)...)
	cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=false", "LC_ALL=C")
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if err != nil {
		return stdout.Bytes(), gitHubMainPullCommandError("git "+args[0], err, stderr.Bytes())
	}
	return stdout.Bytes(), nil
}

func (g mythicalGit) git(ctx context.Context, args ...string) (string, error) {
	out, err := g.command(ctx, nil, args...)
	return strings.TrimSpace(string(out)), err
}

// init creates the bare scratch repository when it does not exist yet.
func (g mythicalGit) init(ctx context.Context) error {
	if _, err := g.git(ctx, "rev-parse", "--git-dir"); err == nil {
		return nil
	}
	out, err := gitHubMainPullCommand(ctx, "init", "--quiet", "--bare", "--template=", g.dir).CombinedOutput()
	if err != nil {
		return gitHubMainPullCommandError("git init", err, out)
	}
	return nil
}

// readCommit parses one commit object. Headers other than the ones kept here
// (gpgsig, mergetag, encoding) are deliberately dropped by any rewrite.
func (g mythicalGit) readCommit(ctx context.Context, id string) (mythicalCommit, error) {
	if !mythicalSHA.MatchString(id) {
		return mythicalCommit{}, fmt.Errorf("invalid commit id %q", id)
	}
	raw, err := g.command(ctx, nil, "cat-file", "commit", id)
	if err != nil {
		return mythicalCommit{}, err
	}
	commit := mythicalCommit{ID: id}
	head, message, _ := bytes.Cut(raw, []byte("\n\n"))
	commit.Message = string(message)
	for _, line := range strings.Split(string(head), "\n") {
		if strings.HasPrefix(line, " ") {
			continue // a multi-line header value (gpgsig, mergetag)
		}
		key, value, _ := strings.Cut(line, " ")
		switch key {
		case "tree":
			commit.Tree = value
		case "parent":
			commit.Parents = append(commit.Parents, value)
		case "author":
			commit.Author = value
		case "committer":
			commit.Committer = value
		case "change-id":
			commit.ChangeID = value
		}
	}
	if !mythicalSHA.MatchString(commit.Tree) || commit.Author == "" || commit.Committer == "" {
		return mythicalCommit{}, fmt.Errorf("commit %s is malformed", id)
	}
	return commit, nil
}

// writeCommit stores a commit object and returns its id. The object is
// deterministic: identical fields always give the identical id.
func (g mythicalGit) writeCommit(ctx context.Context, commit mythicalCommit) (string, error) {
	if !mythicalSHA.MatchString(commit.Tree) || (commit.ChangeID != "" && !mythicalChangeID.MatchString(commit.ChangeID)) {
		return "", errors.New("refusing to write a malformed commit")
	}
	var raw strings.Builder
	raw.WriteString("tree " + commit.Tree + "\n")
	for _, parent := range commit.Parents {
		if !mythicalSHA.MatchString(parent) {
			return "", fmt.Errorf("invalid parent %q", parent)
		}
		raw.WriteString("parent " + parent + "\n")
	}
	for _, identity := range []string{commit.Author, commit.Committer} {
		if identity == "" || strings.ContainsAny(identity, "\n\x00") {
			return "", errors.New("invalid commit identity")
		}
	}
	raw.WriteString("author " + commit.Author + "\n")
	raw.WriteString("committer " + commit.Committer + "\n")
	if commit.ChangeID != "" {
		raw.WriteString("change-id " + commit.ChangeID + "\n")
	}
	raw.WriteString("\n")
	raw.WriteString(commit.Message)
	id, err := g.command(ctx, []byte(raw.String()), "hash-object", "-t", "commit", "-w", "--stdin")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(id)), nil
}

// firstParents returns up to limit commits of tip's first-parent line, tip first.
func (g mythicalGit) firstParents(ctx context.Context, tip string, limit int) ([]mythicalCommit, error) {
	out, err := g.git(ctx, "rev-list", "--first-parent", "--max-count="+strconv.Itoa(limit), tip)
	if err != nil {
		return nil, err
	}
	var chain []mythicalCommit
	for _, id := range strings.Fields(out) {
		commit, err := g.readCommit(ctx, id)
		if err != nil {
			return nil, err
		}
		chain = append(chain, commit)
	}
	return chain, nil
}

// firstParentsSince returns the first-parent commits after base up to tip,
// oldest first, at most limit of them, and whether base is on tip's line.
func (g mythicalGit) firstParentsSince(ctx context.Context, base, tip string, limit int) ([]mythicalCommit, bool, error) {
	out, err := g.git(ctx, "rev-list", "--first-parent", "--reverse", base+".."+tip)
	if err != nil {
		return nil, false, err
	}
	ids := strings.Fields(out)
	if len(ids) > 0 {
		first, err := g.readCommit(ctx, ids[0])
		if err != nil {
			return nil, false, err
		}
		if first.Parent() != base {
			return nil, false, nil
		}
	} else if base != tip {
		return nil, false, nil
	}
	if len(ids) > limit {
		ids = ids[:limit]
	}
	chain := make([]mythicalCommit, 0, len(ids))
	for _, id := range ids {
		commit, err := g.readCommit(ctx, id)
		if err != nil {
			return nil, false, err
		}
		chain = append(chain, commit)
	}
	return chain, true, nil
}

func (g mythicalGit) isAncestor(ctx context.Context, ancestor, descendant string) (bool, error) {
	return gitutil.IsAncestor(ctx, g.dir, ancestor, descendant, gitHubMainPullCommand)
}

// merge3 is a three-way tree merge of commits: base's tree, with both ours'
// and theirs' changes. Identical changes on both sides merge cleanly.
func (g mythicalGit) merge3(ctx context.Context, base, ours, theirs string) (string, error) {
	out, err := g.command(ctx, nil, "merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", "--merge-base="+base, ours, theirs)
	fields := strings.Split(strings.TrimRight(string(out), "\x00"), "\x00")
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 && len(fields) > 0 && mythicalSHA.MatchString(fields[0]) {
			paths := append([]string(nil), fields[1:]...)
			sort.Strings(paths)
			return "", &errMythicalConflict{Paths: dedupe(paths)}
		}
		return "", err
	}
	if len(fields) == 0 || !mythicalSHA.MatchString(fields[0]) {
		return "", errors.New("git merge-tree returned no tree")
	}
	return fields[0], nil
}

func dedupe(values []string) []string {
	out := values[:0]
	for i, value := range values {
		if i == 0 || value != values[i-1] {
			out = append(out, value)
		}
	}
	return out
}

// mythicalChangeIDFor mints the deterministic jj change id of a commit the
// stack service writes: 16 bytes of a domain-separated hash, in jj's
// reverse-hex alphabet (0 -> z ... f -> k). Including the parent commit keeps
// ids unique per position, so two different commits never share an id.
func mythicalChangeIDFor(parts ...string) string {
	sum := sha256.Sum256([]byte("smithers/mythical/change-id/v1\x00" + strings.Join(parts, "\x00")))
	out := make([]byte, 0, 32)
	for _, b := range sum[:16] {
		out = append(out, 'z'-(b>>4), 'z'-(b&0x0f))
	}
	return string(out)
}

// mythicalStackCommit is one commit the service wrote onto the stack, with
// the provenance its note and database row record.
type mythicalStackCommit struct {
	ID          string
	ChangeID    string
	Tree        string
	Title       string
	Kind        string // "bootstrap" | "fold" | "item"
	FoldedFrom  string // the main commit a fold or bootstrap change copies
	Predecessor string // the lane change id an adopted change replaces
	ItemID      string
	Issue       int64
	Drivers     []mythicalDriver // people who took over the item's run
}

// mythicalDriver is one take-over of an item's run: who drove it, which run,
// when, and how many messages they sent. The note lists them under drivers:.
type mythicalDriver struct {
	By       string `json:"by"`
	Run      string `json:"run,omitempty"`
	From     string `json:"from"`
	To       string `json:"to,omitempty"`
	Messages int    `json:"messages,omitempty"`
}

// mythicalDrivers reads the take-overs an item's checks recorded under
// "drivers"; checks without them, or unreadable ones, have none.
func mythicalDrivers(checks []byte) []mythicalDriver {
	var recorded struct {
		Drivers []mythicalDriver `json:"drivers"`
	}
	if json.Unmarshal(checks, &recorded) != nil {
		return nil
	}
	// A driver names a person; one without a name records no one.
	var named []mythicalDriver
	for _, driver := range recorded.Drivers {
		if driver.By != "" {
			named = append(named, driver)
		}
	}
	return named
}

// mythicalCommitter is the committer every service-written commit carries.
// Its timestamp is the source commit's, so writes are deterministic.
func mythicalCommitter(source string) string {
	stamp := ""
	if i := strings.LastIndex(source, "> "); i >= 0 {
		stamp = source[i+2:]
	}
	if stamp == "" {
		stamp = "0 +0000"
	}
	return "Smithers <smithers@smithers.sh> " + stamp
}

// flatFold writes one stack change whose tree is exactly m's tree, on parent.
func (g mythicalGit) flatFold(ctx context.Context, parent string, m mythicalCommit, kind string) (mythicalStackCommit, error) {
	commit := mythicalCommit{Tree: m.Tree, Author: m.Author, Committer: mythicalCommitter(m.Committer),
		ChangeID: mythicalChangeIDFor(kind, m.ID, parent), Message: m.Message}
	if parent != "" {
		commit.Parents = []string{parent}
	}
	if !strings.HasSuffix(commit.Message, "\n") {
		commit.Message += "\n"
	}
	id, err := g.writeCommit(ctx, commit)
	if err != nil {
		return mythicalStackCommit{}, err
	}
	return mythicalStackCommit{ID: id, ChangeID: commit.ChangeID, Tree: m.Tree, Title: m.Subject(), Kind: kind, FoldedFrom: m.ID}, nil
}

// snapshotBase writes the parentless change that stands for all history up
// to and including m.
func (g mythicalGit) snapshotBase(ctx context.Context, m mythicalCommit) (mythicalStackCommit, error) {
	message := "📦 history through " + m.ID[:12] + "\n\nThe repository as of " + m.ID + ", before the mythical stack began.\n"
	commit := mythicalCommit{Tree: m.Tree, Author: mythicalCommitter(m.Committer), Committer: mythicalCommitter(m.Committer),
		ChangeID: mythicalChangeIDFor("snapshot", m.ID), Message: message}
	id, err := g.writeCommit(ctx, commit)
	if err != nil {
		return mythicalStackCommit{}, err
	}
	return mythicalStackCommit{ID: id, ChangeID: commit.ChangeID, Tree: m.Tree, Title: "📦 history through " + m.ID[:12], Kind: "bootstrap", FoldedFrom: m.ID}, nil
}

// bootstrap linearizes the last depth first-parent commits of main into a
// new stack, oldest first. A longer history starts from a snapshot of the
// commit before the window; a shorter one starts from its root commit.
func (g mythicalGit) bootstrap(ctx context.Context, main string, depth int) ([]mythicalStackCommit, error) {
	chain, err := g.firstParents(ctx, main, depth+1)
	if err != nil {
		return nil, err
	}
	if len(chain) == 0 {
		return nil, errors.New("main has no commits")
	}
	// Oldest first.
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	var out []mythicalStackCommit
	parent := ""
	if len(chain) == depth+1 {
		base, err := g.snapshotBase(ctx, chain[0])
		if err != nil {
			return nil, err
		}
		out, parent, chain = append(out, base), base.ID, chain[1:]
	}
	for _, m := range chain {
		step, err := g.flatFold(ctx, parent, m, "bootstrap")
		if err != nil {
			return nil, err
		}
		out, parent = append(out, step), step.ID
	}
	return out, nil
}

// mythicalCandidate is a lane's validated chain: base is the stack commit it
// started from, head its cleaned tip.
type mythicalCandidate struct {
	ItemID  string
	Issue   int64
	Base    string
	Head    string
	Drivers []mythicalDriver
}

// candidateShape reads a candidate's chain back to where it leaves base's
// line. fork is the last commit shared with base's first-parent line;
// appended is true when the candidate only added commits after base itself.
// Empty commits (tree equal to their parent's tree) are dropped.
func (g mythicalGit) candidateShape(ctx context.Context, candidate mythicalCandidate, limit int) (fork string, commits []mythicalCommit, appended bool, err error) {
	baseLine, err := g.firstParents(ctx, candidate.Base, limit)
	if err != nil {
		return "", nil, false, err
	}
	onBase := make(map[string]bool, len(baseLine))
	for _, commit := range baseLine {
		onBase[commit.ID] = true
	}
	headLine, err := g.firstParents(ctx, candidate.Head, limit)
	if err != nil {
		return "", nil, false, err
	}
	var suffix []mythicalCommit
	for _, commit := range headLine {
		if onBase[commit.ID] {
			fork = commit.ID
			break
		}
		if len(commit.Parents) > 1 {
			return "", nil, false, errors.New("candidate history contains a merge")
		}
		suffix = append(suffix, commit)
	}
	// A candidate that rewrote the stack's root change shares no commit with
	// its base; it is valid only when both whole lines were read.
	if fork == "" && (len(suffix) == 0 || suffix[len(suffix)-1].Parent() != "" ||
		len(baseLine) == 0 || baseLine[len(baseLine)-1].Parent() != "") {
		return "", nil, false, errors.New("candidate does not share history with its base within the bound")
	}
	for i := len(suffix) - 1; i >= 0; i-- {
		commit := suffix[i]
		parentTree := ""
		if parent := commit.Parent(); parent != "" {
			parentCommit, err := g.readCommit(ctx, parent)
			if err != nil {
				return "", nil, false, err
			}
			parentTree = parentCommit.Tree
		}
		if commit.Tree == parentTree {
			continue
		}
		commits = append(commits, commit)
	}
	return fork, commits, fork == candidate.Base, nil
}

// replant writes commits as a chain on parent, one stack change each, with
// service-minted ids. When rebase is false every commit keeps its own tree
// (the chain already sits on parent's content); when true each commit is
// cherry-picked: merge3(old parent, new parent, commit).
func (g mythicalGit) replant(ctx context.Context, parent string, commits []mythicalCommit, kind string, rebase bool) ([]mythicalStackCommit, error) {
	var out []mythicalStackCommit
	for _, commit := range commits {
		tree := commit.Tree
		if rebase && commit.Parent() != parent {
			merged, err := g.merge3(ctx, commit.Parent(), parent, commit.ID)
			if err != nil {
				return nil, err
			}
			tree = merged
		}
		message := commit.Message
		if !strings.HasSuffix(message, "\n") {
			message += "\n"
		}
		written := mythicalCommit{Tree: tree, Author: commit.Author,
			Committer: mythicalCommitter(commit.Committer), ChangeID: mythicalChangeIDFor(kind, commit.ID, parent), Message: message}
		if parent != "" {
			written.Parents = []string{parent}
		}
		id, err := g.writeCommit(ctx, written)
		if err != nil {
			return nil, err
		}
		out = append(out, mythicalStackCommit{ID: id, ChangeID: written.ChangeID, Tree: tree, Title: commit.Subject(), Kind: "item", Predecessor: commit.ChangeID})
		parent = id
	}
	return out, nil
}

// adopt puts a merged candidate onto the stack at tip. A candidate based on
// tip keeps its placement: the stack is cut at the candidate's fork and the
// candidate's changes follow, so amendments and insertions land where the
// plan put them. A candidate based on an older tip is adopted only when it
// appended, by cherry-picking its changes onto tip. It returns ok false when
// neither applies or a cherry-pick conflicts; the caller then folds flat.
func (g mythicalGit) adopt(ctx context.Context, tip string, candidate mythicalCandidate, limit int) ([]mythicalStackCommit, bool, error) {
	fork, commits, appended, err := g.candidateShape(ctx, candidate, limit)
	if err != nil {
		return nil, false, err
	}
	if len(commits) == 0 {
		return nil, false, nil
	}
	var written []mythicalStackCommit
	switch {
	case candidate.Base == tip:
		written, err = g.replant(ctx, fork, commits, "adopt", false)
	case appended:
		written, err = g.replant(ctx, tip, commits, "adopt", true)
	default:
		return nil, false, nil
	}
	var conflict *errMythicalConflict
	if errors.As(err, &conflict) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	for i := range written {
		written[i].ItemID, written[i].Issue, written[i].Drivers = candidate.ItemID, candidate.Issue, candidate.Drivers
	}
	return written, true, nil
}

// rebaseCandidate moves an appended candidate onto a newer tip without
// touching the stack: the result is a new candidate that must be verified.
// A candidate that amended or inserted cannot be rebased here; its lane
// re-runs instead (errMythicalRewrite).
var errMythicalRewrite = errors.New("candidate rewrites existing stack changes; its lane must re-run on the new tip")

func (g mythicalGit) rebaseCandidate(ctx context.Context, tip string, candidate mythicalCandidate, limit int) (string, error) {
	_, commits, appended, err := g.candidateShape(ctx, candidate, limit)
	if err != nil {
		return "", err
	}
	if !appended {
		return "", errMythicalRewrite
	}
	if len(commits) == 0 {
		return tip, nil
	}
	written, err := g.replant(ctx, tip, commits, "rebase", true)
	if err != nil {
		return "", err
	}
	return written[len(written)-1].ID, nil
}

// mythicalNote is the Librarian note (format version 2) for one stack change.
func mythicalNote(commit mythicalStackCommit) string {
	var note strings.Builder
	note.WriteString("---\nversion: 2\nactor: smithers\n")
	note.WriteString("changeId: " + commit.ChangeID + "\n")
	note.WriteString("kind: " + commit.Kind + "\n")
	if commit.ItemID != "" {
		note.WriteString("item: " + commit.ItemID + "\n")
	}
	if commit.Issue > 0 {
		note.WriteString("issue: " + strconv.FormatInt(commit.Issue, 10) + "\n")
	}
	if commit.Predecessor != "" {
		note.WriteString("predecessor: " + commit.Predecessor + "\n")
	}
	if commit.FoldedFrom != "" {
		note.WriteString("folded: " + commit.FoldedFrom + "\n")
	}
	if len(commit.Drivers) > 0 {
		note.WriteString("drivers:\n")
		for _, driver := range commit.Drivers {
			note.WriteString("  - by: " + strconv.Quote(driver.By) + "\n")
			if driver.Run != "" {
				note.WriteString("    run: " + strconv.Quote(driver.Run) + "\n")
			}
			note.WriteString("    from: " + strconv.Quote(driver.From) + "\n")
			if driver.To != "" {
				note.WriteString("    to: " + strconv.Quote(driver.To) + "\n")
			}
			if driver.Messages > 0 {
				note.WriteString("    messages: " + strconv.Itoa(driver.Messages) + "\n")
			}
		}
	}
	note.WriteString("---\n\n")
	if commit.FoldedFrom != "" {
		note.WriteString("## Folded\n\n- " + commit.FoldedFrom + " " + commit.Title + "\n")
	}
	if commit.Issue > 0 {
		note.WriteString("\n## Evidence\n\n- issue #" + strconv.FormatInt(commit.Issue, 10) + "\n")
	}
	return note.String()
}

// writeNotes stores a notes tree (one blob per commit id) and a parentless,
// deterministic notes commit over it.
func (g mythicalGit) writeNotes(ctx context.Context, notes map[string]string, stamp string) (string, error) {
	ids := make([]string, 0, len(notes))
	for id := range notes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var tree strings.Builder
	for _, id := range ids {
		blob, err := g.command(ctx, []byte(notes[id]), "hash-object", "-t", "blob", "-w", "--stdin")
		if err != nil {
			return "", err
		}
		tree.WriteString("100644 blob " + strings.TrimSpace(string(blob)) + "\t" + id + "\n")
	}
	treeID, err := g.command(ctx, []byte(tree.String()), "mktree")
	if err != nil {
		return "", err
	}
	identity := "Smithers <smithers@smithers.sh> " + stamp
	return g.writeCommit(ctx, mythicalCommit{Tree: strings.TrimSpace(string(treeID)), Author: identity, Committer: identity,
		Message: "Mythical history notes\n"})
}

// changedPaths lists every path whose content differs between two commits,
// with renames split into both sides so a moved file names its origin;
// empty, never nil, when none does.
func (g mythicalGit) changedPaths(ctx context.Context, base, head string) ([]string, error) {
	out, err := g.command(ctx, nil, "diff-tree", "-r", "-z", "--no-renames", "--name-only", base, head)
	if err != nil {
		return nil, err
	}
	paths := []string{}
	for _, path := range strings.Split(string(out), "\x00") {
		if path != "" {
			paths = append(paths, path)
		}
	}
	return paths, nil
}

// protectedPaths reads the protected-path list on commit (protectedPathsAt).
func (g mythicalGit) protectedPaths(ctx context.Context, commit string) ([]string, error) {
	listed, err := g.command(ctx, nil, "ls-tree", "-r", "-z", commit)
	if err != nil {
		return nil, err
	}
	tree := mythicalRevisionTree{g: g, commit: commit, blobs: map[string]bool{}}
	for _, entry := range strings.Split(string(listed), "\x00") {
		// "<mode> <type> <object>\t<path>"; only regular files are read.
		meta, file, ok := strings.Cut(entry, "\t")
		if ok && strings.Contains(meta, " blob ") && !strings.HasPrefix(meta, "120000 ") {
			tree.blobs[file] = true
		}
	}
	return protectedPathsAt(ctx, tree)
}

// mythicalRevisionTree reads one commit of the scratch repository.
type mythicalRevisionTree struct {
	g      mythicalGit
	commit string
	blobs  map[string]bool
}

func (t mythicalRevisionTree) read(ctx context.Context, file string) ([]byte, bool, error) {
	if !t.blobs[file] {
		return nil, false, nil
	}
	content, err := t.g.command(ctx, nil, "cat-file", "blob", t.commit+":"+file)
	return content, err == nil, err
}

func (t mythicalRevisionTree) files(_ context.Context, dir string) ([]string, error) {
	var files []string
	for file := range t.blobs {
		if strings.HasPrefix(file, dir+"/") {
			files = append(files, file)
		}
	}
	sort.Strings(files)
	return files, nil
}
