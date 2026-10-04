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
	ConversionCode                                       string
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
	mu        sync.Mutex
	config    Config
	key       *rsa.PublicKey
	converted bool
	oauthUsed bool
	writes    []Write
	tokens    map[string]int64
	pulls     map[string]Pull
}

func New(config Config) (*Server, error) {
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
	s := &Server{config: config, key: &key.PublicKey, tokens: make(map[string]int64), pulls: make(map[string]Pull)}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serveHTTP))
	return s, nil
}

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
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var status int
	var response any
	if err != nil {
		status, response = failure(http.StatusBadRequest, "request body unreadable")
	} else {
		status, response = s.respond(r, body)
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if r.URL.Path == "/login/oauth/access_token" {
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
		if err != nil || !s.converted || s.oauthUsed || form.Get("code") != "owner-code" || form.Get("client_id") != s.config.ClientID || form.Get("client_secret") != s.config.ClientSecret || form.Get("redirect_uri") == "" {
			return failure(401, "OAuth exchange refused")
		}
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
		repos := append([]Repository{}, installation.Repositories...)
		start, end := pageBounds(r, len(repos))
		return http.StatusOK, map[string]any{"total_count": len(repos), "repositories": repos[start:end]}
	}
	if installationID, ok := s.tokens[token]; ok {
		if r.Method == http.MethodGet && r.URL.Path == "/user/7" {
			return 200, map[string]any{"id": 7, "login": s.config.OwnerLogin}
		}
		if r.URL.Path == "/graphql" {
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
			if len(path) == 6 && path[3] == "collaborators" && path[4] == s.config.OwnerLogin && path[5] == "permission" && r.Method == http.MethodGet {
				return 200, map[string]any{"permission": "admin", "role_name": "admin", "user": map[string]any{"login": s.config.OwnerLogin, "permissions": map[string]bool{"admin": true, "push": true, "pull": true}}}
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
}

func (s *Server) pullRequest(r *http.Request, repo string, path []string, body []byte) (int, any) {
	if r.Method == http.MethodGet && strings.Join(path, "/") == "branches/main/protection" {
		return 200, map[string]any{"required_status_checks": map[string]any{"contexts": []string{}, "checks": []any{}}}
	}
	if r.Method == http.MethodGet && strings.Join(path, "/") == "rules/branches/main" {
		return 200, []any{}
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
		p.Head.Repo.FullName = repo
		p.Base.Ref = input.Base
		s.pulls[repo+"/"+strconv.FormatInt(number, 10)] = p
		return 201, p
	}
	if len(path) == 1 && r.Method == http.MethodGet {
		result := []Pull{}
		head := strings.TrimPrefix(r.URL.Query().Get("head"), strings.Split(repo, "/")[0]+":")
		for _, p := range s.pulls {
			if p.Repository == repo && (head == "" || head == p.Head.Ref) {
				result = append(result, p)
			}
		}
		sort.Slice(result, func(i, j int) bool { return result[i].Number < result[j].Number })
		start, end := pageBounds(r, len(result))
		return 200, result[start:end]
	}
	if len(path) == 3 && path[2] == "merge" {
		key := repo + "/" + path[1]
		p, ok := s.pulls[key]
		if !ok {
			return failure(404, "pull request not found")
		}
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
			if input.SHA != p.Head.SHA {
				return failure(409, "Head branch was modified")
			}
			if p.Draft || (p.State != "open" && !p.Merged) {
				return failure(405, "Pull request is not mergeable")
			}
			if !p.Merged {
				now := time.Now().UTC()
				p.Merged = true
				p.MergedAt = &now
				p.State = "closed"
				digest := sha256.Sum256([]byte("squash/" + key + "/" + p.Head.SHA))
				p.MergeCommitSHA = fmt.Sprintf("%x", digest)[:40]
				s.pulls[key] = p
			}
			return 200, map[string]any{"merged": true, "sha": p.MergeCommitSHA, "message": "Pull Request successfully merged"}
		}
	}
	if len(path) == 2 {
		key := repo + "/" + path[1]
		p, ok := s.pulls[key]
		if !ok {
			return failure(404, "pull request not found")
		}
		if r.Method == http.MethodGet {
			return 200, p
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
			return 200, p
		}
	}
	return failure(404, "endpoint not found")
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
	allowed := false
	if basic && authenticated && valid && (suffix == "info/refs" || suffix == "git-upload-pack") {
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
	handler := cgi.Handler{Path: "/usr/bin/git", Args: []string{"http-backend"}, Root: "/", Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1"}}
	receipt := httptest.NewRecorder()
	handler.ServeHTTP(receipt, r)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.mu.Lock()
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
