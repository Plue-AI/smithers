// Package githubfake provides the GitHub HTTP boundary for install integration
// tests. Authentication uses the fixture App's real RSA signature; every write
// attempt receives a permanent receipt without recording credentials.
package githubfake

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Repository struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
	Private  bool   `json:"private"`
	// DefaultBranch is GitHub's default branch; empty is main.
	DefaultBranch string `json:"default_branch,omitempty"`
	// Issues are the repository's open issue numbers. Pull requests number
	// after them: GitHub numbers both in one sequence.
	Issues []int64 `json:"-"`
}

type Installation struct {
	ID           int64             `json:"id"`
	Account      Account           `json:"account"`
	Permissions  map[string]string `json:"permissions"`
	Repositories []Repository      `json:"-"`
}

type Account struct {
	Login string `json:"login"`
	Type  string `json:"type,omitempty"`
}

type Config struct {
	// OwnerStatus injects a GitHub outage at the public account lookup boundary.
	OwnerStatus                                          int
	AppID                                                int64
	Slug, OwnerLogin, OwnerKind                          string
	PrivateKeyPEM, ClientID, ClientSecret, WebhookSecret string
	ConversionCode, OAuthCode                            string
	GitRoot                                              string
	Installations                                        []Installation
}

type Write struct {
	Sequence uint64          `json:"sequence"`
	Method   string          `json:"method"`
	Path     string          `json:"path"`
	Body     json.RawMessage `json:"body,omitempty"`
	Status   int             `json:"status"`
	// Permissions are those of the installation token that made the write.
	Permissions map[string]string `json:"permissions,omitempty"`
}

type Server struct {
	*httptest.Server
	URL       string
	mu        sync.Mutex
	config    Config
	key       *rsa.PublicKey
	converted bool
	// hookless is set when the posted manifest carried no hook: GitHub's
	// conversion then returns no webhook secret.
	hookless bool
	// permissions are the posted manifest's default_permissions, when it
	// named any: GitHub refuses a user token what the App was not granted.
	permissions map[string]string
	oauthUsed   bool
	callbacks   []string
	codes       map[string]string
	// signIns are the one-time OAuth codes that sign in a collaborator
	// (SignInAs) rather than the owner, by code.
	signIns map[string]int64
	writes  []Write
	tokens  map[string]int64
	pulls   map[string]Pull
	// grants are each installation token's permissions: those requested
	// when it was minted, or the installation's when none were.
	grants map[string]map[string]string
	// lost counts the writes to a path that still take effect but answer
	// 502: a response lost after GitHub took the write.
	lost map[string]int
	// failures counts the writes to a path that still answer 502 without
	// taking effect; unread counts the reads that still answer 502.
	failures map[string]int
	unread   map[string]int
	// hooks run once, before GitHub answers the next request for a method
	// and path.
	hooks map[string]func()
	// labels are each issue's or pull request's labels, by repo/number.
	labels map[string][]string
	// opened are the issues people opened (OpenIssue), with each issue's
	// or pull request's timeline events and comments, by repo/number.
	opened                         map[string]*issue
	events                         map[string][]IssueEvent
	comments                       map[string][]IssueComment
	eventIDs, commentIDs, issueIDs int64
	// main holds the squash commits GitHub's main contains; held are merged
	// commits main has not reached yet (HoldMain). In a repository the Git
	// fixture hosts, heldTip is the newest held squash commit: the next one
	// is made on top of it, and ReleaseMain moves main there.
	main     map[string]bool
	held     []string
	heldTip  map[string]string
	holdMain bool
	refusals map[string]Refusal
	// delayed are the pull requests whose next merge times out; pending are
	// the merges GitHub accepted and has yet to complete.
	delayed  map[string]bool
	pending  []pendingMerge
	checks   map[string][]CheckRun
	required []string
	// protected is whether main has classic branch protection; GitHub
	// answers 404 for a branch without it.
	protected bool
	// accounts are GitHub accounts beyond the owner (id 7), by id; access
	// is each login's repository permission. The owner is admin unless
	// SetCollaborator says otherwise; any other login is not a user.
	accounts map[int64]string
	access   map[string]string
	// reviewRule is how many approving reviews main's protection requires
	// (0: none); reviews are each PR's latest review state per reviewer.
	reviewRule int
	reviews    map[string]map[string]string
	// pullReviews are the reviews people submitted (people.go), by
	// repo/number; down makes GitHub answer 502 to everything but the
	// fake's controls, as an outage would.
	pullReviews map[string][]PullReview
	reviewIDs   int64
	down        bool
}

// FailNextWrites makes the next n writes to path answer 502 and apply
// nothing, as GitHub refusing during an outage would.
func (s *Server) FailNextWrites(path string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures[path] = n
}

// FailNextReads makes the next n reads (GET) of path answer 502, as GitHub
// during an outage would.
func (s *Server) FailNextReads(path string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unread[path] = n
}

// LoseNextResponses makes the next n writes to path (a push's
// git-receive-pack included) take effect and then answer 502, as a
// connection lost after GitHub accepted the write would.
func (s *Server) LoseNextResponses(path string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lost[path] = n
}

// OnNextRequest runs fn once, before GitHub answers the next request for
// method and path: a person acting on GitHub or Smithers while it reads.
// fn runs outside the fake's lock and may call its controls.
func (s *Server) OnNextRequest(method, path string, fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks[method+" "+path] = fn
}

// SetInstallationPermission grants every installation the App permission
// name at level (read or write), or revokes it when level is empty. Tokens
// minted afterwards may not request more.
func (s *Server) SetInstallationPermission(name, level string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.config.Installations {
		granted := map[string]string{}
		for key, value := range s.config.Installations[i].Permissions {
			granted[key] = value
		}
		if level == "" {
			delete(granted, name)
		} else {
			granted[name] = level
		}
		s.config.Installations[i].Permissions = granted
	}
}

// Refusal is GitHub's answer to a merge it will not make.
type Refusal struct {
	Status  int
	Message string
}

// CheckRun is one check GitHub reports on a commit.
type CheckRun struct {
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	Conclusion *string `json:"conclusion"`
}

// HoldMain keeps later squash merges off main until ReleaseMain: GitHub
// reports the PR merged while main does not contain its commit yet.
func (s *Server) HoldMain() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.holdMain = true
}

// ReleaseMain lets main contain every held merge.
func (s *Server) ReleaseMain() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.holdMain = false
	for _, commit := range s.held {
		s.main[commit] = true
	}
	s.held = nil
	for repo, tip := range s.heldTip {
		if dir, hosted := s.gitDir(repo); hosted {
			if _, err := s.git(dir, "update-ref", "refs/heads/main", tip); err != nil {
				panic(fmt.Sprintf("githubfake: release held merges of %s: %v", repo, err))
			}
		}
	}
	s.heldTip = make(map[string]string)
}

