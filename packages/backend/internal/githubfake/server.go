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
}

type Server struct {
	*httptest.Server
	URL       string
	mu        sync.Mutex
	config    Config
	key       *rsa.PublicKey
	converted bool
	oauthUsed bool
	callbacks []string
	codes     map[string]string
	writes    []Write
	tokens    map[string]int64
	pulls     map[string]Pull
	// lostPushes is how many applied pushes still answer 502: a response
	// lost after GitHub took the write.
	lostPushes int
	// failures counts the writes to a path that still answer 502 without
	// taking effect.
	failures map[string]int
	// labels are each issue's or pull request's labels, by repo/number.
	labels   map[string][]string
	comments int64
	// main holds the squash commits GitHub's main contains; held are merged
	// commits main has not reached yet (HoldMain).
	main     map[string]bool
	held     []string
	holdMain bool
	refusals map[string]Refusal
	checks   map[string][]CheckRun
	required []string
	// accounts are GitHub accounts beyond the owner (id 7), by id; access
	// is each login's repository permission. The owner is admin unless
	// SetCollaborator says otherwise; any other login is not a user.
	accounts map[int64]string
	access   map[string]string
	// reviewRule is how many approving reviews main's protection requires
	// (0: none); reviews are each PR's latest review state per reviewer.
	reviewRule int
	reviews    map[string]map[string]string
}

// FailNextWrites makes the next n writes to path answer 502 and apply
// nothing, as GitHub refusing during an outage would.
func (s *Server) FailNextWrites(path string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures[path] = n
}