// RefuseNextMerge makes the next merge of repo#number answer refusal, as
// GitHub refuses a merge its branch protection does not allow.
func (s *Server) RefuseNextMerge(repo string, number int64, refusal Refusal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refusals[repo+"/"+strconv.FormatInt(number, 10)] = refusal
}

// UpdatePull changes a pull request outside the App, as a person or GitHub
// itself would: a push, a draft, a close or a recomputed mergeability.
func (s *Server) UpdatePull(repo string, number int64, change func(*Pull)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := repo + "/" + strconv.FormatInt(number, 10)
	p := s.pulls[key]
	change(&p)
	s.pulls[key] = p
}

// SetCheck records the latest run of the named check on a commit.
func (s *Server) SetCheck(repo, sha, name, status, conclusion string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run := CheckRun{Name: name, Status: status}
	if conclusion != "" {
		run.Conclusion = &conclusion
	}
	key := repo + "@" + sha
	runs := s.checks[key][:0:0]
	for _, existing := range s.checks[key] {
		if existing.Name != name {
			runs = append(runs, existing)
		}
	}
	s.checks[key] = append(runs, run)
}

// RequireCheck makes main's branch protection require the named check. Main
// has no classic protection until RequireCheck or RequireReviews.
func (s *Server) RequireCheck(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.protected = true
	s.required = append(s.required, name)
}

// SetCollaborator makes GitHub account id the user login with permission
// (admin, maintain, write, triage, read or none) on every repository: a new
// collaborator, or the owner (id 7) promoted or demoted.
func (s *Server) SetCollaborator(id int64, login, permission string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts[id] = login
	s.access[login] = permission
}

// SignInAs adds a one-time OAuth code that signs in GitHub account id, a
// collaborator SetCollaborator made, through the App's OAuth client.
func (s *Server) SignInAs(code string, id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.codes[code] = ""
	s.signIns[code] = id
}

// RequireReviews makes main's branch protection require count approving
// reviews; 0 requires none.
func (s *Server) RequireReviews(count int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.protected = true
	s.reviewRule = count
}

// Review records login's latest review of repo#number: APPROVED,
// CHANGES_REQUESTED, DISMISSED or COMMENTED.
func (s *Server) Review(repo string, number int64, login, state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := repo + "/" + strconv.FormatInt(number, 10)
	if s.reviews[key] == nil {
		s.reviews[key] = map[string]string{}
	}
	s.reviews[key][login] = state
}

// reviewDecision is GitHub's reviewDecision for a PR: nil while main
// requires no review, CHANGES_REQUESTED while any reviewer's latest review
// requests changes, APPROVED once enough latest reviews approve.
func (s *Server) reviewDecision(p Pull) any {
	if s.reviewRule == 0 {
		return nil
	}
	approvals := 0
	for _, state := range s.reviews[p.Repository+"/"+strconv.FormatInt(p.Number, 10)] {
		switch state {
		case "CHANGES_REQUESTED":
			return "CHANGES_REQUESTED"
		case "APPROVED":
			approvals++
		}
	}
	if approvals >= s.reviewRule {
		return "APPROVED"
	}
	return "REVIEW_REQUIRED"
}

// view is the PR as GitHub answers it: an open PR main's protection does
// not yet allow (a required check, the review rule) is blocked, as GitHub
// computes it.
func (s *Server) view(p Pull) Pull {
	p = p.view()
	if p.MergeableState == "clean" && s.protectionRefusal(p.Repository, p) != "" {
		p.MergeableState = "blocked"
	}
	return p
}

// merge squash-merges an open pull request as GitHub does: into its base,
// whatever it is, main containing the commit unless HoldMain holds it.
// Into main of a repository the Git fixture hosts, the squash commit is a
// real one, written to the bare repository: the pull request's changes on
// main's tree, with title and message as the merge request named them
// (GitHub's default title when empty). It answers false and merges
// nothing when the changes do not apply to main, as GitHub refuses a
// conflicted pull request.
func (s *Server) merge(key string, p Pull, title, message string) (Pull, bool) {
	digest := sha256.Sum256([]byte("squash/" + key + "/" + p.Head.SHA))
	commit := fmt.Sprintf("%x", digest)[:40]
	dir, hosted := s.gitDir(p.Repository)
	if hosted && p.Base.Ref == "main" {
		if strings.TrimSpace(title) == "" {
			title = fmt.Sprintf("%s (#%d)", p.Title, p.Number)
		}
		var err error
		if commit, err = s.squash(dir, p.Repository, p.Head.SHA, title, message); err != nil {
			return p, false
		}
	}
	now := time.Now().UTC()
	p.Merged = true
	p.MergedAt = &now
	p.State = "closed"
	p.MergeCommitSHA = commit
	s.pulls[key] = p
	switch {
	case p.Base.Ref != "main":
	case s.holdMain:
		s.held = append(s.held, p.MergeCommitSHA)
	default:
		s.main[p.MergeCommitSHA] = true
	}
	return p, true
}

// gitDir is repo's bare repository in the Git fixture; hosted is false
// without one, where merge commits stay synthetic.
func (s *Server) gitDir(repo string) (string, bool) {
	if s.config.GitRoot == "" {
		return "", false
	}
	dir := filepath.Join(s.config.GitRoot, filepath.FromSlash(repo)+".git")
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return "", false
	}
	return dir, true
}

// git runs the fixture's OS Git on a bare repository, with no user or
// system configuration and GitHub's identity on every commit it makes.
func (s *Server) git(dir string, args ...string) (string, error) {
	cmd := exec.Command("/usr/bin/git", append([]string{"--git-dir", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_AUTHOR_NAME=GitHub", "GIT_AUTHOR_EMAIL=noreply@github.com", "GIT_COMMITTER_NAME=GitHub", "GIT_COMMITTER_EMAIL=noreply@github.com")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}

// squash writes head's changes onto main as one commit and moves main to
// it, or, while HoldMain holds main, onto the newest held merge without
// moving main. head's tree is taken whole when main is its ancestor;
// otherwise Git merges the two, and a conflict is an error.
func (s *Server) squash(dir, repo, head, title, message string) (string, error) {
	parent, err := s.git(dir, "rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}")
	if err != nil {
		return "", err
	}
	if tip := s.heldTip[repo]; s.holdMain && tip != "" {
		parent = tip
	}
	if _, err = s.git(dir, "rev-parse", "--verify", "--quiet", head+"^{commit}"); err != nil {
		return "", err
	}
	tree, err := s.git(dir, "rev-parse", head+"^{tree}")
	if err != nil {
		return "", err
	}
	if _, ancestor := s.git(dir, "merge-base", "--is-ancestor", parent, head); ancestor != nil {
		merged, err := s.git(dir, "merge-tree", "--write-tree", parent, head)
		if err != nil {
			return "", err
		}
		tree = strings.Fields(merged)[0]
	}
	args := []string{"commit-tree", tree, "-p", parent, "-m", title}
	if strings.TrimSpace(message) != "" {
		args = append(args, "-m", message)
	}
	commit, err := s.git(dir, args...)
	if err != nil {
		return "", err
	}
	if s.holdMain {
		s.heldTip[repo] = commit
		return commit, nil
	}
	if _, err = s.git(dir, "update-ref", "refs/heads/main", commit, parent); err != nil {
		return "", err
	}
	return commit, nil
}

// compareGit answers GitHub's compare of main with head from the bare
// repository: how far head is ahead of main and behind it.
func (s *Server) compareGit(dir, head string) (int, any) {
	if _, err := s.git(dir, "rev-parse", "--verify", "--quiet", head+"^{commit}"); err != nil {
		return failure(404, "No common ancestor between main and "+head)
	}
	count := func(spec string) (int, error) {
		out, err := s.git(dir, "rev-list", "--count", spec)
		if err != nil {
			return 0, err
		}
		return strconv.Atoi(out)
	}
	ahead, err := count("refs/heads/main.." + head)
	if err != nil {
		return failure(404, "No common ancestor between main and "+head)
	}
	behind, err := count(head + "..refs/heads/main")
	if err != nil {
		return failure(404, "No common ancestor between main and "+head)
	}
	status := "diverged"
	switch {
	case ahead == 0 && behind == 0:
		status = "identical"
	case ahead == 0:
		status = "behind"
	case behind == 0:
		status = "ahead"
	}
	return 200, map[string]any{"status": status, "ahead_by": ahead, "behind_by": behind}
}

// pendingMerge is a merge request GitHub accepted for a pull request at the
// head sha it named, its effect not yet applied.
type pendingMerge struct{ key, sha, title, message string }

// DelayNextMerge makes the next merge of repo#number GitHub accepts answer
// 502 and take no effect until CompleteDelayedMerges: a request that times
// out while GitHub is still completing it.
func (s *Server) DelayNextMerge(repo string, number int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.delayed[repo+"/"+strconv.FormatInt(number, 10)] = true
}

// CompleteDelayedMerges applies each accepted merge as GitHub would when it
// takes effect: only while its pull request is open at the sha the request
// named, which is checked again then; otherwise it fails and merges nothing.
func (s *Server) CompleteDelayedMerges() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, pending := range s.pending {
		if p := s.current(pending.key); p.State == "open" && !p.Merged && p.Head.SHA == pending.sha {
			s.merge(pending.key, p, pending.title, pending.message)
		}
	}
	s.pending = nil
}

// MergeAsPerson merges repo#number at its head outside the App, as a person
// on github.com would; it is not an App write.
func (s *Server) MergeAsPerson(repo string, number int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := repo + "/" + strconv.FormatInt(number, 10)
	if p := s.current(key); p.State == "open" {
		s.merge(key, p, "", "")
	}
}

// protectionRefusal is GitHub's refusal of a merge main's protection does
// not allow when it is asked: a required check missing or not green on the
// head, then the review rule; empty when protection allows it.
func (s *Server) protectionRefusal(repo string, p Pull) string {
	for _, name := range s.required {
		var run *CheckRun
		for _, candidate := range s.checks[repo+"@"+p.Head.SHA] {
			if candidate.Name == name {
				run = &candidate
			}
		}
		switch {
		case run == nil || run.Status != "completed" || run.Conclusion == nil:
			return fmt.Sprintf("Required status check %q is expected.", name)
		case *run.Conclusion != "success" && *run.Conclusion != "neutral" && *run.Conclusion != "skipped":
			return fmt.Sprintf("Required status check %q is failing.", name)
		}
	}
	if decision := s.reviewDecision(p); decision != nil && decision != "APPROVED" {
		if s.reviewRule == 1 {
			return "At least 1 approving review is required by reviewers with write access."
		}
		return fmt.Sprintf("At least %d approving reviews are required by reviewers with write access.", s.reviewRule)
	}
	return ""
}

// Handler creates the same fake without opening an httptest listener.
func Handler(config Config) (*Server, error) {
	block, _ := pem.Decode([]byte(config.PrivateKeyPEM))
	if block == nil {
		return nil, fmt.Errorf("GitHub fake requires an RSA private key")
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		parsed, parseErr := x509.ParsePKCS8PrivateKey(block.Bytes)
		if parseErr != nil {
			return nil, fmt.Errorf("GitHub fake requires an RSA private key")
		}
		var ok bool
		key, ok = parsed.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("GitHub fake requires an RSA private key")
		}
	}
	if config.AppID <= 0 {
		return nil, fmt.Errorf("GitHub fake requires a positive App id")
	}
	installations := make([]Installation, len(config.Installations))
	for i, installation := range config.Installations {
		installations[i] = installation
		if installations[i].Account.Login == "" {
			installations[i].Account.Login = config.OwnerLogin
		}
		installations[i].Permissions = permissions()
		installations[i].Account.Type = "User"
		if config.OwnerKind == "org" {
			installations[i].Account.Type = "Organization"
		}
		installations[i].Repositories = append([]Repository(nil), installation.Repositories...)
	}
	config.Installations = installations
	s := &Server{config: config, key: &key.PublicKey, tokens: make(map[string]int64), pulls: make(map[string]Pull),
		grants: make(map[string]map[string]string), lost: make(map[string]int), failures: make(map[string]int), unread: make(map[string]int), hooks: make(map[string]func()),
		labels: make(map[string][]string), main: make(map[string]bool), heldTip: make(map[string]string), refusals: make(map[string]Refusal), delayed: make(map[string]bool), checks: make(map[string][]CheckRun),
		accounts: make(map[int64]string), access: make(map[string]string), reviews: make(map[string]map[string]string), pullReviews: make(map[string][]PullReview),
		opened: make(map[string]*issue), events: make(map[string][]IssueEvent), comments: make(map[string][]IssueComment), eventIDs: 1000}
	s.codes = make(map[string]string)
	s.signIns = make(map[string]int64)
	if config.OAuthCode != "" {
		s.codes[config.OAuthCode] = ""
	}
	return s, nil
}

func New(config Config) (*Server, error) {
	s, err := Handler(config)
	if err != nil {
		return nil, err
	}
	s.Server = httptest.NewServer(s.Handler())
	s.URL = s.Server.URL
	return s, nil
}

func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serveHTTP) }