// LoseNextPushResponses makes the next n pushes apply and then answer 502,
// as a connection lost after GitHub accepted the write would.
func (s *Server) LoseNextPushResponses(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lostPushes = n
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

// RequireCheck makes main's branch protection require the named check.
func (s *Server) RequireCheck(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
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

// RequireReviews makes main's branch protection require count approving
// reviews; 0 requires none.
func (s *Server) RequireReviews(count int) {
	s.mu.Lock()
	defer s.mu.Unlock()
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

// view is the PR as GitHub answers it: an open PR main's review rule does
// not yet allow is blocked, as GitHub computes it.
func (s *Server) view(p Pull) Pull {
	p = p.view()
	if p.MergeableState == "clean" && s.reviewDecision(p) != nil && s.reviewDecision(p) != "APPROVED" {
		p.MergeableState = "blocked"
	}
	return p
}

// reviewRefusal is GitHub's refusal of a merge main's review rule does not
// allow yet.
func (s *Server) reviewRefusal() string {
	if s.reviewRule == 1 {
		return "At least 1 approving review is required by reviewers with write access."
	}
	return fmt.Sprintf("At least %d approving reviews are required by reviewers with write access.", s.reviewRule)
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
		failures: make(map[string]int), labels: make(map[string][]string),
		main: make(map[string]bool), refusals: make(map[string]Refusal), checks: make(map[string][]CheckRun),
		accounts: make(map[int64]string), access: make(map[string]string), reviews: make(map[string]map[string]string)}
	s.codes = make(map[string]string)
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
	default:
		status, response = s.respond(r, body)
	}
	if write {
		if r.URL.Path == "/login/oauth/access_token" || strings.HasSuffix(r.URL.Path, "/conversions") {
			body = nil
		} // OAuth form contains credentials.
		s.writes = append(s.writes, Write{Sequence: uint64(len(s.writes) + 1), Method: r.Method, Path: r.URL.Path, Body: append(json.RawMessage(nil), body...), Status: status})
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
		s.oauthUsed = true
		return 200, map[string]string{"access_token": "ghu_githubfake_owner", "token_type": "bearer"}
	}
	if r.Header.Get("Authorization") == "Bearer ghu_githubfake_owner" && s.oauthUsed {
		switch r.URL.Path {
		case "/user":
			return 200, map[string]any{"id": 7, "login": s.config.OwnerLogin, "name": "Rehearsal owner"}
		case "/user/emails":
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
		token := fmt.Sprintf("ghs_githubfake_%d_%d", id, len(s.writes)+1)
		s.tokens[token] = id
		return http.StatusCreated, map[string]any{"token": token, "expires_at": time.Now().UTC().Add(time.Hour), "permissions": permissions()}
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
		switch {
		case !ok || base != "main":
			return failure(404, "Not Found")
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
		number := int64(1)
		for _, issue := range s.issues(repo) {
			if issue >= number {
				number = issue + 1
			}
		}
		for _, p := range s.pulls {
			if p.Repository != repo {
				continue
			}
			if p.Head.Ref == input.Head && p.State == "open" {
				return failure(422, "A pull request already exists")
			}
			if p.Number >= number {
				number = p.Number + 1
			}
		}
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
			var input struct {
				SHA    string `json:"sha"`
				Method string `json:"merge_method"`
			}
			if json.Unmarshal(body, &input) != nil || input.Method != "squash" {
				return failure(422, "squash merge required")
			}
			if refusal, ok := s.refusals[key]; ok {
				delete(s.refusals, key)
				return failure(refusal.Status, refusal.Message)
			}
			if input.SHA != p.Head.SHA {
				return failure(409, "Head branch was modified")
			}
			if p.Draft || (p.State != "open" && !p.Merged) {
				return failure(405, "Pull request is not mergeable")
			}
			if decision := s.reviewDecision(p); !p.Merged && decision != nil && decision != "APPROVED" {
				return failure(405, s.reviewRefusal())
			}
			if !p.Merged {
				now := time.Now().UTC()
				p.Merged = true
				p.MergedAt = &now
				p.State = "closed"
				digest := sha256.Sum256([]byte("squash/" + key + "/" + p.Head.SHA))
				p.MergeCommitSHA = fmt.Sprintf("%x", digest)[:40]
				s.pulls[key] = p
				if s.holdMain {
					s.held = append(s.held, p.MergeCommitSHA)
				} else {
					s.main[p.MergeCommitSHA] = true
				}
			}
			return 200, map[string]any{"merged": true, "sha": p.MergeCommitSHA, "message": "Pull Request successfully merged"}
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

// issues are a repository's configured issue numbers.
func (s *Server) issues(repo string) []int64 {
	for _, installation := range s.config.Installations {
		for _, candidate := range installation.Repositories {
			if candidate.FullName == repo {
				return candidate.Issues
			}
		}
	}
	return nil
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
		s.comments++
		return 201, map[string]any{"id": s.comments, "body": input.Body, "user": map[string]string{"type": "Bot"}, "performed_via_github_app": map[string]int64{"id": s.config.AppID}}
	}
	var input struct{ Labels []string }
	if json.Unmarshal(body, &input) != nil || len(input.Labels) == 0 {
		return failure(422, "labels required")
	}
	for _, label := range input.Labels {
		if !slices.Contains(s.labels[key], label) {
			s.labels[key] = append(s.labels[key], label)
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
	if s.config.GitRoot == "" {
		return "", false, false
	}
	dir := filepath.Join(s.config.GitRoot, filepath.FromSlash(repo)+".git")
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return "", false, false
	}
	out, err := exec.Command("/usr/bin/git", "--git-dir", dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch).Output()
	if err != nil {
		return "", true, false
	}
	return strings.TrimSpace(string(out)), true, true
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
	return map[string]any{"id": repo.ID, "name": name, "full_name": repo.FullName, "private": repo.Private, "default_branch": "main", "allow_squash_merge": true, "owner": map[string]string{"login": owner}, "permissions": map[string]bool{"admin": true, "push": true, "pull": true}, "clone_url": s.URL + "/" + repo.FullName + ".git", "html_url": "https://github.com/" + repo.FullName}
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
		if suffix == "git-receive-pack" && s.lostPushes > 0 {
			s.lostPushes--
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