func (s *Server) Writes() []Write {
	s.mu.Lock()
	defer s.mu.Unlock()
	writes := append([]Write(nil), s.writes...)
	for i := range writes {
		writes[i].Body = append(json.RawMessage(nil), writes[i].Body...)
	}
	return writes
}

func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	hook := s.hooks[r.Method+" "+r.URL.Path]
	delete(s.hooks, r.Method+" "+r.URL.Path)
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
	if strings.Contains(r.URL.Path, ".git/") {
		s.serveGit(w, r)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.web(w, r) {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var status int
	var response any
	write := r.Method != http.MethodGet && r.Method != http.MethodHead
	switch {
	case err != nil:
		status, response = failure(http.StatusBadRequest, "request body unreadable")
	case write && s.failures[r.URL.Path] > 0:
		s.failures[r.URL.Path]--
		status, response = failure(http.StatusBadGateway, "Bad Gateway")
	case r.Method == http.MethodGet && s.unread[r.URL.Path] > 0:
		s.unread[r.URL.Path]--
		status, response = failure(http.StatusBadGateway, "Bad Gateway")
	default:
		status, response = s.respond(r, body)
		if write && s.lost[r.URL.Path] > 0 {
			s.lost[r.URL.Path]--
			status, response = failure(http.StatusBadGateway, "Bad Gateway")
		}
	}
	if write {
		if r.URL.Path == "/login/oauth/access_token" || strings.HasSuffix(r.URL.Path, "/conversions") {
			body = nil
		} // OAuth form contains credentials.
		s.writes = append(s.writes, Write{Sequence: uint64(len(s.writes) + 1), Method: r.Method, Path: r.URL.Path, Body: append(json.RawMessage(nil), body...), Status: status,
			Permissions: s.grants[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]})
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}

func (s *Server) respond(r *http.Request, body []byte) (int, any) {
	path := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if r.Method == http.MethodPost && len(path) == 3 && path[0] == "app-manifests" && path[2] == "conversions" {
		if path[1] != s.config.ConversionCode || s.converted {
			return failure(http.StatusNotFound, "manifest code not found")
		}
		s.converted = true
		app := s.app()
		app["pem"], app["client_id"], app["client_secret"], app["webhook_secret"] = s.config.PrivateKeyPEM, s.config.ClientID, s.config.ClientSecret, s.config.WebhookSecret
		if s.hookless {
			app["webhook_secret"] = nil
		}
		return http.StatusCreated, app
	}
	if r.Method == http.MethodGet && r.URL.Path == "/users/"+s.config.OwnerLogin {
		if s.config.OwnerStatus >= 400 {
			return failure(s.config.OwnerStatus, "GitHub account lookup unavailable")
		}
		kind := "User"
		if s.config.OwnerKind == "org" {
			kind = "Organization"
		}
		return http.StatusOK, map[string]string{"login": s.config.OwnerLogin, "type": kind}
	}
	if r.Method == http.MethodGet && len(path) == 2 && path[0] == "users" {
		for id, login := range s.accounts {
			if strings.EqualFold(login, path[1]) {
				return http.StatusOK, map[string]any{"id": id, "login": login, "type": "User"}
			}
		}
		return failure(http.StatusNotFound, "GitHub owner not found")
	}
	// Setup uses the App's own OAuth client; no local session is manufactured.
	if r.Method == http.MethodPost && r.URL.Path == "/login/oauth/access_token" {
		form, err := url.ParseQuery(string(body))
		callback, exists := s.codes[form.Get("code")]
		if err != nil || !s.converted || !exists || (callback != "" && callback != form.Get("redirect_uri")) || form.Get("client_id") != s.config.ClientID || form.Get("client_secret") != s.config.ClientSecret || form.Get("redirect_uri") == "" {
			return failure(401, "OAuth exchange refused")
		}
		delete(s.codes, form.Get("code"))
		if id, ok := s.signIns[form.Get("code")]; ok {
			delete(s.signIns, form.Get("code"))
			return 200, map[string]string{"access_token": fmt.Sprintf("ghu_githubfake_user_%d", id), "token_type": "bearer"}
		}
		s.oauthUsed = true
		return 200, map[string]string{"access_token": "ghu_githubfake_owner", "token_type": "bearer"}
	}
	if id, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ghu_githubfake_user_"); ok {
		accountID, _ := strconv.ParseInt(id, 10, 64)
		login := s.accounts[accountID]
		switch {
		case login == "":
			return failure(http.StatusUnauthorized, "Bad credentials")
		case r.URL.Path == "/user":
			return 200, map[string]any{"id": accountID, "login": login, "name": login}
		case r.URL.Path == "/user/emails":
			return 200, []any{map[string]any{"email": strings.ToLower(login) + "@example.test", "primary": true, "verified": true}}
		}
		return failure(404, "endpoint not found")
	}
	if r.Header.Get("Authorization") == "Bearer ghu_githubfake_owner" && s.oauthUsed {
		switch r.URL.Path {
		case "/user":
			return 200, map[string]any{"id": 7, "login": s.config.OwnerLogin, "name": "Rehearsal owner"}
		case "/user/emails":
			if s.permissions != nil && s.permissions["emails"] == "" {
				return failure(http.StatusForbidden, "Resource not accessible by integration")
			}
			return 200, []any{map[string]any{"email": "owner@example.test", "primary": true, "verified": true}}
		case "/user/repos":
			repos := []any{}
			for _, installation := range s.config.Installations {
				for _, repo := range installation.Repositories {
					repos = append(repos, s.repository(repo))
				}
			}
			return 200, repos
		}
		if len(path) == 3 && path[0] == "repos" {
			for _, installation := range s.config.Installations {
				for _, repo := range installation.Repositories {
					if repo.FullName == path[1]+"/"+path[2] {
						return 200, s.repository(repo)
					}
				}
			}
		}
		return failure(404, "endpoint not found")
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		return failure(http.StatusUnauthorized, "Bearer authorization required")
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if r.Method == http.MethodGet && r.URL.Path == "/installation/repositories" {
		installationID, ok := s.tokens[token]
		if !ok {
			return failure(http.StatusUnauthorized, "installation token required")
		}
		installation, _ := s.installation(installationID)
		// GitHub lists full repository objects, owner and name included.
		repos := []any{}
		start, end := pageBounds(r, len(installation.Repositories))
		for _, repo := range installation.Repositories[start:end] {
			repos = append(repos, s.repository(repo))
		}
		return http.StatusOK, map[string]any{"total_count": len(installation.Repositories), "repositories": repos}
	}
	if installationID, ok := s.tokens[token]; ok {
		if r.Method == http.MethodGet && r.URL.Path == "/user/7" {
			return 200, map[string]any{"id": 7, "login": s.login(7), "type": "User"}
		}
		if r.Method == http.MethodGet && len(path) == 2 && path[0] == "user" {
			id, _ := strconv.ParseInt(path[1], 10, 64)
			if login := s.login(id); login != "" {
				return 200, map[string]any{"id": id, "login": login, "type": "User"}
			}
			return failure(404, "Not Found")
		}
		if r.URL.Path == "/graphql" {
			if isIssueTextQuery(body) {
				return s.issueText(installationID, body)
			}
			if strings.Contains(string(body), "reviewDecision") {
				return s.pullReviewDecision(installationID, body)
			}
			return s.pullMutation(installationID, body)
		}
		if len(path) >= 3 && path[0] == "repos" {
			installation, _ := s.installation(installationID)
			fullName := path[1] + "/" + path[2]
			allowed := false
			for _, repo := range installation.Repositories {
				allowed = allowed || repo.FullName == fullName
			}
			if !allowed {
				return failure(404, "repository outside installation")
			}
			if len(path) == 3 && r.Method == http.MethodGet {
				for _, repo := range installation.Repositories {
					if repo.FullName == fullName {
						return 200, s.repository(repo)
					}
				}
			}
			if len(path) == 6 && path[3] == "collaborators" && path[5] == "permission" && r.Method == http.MethodGet {
				if permission, ok := s.permission(path[4]); ok {
					return 200, collaborator(path[4], permission)
				}
			}
			return s.pullRequest(r, fullName, path[3:], body)
		}
		return failure(404, "endpoint not found")
	}
	if !s.validJWT(token) {
		return failure(http.StatusUnauthorized, "App JWT required")
	}
	if r.Method == http.MethodGet && r.URL.Path == "/app" {
		return http.StatusOK, s.app()
	}
	if r.Method == http.MethodGet && r.URL.Path == "/app/installations" {
		start, end := pageBounds(r, len(s.config.Installations))
		return http.StatusOK, append([]Installation{}, s.config.Installations[start:end]...)
	}
	if r.Method == http.MethodPost && len(path) == 4 && path[0] == "app" && path[1] == "installations" && path[3] == "access_tokens" {
		id, _ := strconv.ParseInt(path[2], 10, 64)
		if _, ok := s.installation(id); !ok {
			return failure(http.StatusNotFound, "installation not found")
		}
		installation, _ := s.installation(id)
		var scope struct {
			Permissions map[string]string `json:"permissions"`
		}
		_ = json.Unmarshal(body, &scope)
		granted := installation.Permissions
		if len(scope.Permissions) > 0 {
			for name, level := range scope.Permissions {
				if !permits(installation.Permissions, name, level) {
					return failure(http.StatusUnprocessableEntity, "The permissions requested are not granted to this installation.")
				}
			}
			granted = scope.Permissions
		}
		token := fmt.Sprintf("ghs_githubfake_%d_%d", id, len(s.writes)+1)
		s.tokens[token] = id
		s.grants[token] = granted
		return http.StatusCreated, map[string]any{"token": token, "expires_at": time.Now().UTC().Add(time.Hour), "permissions": granted}
	}
	if r.Method == http.MethodGet && len(path) == 4 && path[0] == "repos" && path[3] == "installation" {
		for _, installation := range s.config.Installations {
			for _, repo := range installation.Repositories {
				if strings.EqualFold(repo.FullName, path[1]+"/"+path[2]) {
					return http.StatusOK, installation
				}
			}
		}
	}
	return failure(http.StatusNotFound, "endpoint not found")
}

func pageBounds(r *http.Request, count int) (int, int) {
	page, err := strconv.Atoi(r.URL.Query().Get("page"))
	if err != nil || page < 1 {
		page = 1
	}
	perPage, err := strconv.Atoi(r.URL.Query().Get("per_page"))
	if err != nil || perPage < 1 || perPage > 100 {
		perPage = 30
	}
	if page > count/perPage+1 {
		return count, count
	}
	start := min((page-1)*perPage, count)
	return start, min(start+perPage, count)
}

func (s *Server) app() map[string]any {
	ownerType := "User"
	if s.config.OwnerKind == "org" {
		ownerType = "Organization"
	}
	return map[string]any{"id": s.config.AppID, "slug": s.config.Slug, "owner": map[string]any{"login": s.config.OwnerLogin, "type": ownerType}, "permissions": permissions(), "events": []string{}, "html_url": "https://github.com/apps/" + s.config.Slug}
}

// permits reports whether granted holds permission name at level: write
// covers read.
func permits(granted map[string]string, name, level string) bool {
	return granted[name] == level || granted[name] == "write" && level == "read"
}

// accessible answers GitHub's refusal of an installation token that lacks
// permission name at level, and ok when the token holds it and its
// installation still does.
func (s *Server) accessible(r *http.Request, name, level string) (int, any, bool) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	installation, _ := s.installation(s.tokens[token])
	if permits(s.grants[token], name, level) && permits(installation.Permissions, name, level) {
		return 0, nil, true
	}
	status, response := failure(http.StatusForbidden, "Resource not accessible by integration")
	return status, response, false
}

func permissions() map[string]string {
	return map[string]string{"contents": "write", "workflows": "write", "pull_requests": "write", "issues": "write", "checks": "read", "statuses": "read", "administration": "read", "metadata": "read", "members": "read"}
}

// login is the GitHub account id's login: the owner is 7.
func (s *Server) login(id int64) string {
	if login, ok := s.accounts[id]; ok {
		return login
	}
	if id == 7 {
		return s.config.OwnerLogin
	}
	return ""
}

// permission is login's repository permission: the owner is admin unless
// SetCollaborator says otherwise.
func (s *Server) permission(login string) (string, bool) {
	if permission, ok := s.access[login]; ok {
		return permission, true
	}
	return "admin", login == s.config.OwnerLogin
}

// collaborator is GitHub's collaborator permission answer: permission is the
// legacy word (admin, write, read, none) and role_name the role itself.
func collaborator(login, role string) map[string]any {
	permission := map[string]string{"maintain": "write", "triage": "read"}[role]
	if permission == "" {
		permission = role
	}
	return map[string]any{"permission": permission, "role_name": role, "user": map[string]any{"login": login,
		"permissions": map[string]bool{"admin": role == "admin", "maintain": role == "admin" || role == "maintain", "push": permission == "admin" || permission == "write", "pull": permission != "none"}}}
}

func (s *Server) installation(id int64) (Installation, bool) {
	for _, installation := range s.config.Installations {
		if installation.ID == id {
			return installation, true
		}
	}
	return Installation{}, false
}

func failure(status int, message string) (int, any) {
	return status, map[string]string{"message": message}
}

func (s *Server) validJWT(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	headerData, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(headerData, &header) != nil || header.Alg != "RS256" {
		return false
	}
	claimsData, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Iss json.RawMessage `json:"iss"`
		Iat int64           `json:"iat"`
		Exp int64           `json:"exp"`
	}
	if json.Unmarshal(claimsData, &claims) != nil {
		return false
	}
	issuer := strings.Trim(string(claims.Iss), `"`)
	now := time.Now().Unix()
	if issuer != strconv.FormatInt(s.config.AppID, 10) || claims.Iat > now+60 || claims.Exp <= now || claims.Exp-claims.Iat > 600 || claims.Exp <= claims.Iat {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	return rsa.VerifyPKCS1v15(s.key, crypto.SHA256, digest[:], signature) == nil
}

// Pull is a fixture PR receipt; all writes still pass through the App token
// boundary and permanent write log. The fake previously served no PR API.
type Pull struct {
	Repository     string     `json:"-"`
	Number         int64      `json:"number"`
	NodeID         string     `json:"node_id"`
	Title          string     `json:"title"`
	Body           string     `json:"body"`
	State          string     `json:"state"`
	Draft          bool       `json:"draft"`
	Merged         bool       `json:"merged"`
	MergedAt       *time.Time `json:"merged_at"`
	MergeCommitSHA string     `json:"merge_commit_sha"`
	HTMLURL        string     `json:"html_url"`
	// Mergeable and MergeableState are GitHub's computed mergeability. An
	// empty MergeableState answers what GitHub computes for the PR as it is;
	// UpdatePull sets one to answer it instead (unknown, dirty, blocked).
	Mergeable      *bool  `json:"mergeable"`
	MergeableState string `json:"mergeable_state"`
	Head           struct {
		Ref  string `json:"ref"`
		SHA  string `json:"sha"`
		Repo struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
	Labels []Label `json:"labels"`
}

type Label struct {
	Name string `json:"name"`
}

// view is the PR as GitHub answers it, with its computed mergeability.
func (p Pull) view() Pull {
	if p.MergeableState != "" {
		return p
	}
	switch mergeable := true; {
	case p.State != "open":
		p.MergeableState = "unknown"
	case p.Draft:
		p.Mergeable, p.MergeableState = &mergeable, "draft"
	default:
		p.Mergeable, p.MergeableState = &mergeable, "clean"
	}
	return p
}

func (s *Server) pullRequest(r *http.Request, repo string, path []string, body []byte) (int, any) {
	if r.Method == http.MethodGet && strings.Join(path, "/") == "branches/main/protection" {
		if status, response, ok := s.accessible(r, "administration", "read"); !ok {
			return status, response
		}
		if !s.protected {
			return failure(http.StatusNotFound, "Branch not protected")
		}
		protection := map[string]any{"required_status_checks": map[string]any{"contexts": append([]string{}, s.required...), "checks": []any{}}}
		if s.reviewRule > 0 {
			protection["required_pull_request_reviews"] = map[string]any{"required_approving_review_count": s.reviewRule}
		}
		return 200, protection
	}
	if r.Method == http.MethodGet && strings.Join(path, "/") == "rules/branches/main" {
		return 200, []any{}
	}
	if len(path) == 3 && path[0] == "issues" && r.Method == http.MethodPost && (path[2] == "labels" || path[2] == "comments") {
		return s.issueWrite(repo, path[1], path[2], body)
	}
	if len(path) == 4 && path[0] == "issues" && path[2] == "labels" && r.Method == http.MethodDelete {
		if status, response, ok := s.accessible(r, "issues", "write"); !ok {
			return status, response
		}
		key := repo + "/" + path[1]
		for i, label := range s.labels[key] {
			if strings.EqualFold(label, path[3]) {
				s.labels[key] = append(s.labels[key][:i], s.labels[key][i+1:]...)
				s.event(key, "unlabeled", "", true, label)
				return http.StatusOK, labelsOf(s.labels[key])
			}
		}
		return failure(http.StatusNotFound, "label not found")
	}
	if status, response, ok := s.issueRequest(r, repo, path, body); ok {
		return status, response
	}
	if r.Method == http.MethodGet && len(path) == 3 && path[0] == "commits" && path[2] == "check-runs" {
		runs := append([]CheckRun{}, s.checks[repo+"@"+path[1]]...)
		if page, _ := strconv.Atoi(r.URL.Query().Get("page")); page > 1 {
			runs = []CheckRun{}
		}
		return 200, map[string]any{"total_count": len(runs), "check_runs": runs}
	}
	if r.Method == http.MethodGet && len(path) == 3 && path[0] == "commits" && path[2] == "statuses" {
		return 200, []any{}
	}
	if r.Method == http.MethodGet && len(path) == 2 && path[0] == "compare" {
		// main contains a commit it is not behind; a held merge is ahead of it.
		base, head, ok := strings.Cut(path[1], "...")
		dir, hosted := s.gitDir(repo)
		switch {
		case !ok || base != "main":
			return failure(404, "Not Found")
		case hosted:
			return s.compareGit(dir, head)
		case s.main[head]:
			return 200, map[string]any{"status": "behind", "ahead_by": 0, "behind_by": 1}
		case slices.Contains(s.held, head):
			return 200, map[string]any{"status": "ahead", "ahead_by": 1, "behind_by": 0}
		}
		return failure(404, "No common ancestor between main and "+head)
	}
	if len(path) == 0 || path[0] != "pulls" {
		return failure(404, "endpoint not found")
	}
	if len(path) == 1 && r.Method == http.MethodPost {
		var input struct {
			Title, Head, Base, Body string
			Draft                   bool
		}
		if json.Unmarshal(body, &input) != nil || input.Head == "" || input.Base == "" {
			return failure(422, "head and base required")
		}
		for _, p := range s.pulls {
			if p.Repository == repo && p.Head.Ref == input.Head && p.State == "open" {
				return failure(422, "A pull request already exists")
			}
		}
		number := s.nextNumber(repo)
		p := Pull{Repository: repo, Number: number, NodeID: fmt.Sprintf("PR_%s_%d", repo, number), Title: input.Title, Body: input.Body, State: "open", Draft: input.Draft, HTMLURL: fmt.Sprintf("https://github.com/%s/pull/%d", repo, number)}
		p.Head.Ref = input.Head
		digest := sha256.Sum256([]byte(repo + "/" + input.Head))
		p.Head.SHA = fmt.Sprintf("%x", digest)[:40]
		if head, hosted, exists := s.branchHead(repo, input.Head); hosted {
			// GitHub opens a pull request only from an existing head branch.
			if !exists {
				return 422, map[string]any{"message": "Validation Failed", "errors": []map[string]string{{"resource": "PullRequest", "field": "head", "code": "invalid"}}}
			}
			p.Head.SHA = head
		}
		p.Head.Repo.FullName = repo
		p.Base.Ref = input.Base
		key := repo + "/" + strconv.FormatInt(number, 10)
		s.pulls[key] = p
		return 201, s.view(s.current(key))
	}
	if len(path) == 1 && r.Method == http.MethodGet {
		result := []Pull{}
		head := strings.TrimPrefix(r.URL.Query().Get("head"), strings.Split(repo, "/")[0]+":")
		for key, p := range s.pulls {
			if p.Repository == repo && (head == "" || head == p.Head.Ref) {
				result = append(result, s.view(s.current(key)))
			}
		}
		sort.Slice(result, func(i, j int) bool { return result[i].Number < result[j].Number })
		start, end := pageBounds(r, len(result))
		return 200, result[start:end]
	}
	if len(path) == 3 && path[2] == "merge" {
		key := repo + "/" + path[1]
		if _, ok := s.pulls[key]; !ok {
			return failure(404, "pull request not found")
		}
		p := s.current(key)
		if r.Method == http.MethodGet {
			if p.Merged {
				return 204, nil
			}
			return failure(404, "pull request is not merged")
		}
		if r.Method == http.MethodPut {
			if status, response, ok := s.accessible(r, "contents", "write"); !ok {
				return status, response
			}
			var input struct {
				SHA     string `json:"sha"`
				Method  string `json:"merge_method"`
				Title   string `json:"commit_title"`
				Message string `json:"commit_message"`
			}
			if json.Unmarshal(body, &input) != nil || input.Method != "squash" {
				return failure(422, "squash merge required")
			}
			if refusal, ok := s.refusals[key]; ok {
				delete(s.refusals, key)
				return failure(refusal.Status, refusal.Message)
			}
			if p.Merged {
				// GitHub refuses a merge of a merged pull request.
				return failure(405, "Pull Request is not mergeable")
			}
			if input.SHA != p.Head.SHA {
				return failure(409, "Head branch was modified")
			}
			if p.Draft || p.State != "open" {
				return failure(405, "Pull request is not mergeable")
			}
			if refusal := s.protectionRefusal(repo, p); refusal != "" {
				return failure(405, refusal)
			}
			if p.MergeableState == "dirty" {
				return failure(405, "Pull Request is not mergeable")
			}
			if s.delayed[key] {
				// The request was validated as it arrived and times out;
				// GitHub completes it later (CompleteDelayedMerges).
				delete(s.delayed, key)
				s.pending = append(s.pending, pendingMerge{key: key, sha: input.SHA, title: input.Title, message: input.Message})
				return failure(http.StatusBadGateway, "Bad Gateway")
			}
			merged, ok := s.merge(key, p, input.Title, input.Message)
			if !ok {
				return failure(405, "Pull Request is not mergeable")
			}
			return 200, map[string]any{"merged": true, "sha": merged.MergeCommitSHA, "message": "Pull Request successfully merged"}
		}
	}
	if len(path) == 2 {
		key := repo + "/" + path[1]
		if _, ok := s.pulls[key]; !ok {
			return failure(404, "pull request not found")
		}
		p := s.current(key)
		if r.Method == http.MethodGet {
			return 200, s.view(p)
		}
		if r.Method == http.MethodPatch {
			var input struct {
				Body  *string
				Title *string
				State *string
			}
			if json.Unmarshal(body, &input) != nil {
				return failure(422, "invalid pull update")
			}
			if input.Body != nil {
				p.Body = *input.Body
			}
			if input.Title != nil {
				p.Title = *input.Title
			}
			if input.State != nil {
				if *input.State != "open" && *input.State != "closed" {
					return failure(422, "invalid pull state")
				}
				p.State = *input.State
			}
			s.pulls[key] = p
			return 200, s.view(p)
		}
	}
	return failure(404, "endpoint not found")
}

// issues are a repository's issue numbers: those configured and those
// people opened (OpenIssue).
func (s *Server) issues(repo string) []int64 {
	var numbers []int64
	for _, installation := range s.config.Installations {
		for _, candidate := range installation.Repositories {
			if candidate.FullName == repo {
				numbers = append(numbers, candidate.Issues...)
			}
		}
	}
	for _, opened := range s.opened {
		if s.opened[issueKey(repo, opened.Number)] == opened {
			numbers = append(numbers, opened.Number)
		}
	}
	return numbers
}

// issueWrite labels or comments on an issue or pull request of repo.
func (s *Server) issueWrite(repo, rawNumber, kind string, body []byte) (int, any) {
	number, _ := strconv.ParseInt(rawNumber, 10, 64)
	_, pull := s.pulls[repo+"/"+strconv.FormatInt(number, 10)]
	if number <= 0 || !pull && !slices.Contains(s.issues(repo), number) {
		return failure(404, "issue not found")
	}
	key := repo + "/" + strconv.FormatInt(number, 10)
	if kind == "comments" {
		var input struct{ Body string }
		if json.Unmarshal(body, &input) != nil || input.Body == "" {
			return failure(422, "body required")
		}
		s.commentIDs++
		s.comments[key] = append(s.comments[key], IssueComment{ID: s.commentIDs, Body: input.Body, ViaApp: true, Author: s.appLogin(), CreatedAt: time.Now().UTC()})
		return 201, map[string]any{"id": s.commentIDs, "body": input.Body, "user": map[string]string{"type": "Bot"}, "performed_via_github_app": map[string]int64{"id": s.config.AppID}}
	}
	var input struct{ Labels []string }
	if json.Unmarshal(body, &input) != nil || len(input.Labels) == 0 {
		return failure(422, "labels required")
	}
	for _, label := range input.Labels {
		if !slices.Contains(s.labels[key], label) {
			s.labels[key] = append(s.labels[key], label)
			s.event(key, "labeled", "", true, label)
		}
	}
	return 200, labelsOf(s.labels[key])
}

func labelsOf(names []string) []Label {
	labels := []Label{}
	for _, name := range names {
		labels = append(labels, Label{Name: name})
	}
	return labels
}

// branchHead reads a branch of a repository the Git fixture hosts. hosted
// is false without a fixture repository, where pull heads stay synthetic.
func (s *Server) branchHead(repo, branch string) (head string, hosted, exists bool) {
	dir, hosted := s.gitDir(repo)
	if !hosted {
		return "", false, false
	}
	out, err := s.git(dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	if err != nil {
		return "", true, false
	}
	return out, true, true
}

// current is an open pull request as GitHub serves it: its head follows the
// head branch until the pull request closes.
func (s *Server) current(key string) Pull {
	p := s.pulls[key]
	p.Labels = labelsOf(s.labels[key])
	if p.State == "open" {
		if head, hosted, exists := s.branchHead(p.Repository, p.Head.Ref); hosted && exists && head != p.Head.SHA {
			p.Head.SHA = head
			s.pulls[key] = p
		}
	}
	return p
}

// pullReviewDecision answers GraphQL's repository.pullRequest.reviewDecision
// for a PR the installation can read.
func (s *Server) pullReviewDecision(installationID int64, body []byte) (int, any) {
	var input struct {
		Variables struct {
			Owner, Name string
			Number      int64
		}
	}
	if json.Unmarshal(body, &input) != nil {
		return failure(400, "invalid GraphQL request")
	}
	repo := input.Variables.Owner + "/" + input.Variables.Name
	installation, _ := s.installation(installationID)
	for _, allowed := range installation.Repositories {
		if allowed.FullName != repo {
			continue
		}
		p, ok := s.pulls[repo+"/"+strconv.FormatInt(input.Variables.Number, 10)]
		if !ok {
			break
		}
		return 200, map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"reviewDecision": s.reviewDecision(p)}}}}
	}
	return 200, map[string]any{"data": map[string]any{"repository": nil}, "errors": []map[string]string{{"message": fmt.Sprintf("Could not resolve to a PullRequest with the number of %d.", input.Variables.Number)}}}
}

func (s *Server) pullMutation(installationID int64, body []byte) (int, any) {
	var input struct {
		Query     string
		Variables struct{ ID string }
	}
	if json.Unmarshal(body, &input) != nil {
		return failure(400, "invalid GraphQL request")
	}
	mutation := ""
	if strings.Contains(input.Query, "markPullRequestReadyForReview(") {
		mutation = "markPullRequestReadyForReview"
	}
	if strings.Contains(input.Query, "convertPullRequestToDraft(") {
		mutation = "convertPullRequestToDraft"
	}
	if mutation == "" {
		return failure(400, "unsupported GraphQL mutation")
	}
	installation, _ := s.installation(installationID)
	for key, p := range s.pulls {
		if p.NodeID != input.Variables.ID {
			continue
		}
		allowed := false
		for _, repo := range installation.Repositories {
			allowed = allowed || repo.FullName == p.Repository
		}
		if !allowed {
			return failure(404, "pull request outside installation")
		}
		if p.State != "open" {
			return 200, map[string]any{"errors": []map[string]string{{"message": "Pull request is closed"}}}
		}
		p.Draft = mutation == "convertPullRequestToDraft"
		s.pulls[key] = p
		return 200, map[string]any{"data": map[string]any{mutation: map[string]any{"pullRequest": map[string]any{"id": p.NodeID, "isDraft": p.Draft}}}}
	}
	return 200, map[string]any{"errors": []map[string]string{{"message": "Pull request not found"}}}
}

// Repository metadata is shared by OAuth selection and installation verification.
func (s *Server) repository(repo Repository) map[string]any {
	owner, name, _ := strings.Cut(repo.FullName, "/")
	defaultBranch := repo.DefaultBranch
	if defaultBranch == "" {
		defaultBranch = "main"
	}
	return map[string]any{"id": repo.ID, "name": name, "full_name": repo.FullName, "private": repo.Private, "default_branch": defaultBranch, "allow_squash_merge": true, "owner": map[string]string{"login": owner}, "permissions": map[string]bool{"admin": true, "push": true, "pull": true}, "clone_url": s.URL + "/" + repo.FullName + ".git", "html_url": "https://github.com/" + repo.FullName}
}

// serveGit uses OS Git's real smart HTTP transport; the JSON fake cannot
// substitute Git objects or clone/import receipts for the source-ready step.
func (s *Server) serveGit(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	_, token, basic := r.BasicAuth()
	id, authenticated := s.tokens[token]
	if !authenticated && token == "ghu_githubfake_owner" && s.oauthUsed {
		for _, installation := range s.config.Installations {
			for _, repo := range installation.Repositories {
				if strings.HasPrefix(r.URL.Path, "/"+repo.FullName+".git/") {
					id = installation.ID
					authenticated = true
				}
			}
		}
	}
	if s.down {
		s.mu.Unlock()
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
		return
	}
	fullName, suffix, valid := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), ".git/")
	// Pushes need the App's installation token; a person's OAuth token reads.
	_, installationToken := s.tokens[token]
	push := suffix == "git-receive-pack" || suffix == "info/refs" && r.URL.Query().Get("service") == "git-receive-pack"
	allowed := false
	if basic && authenticated && valid && (suffix == "info/refs" || suffix == "git-upload-pack" || suffix == "git-receive-pack") && (!push || installationToken) {
		installation, _ := s.installation(id)
		for _, repo := range installation.Repositories {
			allowed = allowed || repo.FullName == fullName
		}
	}
	root := s.config.GitRoot
	s.mu.Unlock()
	if !allowed {
		http.Error(w, fmt.Sprintf("installation repository access required (basic=%t authenticated=%t repository=%s endpoint=%s)", basic, authenticated, fullName, suffix), 403)
		return
	}
	if root == "" {
		http.Error(w, "Git fixture unavailable", 503)
		return
	}
	// http-backend serves receive-pack only to an authenticated REMOTE_USER.
	handler := cgi.Handler{Path: "/usr/bin/git", Args: []string{"http-backend"}, Root: "/", Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "REMOTE_USER=x-access-token"}}
	receipt := httptest.NewRecorder()
	handler.ServeHTTP(receipt, r)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.mu.Lock()
		if s.lost[r.URL.Path] > 0 {
			s.lost[r.URL.Path]--
			receipt = httptest.NewRecorder()
			receipt.WriteHeader(http.StatusBadGateway)
		}
		s.writes = append(s.writes, Write{Sequence: uint64(len(s.writes) + 1), Method: r.Method, Path: r.URL.Path, Status: receipt.Code})
		s.mu.Unlock()
	}
	for key, values := range receipt.Header() {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(receipt.Code)
	_, _ = w.Write(receipt.Body.Bytes())
}
