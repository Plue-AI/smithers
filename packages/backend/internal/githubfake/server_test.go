package githubfake

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func fixture(t *testing.T) (*Server, Config, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	config := Config{OAuthCode: "owner-code", AppID: 42, Slug: "smithers-test", OwnerLogin: "acme", OwnerKind: "org", ClientID: "Iv1.fake", ClientSecret: "client-secret-fixture", WebhookSecret: "webhook-secret-fixture", ConversionCode: "one-use-code", PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), Installations: []Installation{{ID: 91, Repositories: []Repository{{ID: 100, FullName: "acme/app"}}}}}
	server, err := New(config)
	require.NoError(t, err)
	t.Cleanup(server.Close)
	return server, config, key
}

func jwt(t *testing.T, key *rsa.PrivateKey, issuer int64, expires time.Time) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{"iss": strconv.FormatInt(issuer, 10), "iat": time.Now().Add(-time.Minute).Unix(), "exp": expires.Unix()})
	require.NoError(t, err)
	unsigned := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	require.NoError(t, err)
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func request(t *testing.T, server *Server, method, path, authorization string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, server.URL+path, bytes.NewReader(body))
	require.NoError(t, err)
	if authorization != "" {
		req.Header.Set("Authorization", "Bearer "+authorization)
	}
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, data
}

func TestConversionIsSingleUseAndWriteLogCannotBeMutated(t *testing.T) {
	server, config, _ := fixture(t)
	status, data := request(t, server, "POST", "/app-manifests/one-use-code/conversions", "", nil)
	require.Equal(t, http.StatusCreated, status)
	var response map[string]any
	require.NoError(t, json.Unmarshal(data, &response))
	require.Equal(t, config.PrivateKeyPEM, response["pem"])
	require.Equal(t, config.ClientSecret, response["client_secret"])
	require.Equal(t, config.WebhookSecret, response["webhook_secret"])
	status, _ = request(t, server, "POST", "/app-manifests/one-use-code/conversions", "", nil)
	require.Equal(t, http.StatusNotFound, status)
	status, _ = request(t, server, "POST", "/app-manifests/foreign/conversions", "", nil)
	require.Equal(t, http.StatusNotFound, status)
	log := server.Writes()
	require.Len(t, log, 3)
	require.Equal(t, []int{201, 404, 404}, []int{log[0].Status, log[1].Status, log[2].Status})
	require.Equal(t, uint64(1), log[0].Sequence)
	log[0].Path = "/corrupted"
	require.Equal(t, "/app-manifests/one-use-code/conversions", server.Writes()[0].Path)
	for _, entry := range log {
		require.NotContains(t, string(entry.Body), config.PrivateKeyPEM)
	}
}

func TestJWTInstallationTokenAndRepositoryBoundaries(t *testing.T) {
	server, config, key := fixture(t)
	good := jwt(t, key, config.AppID, time.Now().Add(5*time.Minute))
	for _, token := range []string{"", "not-a-jwt", jwt(t, key, 999, time.Now().Add(5*time.Minute)), jwt(t, key, config.AppID, time.Now().Add(-time.Minute))} {
		status, _ := request(t, server, "GET", "/app", token, nil)
		require.Equal(t, http.StatusUnauthorized, status)
	}
	for _, path := range []string{"/app", "/app/installations", "/repos/acme/app/installation"} {
		status, data := request(t, server, "GET", path, good, nil)
		require.Equal(t, http.StatusOK, status, string(data))
	}
	status, _ := request(t, server, "GET", "/repos/acme/missing/installation", good, nil)
	require.Equal(t, http.StatusNotFound, status)
	status, _ = request(t, server, "POST", "/app/installations/999/access_tokens", good, nil)
	require.Equal(t, http.StatusNotFound, status)
	status, data := request(t, server, "POST", "/app/installations/91/access_tokens", good, []byte(`{"permissions":{"contents":"read"}}`))
	require.Equal(t, http.StatusCreated, status, string(data))
	var token struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	require.NoError(t, json.Unmarshal(data, &token))
	require.NotEmpty(t, token.Token)
	require.True(t, token.ExpiresAt.After(time.Now()))
	status, _ = request(t, server, "GET", "/installation/repositories", good, nil)
	require.Equal(t, http.StatusUnauthorized, status)
	status, data = request(t, server, "GET", "/installation/repositories", token.Token, nil)
	require.Equal(t, http.StatusOK, status)
	var inventory struct {
		TotalCount   int          `json:"total_count"`
		Repositories []Repository `json:"repositories"`
	}
	require.NoError(t, json.Unmarshal(data, &inventory))
	require.Equal(t, 1, inventory.TotalCount)
	require.Equal(t, "acme/app", inventory.Repositories[0].FullName)
	log := server.Writes()
	require.Len(t, log, 2)
	require.JSONEq(t, `{"permissions":{"contents":"read"}}`, string(log[1].Body))
	log[1].Body[0] = 'x'
	require.Equal(t, byte('{'), server.Writes()[1].Body[0])
}

func TestInvalidKeyIsRefused(t *testing.T) {
	_, err := New(Config{AppID: 1, PrivateKeyPEM: "bad-key"})
	require.Error(t, err)
}

func TestKeyFormatsAndConfigurationIsolation(t *testing.T) {
	_, config, key := fixture(t)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	require.NoError(t, err)
	config.PrivateKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	server, err := New(config)
	require.NoError(t, err)
	t.Cleanup(server.Close)
	config.Installations[0].Repositories[0].FullName = "acme/changed"
	status, _ := request(t, server, "GET", "/repos/acme/app/installation", jwt(t, key, config.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 200, status)
	config.AppID = 0
	_, err = New(config)
	require.Error(t, err)
	config.AppID = 42
	config.PrivateKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("invalid-der")}))
	_, err = New(config)
	require.Error(t, err)
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	der, err = x509.MarshalPKCS8PrivateKey(ecKey)
	require.NoError(t, err)
	config.PrivateKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	_, err = New(config)
	require.Error(t, err)
}

func TestMalformedAndForgedJWTsAreRefused(t *testing.T) {
	server, config, key := fixture(t)
	good := jwt(t, key, config.AppID, time.Now().Add(time.Minute))
	parts := strings.Split(good, ".")
	encode := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, token := range []string{
		"%." + parts[1] + "." + parts[2], encode(`{"alg":"HS256"}`) + "." + parts[1] + "." + parts[2],
		encode(`bad-json`) + "." + parts[1] + "." + parts[2], parts[0] + ".%." + parts[2],
		parts[0] + "." + encode(`bad-json`) + "." + parts[2], parts[0] + "." + parts[1] + ".%",
		parts[0] + "." + parts[1] + "." + encode("wrong-signature"),
	} {
		status, _ := request(t, server, "GET", "/app", token, nil)
		require.Equal(t, http.StatusUnauthorized, status)
	}
	req, err := http.NewRequest("GET", server.URL+"/app", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", good)
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	status, _ := request(t, server, "GET", "/unknown", good, nil)
	require.Equal(t, http.StatusNotFound, status)
}

type unreadableBody struct{}

func (unreadableBody) Read([]byte) (int, error) { return 0, errors.New("body interrupted") }
func (unreadableBody) Close() error             { return nil }

func TestInterruptedWriteStillGetsPermanentReceipt(t *testing.T) {
	server, _, _ := fixture(t)
	req := httptest.NewRequest(http.MethodPost, "/app-manifests/one-use-code/conversions", nil)
	req.Body = unreadableBody{}
	response := httptest.NewRecorder()
	server.serveHTTP(response, req)
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Len(t, server.Writes(), 1)
	require.Equal(t, http.StatusBadRequest, server.Writes()[0].Status)
	status, _ := request(t, server, "POST", "/app-manifests/one-use-code/conversions", "", nil)
	require.Equal(t, http.StatusCreated, status, "unreadable request must not consume code")
}

func TestPaginationAndUserOwner(t *testing.T) {
	_, config, key := fixture(t)
	config.OwnerKind = "user"
	config.Installations = []Installation{}
	for i := 0; i < 101; i++ {
		config.Installations = append(config.Installations, Installation{ID: int64(i + 1), Account: Account{Login: "ada"}, Repositories: []Repository{{ID: int64(i + 1), FullName: "ada/app"}}})
	}
	server, err := New(config)
	require.NoError(t, err)
	t.Cleanup(server.Close)
	token := jwt(t, key, config.AppID, time.Now().Add(time.Minute))
	for _, tc := range []struct {
		query  string
		length int
	}{
		{"?per_page=100&page=1", 100}, {"?per_page=100&page=2", 1}, {"?per_page=100&page=3", 0},
		{"?per_page=101&page=0", 30}, {"?per_page=0&page=-1", 30},
	} {
		status, data := request(t, server, "GET", "/app/installations"+tc.query, token, nil)
		require.Equal(t, 200, status)
		var installations []Installation
		require.NoError(t, json.Unmarshal(data, &installations))
		require.Len(t, installations, tc.length)
	}
	status, data := request(t, server, "GET", "/app", token, nil)
	require.Equal(t, 200, status)
	var app struct {
		Owner struct {
			Type string `json:"type"`
		} `json:"owner"`
	}
	require.NoError(t, json.Unmarshal(data, &app))
	require.Equal(t, "User", app.Owner.Type)
}

func TestPullDraftLifecycleRequiresScopedInstallation(t *testing.T) {
	server, config, key := fixture(t)
	status, raw := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, config.AppID, time.Now().Add(time.Minute)), []byte(`{"permissions":{"pull_requests":"write","administration":"read"}}`))
	require.Equal(t, 201, status)
	var token struct{ Token string }
	require.NoError(t, json.Unmarshal(raw, &token))
	status, raw = request(t, server, "POST", "/repos/acme/app/pulls", token.Token, []byte(`{"title":"Retry webhooks","head":"smithers/retry","base":"main","body":"Prompt","draft":true}`))
	require.Equal(t, 201, status)
	var pull Pull
	require.NoError(t, json.Unmarshal(raw, &pull))
	require.True(t, pull.Draft)
	require.Equal(t, "main", pull.Base.Ref)
	for _, tc := range []struct {
		mutation string
		draft    bool
	}{{"markPullRequestReadyForReview", false}, {"convertPullRequestToDraft", true}} {
		body, err := json.Marshal(map[string]any{"query": "mutation { " + tc.mutation + "(input: {}) { pullRequest { id isDraft } } }", "variables": map[string]string{"id": pull.NodeID}})
		require.NoError(t, err)
		status, _ = request(t, server, "POST", "/graphql", token.Token, body)
		require.Equal(t, 200, status)
		status, raw = request(t, server, "GET", "/repos/acme/app/pulls/1", token.Token, nil)
		require.Equal(t, 200, status)
		require.NoError(t, json.Unmarshal(raw, &pull))
		require.Equal(t, tc.draft, pull.Draft)
	}
	status, raw = request(t, server, "PATCH", "/repos/acme/app/pulls/1", token.Token, []byte(`{"body":"Latest revision"}`))
	require.Equal(t, 200, status)
	require.NoError(t, json.Unmarshal(raw, &pull))
	require.Equal(t, "Latest revision", pull.Body)
	status, raw = request(t, server, "GET", "/repos/acme/app/pulls?head=acme:smithers/retry&state=all", token.Token, nil)
	require.Equal(t, 200, status)
	var pulls []Pull
	require.NoError(t, json.Unmarshal(raw, &pulls))
	require.Len(t, pulls, 1)
	status, _ = request(t, server, "POST", "/repos/acme/app/pulls", token.Token, []byte(`{"head":"smithers/retry","base":"main"}`))
	require.Equal(t, 422, status)
	status, raw = request(t, server, "GET", "/repos/acme/app/branches/main/protection", token.Token, nil)
	require.Equal(t, 404, status, "a main without classic protection")
	require.JSONEq(t, `{"message":"Branch not protected"}`, string(raw))
	status, _ = request(t, server, "GET", "/repos/acme/app/rules/branches/main", token.Token, nil)
	require.Equal(t, 200, status)
	status, _ = request(t, server, "GET", "/repos/acme/foreign/pulls", token.Token, nil)
	require.Equal(t, 404, status)
	status, _ = request(t, server, "GET", "/repos/acme/app/pulls", jwt(t, key, config.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 404, status)
	writes := server.Writes()
	require.Len(t, writes, 6)
	for _, write := range writes {
		require.NotContains(t, string(write.Body), token.Token)
	}
}

func TestOwnerOAuthAndRepositoryBoundaries(t *testing.T) {
	server, cfg, key := fixture(t)
	form := url.Values{"code": {"owner-code"}, "client_id": {cfg.ClientID}, "client_secret": {cfg.ClientSecret}, "redirect_uri": {"http://localhost:4000/api/auth/github/callback"}}
	exchange := func(values url.Values) int {
		status, _ := request(t, server, "POST", "/login/oauth/access_token", "", []byte(values.Encode()))
		return status
	}
	require.Equal(t, 401, exchange(form), "App must be converted first")
	status, _ := request(t, server, "POST", "/app-manifests/one-use-code/conversions", "", nil)
	require.Equal(t, 201, status)
	for _, field := range []string{"code", "client_id", "client_secret", "redirect_uri"} {
		bad := url.Values{}
		for k, v := range form {
			bad[k] = append([]string(nil), v...)
		}
		bad.Set(field, "")
		require.Equal(t, 401, exchange(bad))
	}
	require.Equal(t, 200, exchange(form))
	require.Equal(t, 401, exchange(form), "OAuth code is single-use")
	for _, path := range []string{"/user", "/user/emails", "/user/repos", "/repos/acme/app"} {
		status, body := request(t, server, "GET", path, "ghu_githubfake_owner", nil)
		require.Equal(t, 200, status, string(body))
		status, _ = request(t, server, "GET", path, "invalid", nil)
		require.Equal(t, 401, status)
	}
	status, _ = request(t, server, "GET", "/repos/acme/foreign", "ghu_githubfake_owner", nil)
	require.Equal(t, 404, status)
	for _, write := range server.Writes() {
		if write.Path == "/login/oauth/access_token" {
			require.Empty(t, write.Body, "OAuth client secret must never appear in receipts")
		}
	}
	appJWT := jwt(t, key, cfg.AppID, time.Now().Add(time.Minute))
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", appJWT, nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	status, body = request(t, server, "GET", "/repos/acme/app", access.Token, nil)
	require.Equal(t, 200, status)
	status, user := request(t, server, "GET", "/user/7", access.Token, nil)
	require.Equal(t, 200, status)
	require.Contains(t, string(user), `"login":"acme"`)
	var metadata struct {
		Squash bool   `json:"allow_squash_merge"`
		Branch string `json:"default_branch"`
	}
	require.NoError(t, json.Unmarshal(body, &metadata))
	require.True(t, metadata.Squash)
	require.Equal(t, "main", metadata.Branch)
	status, _ = request(t, server, "GET", "/repos/acme/app/collaborators/acme/permission", access.Token, nil)
	require.Equal(t, 200, status)
	for _, path := range []string{"/repos/acme/foreign", "/repos/acme/app/collaborators/foreign/permission"} {
		status, _ = request(t, server, "GET", path, access.Token, nil)
		require.Equal(t, 404, status)
	}
}

func TestGitSmartHTTPUsesRealObjectsAndInstallationAuthority(t *testing.T) {
	server, cfg, key := fixture(t)
	root := t.TempDir()
	seed := filepath.Join(root, "seed")
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("/usr/bin/git", args...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return string(out)
	}
	git("init", "-b", "main", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "JOURNEY.md"), []byte("canary\n"), 0600))
	git("-C", seed, "add", "JOURNEY.md")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Seed")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "acme"), 0700))
	git("clone", "--bare", seed, filepath.Join(root, "acme/app.git"))
	server.config.GitRoot = root
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	clone := filepath.Join(root, "clone")
	header := "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+access.Token))
	git("-c", "http.extraHeader="+header, "clone", server.URL+"/acme/app.git", clone)
	contents, err := os.ReadFile(filepath.Join(clone, "JOURNEY.md"))
	require.NoError(t, err)
	require.Equal(t, "canary\n", string(contents))
	require.Equal(t, strings.TrimSpace(git("-C", seed, "rev-parse", "HEAD")), strings.TrimSpace(git("-C", clone, "rev-parse", "HEAD")))
	for _, path := range []string{"/acme/app.git/info/refs?service=git-upload-pack", "/acme/foreign.git/info/refs?service=git-upload-pack", "/acme/app.git/git-receive-pack"} {
		status, _ := request(t, server, "GET", path, "", nil)
		require.Equal(t, 403, status)
	}
	req, err := http.NewRequest("GET", server.URL+"/acme/foreign.git/info/refs?service=git-upload-pack", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", header)
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 403, resp.StatusCode)
	require.True(t, func() bool {
		for _, write := range server.Writes() {
			if write.Path == "/acme/app.git/git-upload-pack" && write.Status == 200 {
				return true
			}
		}
		return false
	}(), "real pack transfer must leave a write receipt")
}

// In a repository the Git fixture hosts, a squash merge is a real commit
// on main: the pull request's changes on main's tree, one parent (main),
// the merge request's title and message. A held merge chains off main
// until ReleaseMain; a conflicted pull request is refused and merges
// nothing; compare answers from the repository's history.
func TestSquashMergeWritesARealCommitToAHostedMain(t *testing.T) {
	server, cfg, key := fixture(t)
	root := t.TempDir()
	seed := filepath.Join(root, "seed")
	bare := filepath.Join(root, "acme/app.git")
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("/usr/bin/git", args...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	commit := func(path, content, message string) string {
		t.Helper()
		require.NoError(t, os.WriteFile(filepath.Join(seed, path), []byte(content), 0600))
		git("-C", seed, "add", path)
		git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "-m", message)
		return git("-C", seed, "rev-parse", "HEAD")
	}
	git("init", "-q", "-b", "main", seed)
	base := commit("JOURNEY.md", "canary\n", "Seed")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "acme"), 0700))
	git("clone", "-q", "--bare", seed, bare)
	branch := func(name, path, content string) {
		t.Helper()
		git("-C", seed, "checkout", "-q", "-B", name, base)
		commit(path, content, name)
		git("-C", seed, "push", "-q", bare, name+":refs/heads/"+name)
	}
	branch("smithers/first", "JOURNEY.md", "hello\n")
	branch("smithers/second", "SECOND.md", "second\n")
	branch("smithers/conflict", "JOURNEY.md", "goodbye\n")
	server.config.GitRoot = root
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	open := func(head string) Pull {
		t.Helper()
		status, body := request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"T","head":"`+head+`","base":"main"}`))
		require.Equal(t, 201, status, string(body))
		var pull Pull
		require.NoError(t, json.Unmarshal(body, &pull))
		return pull
	}
	merge := func(pull Pull, title, message string) (int, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"sha": pull.Head.SHA, "merge_method": "squash", "commit_title": title, "commit_message": message})
		status, raw := request(t, server, "PUT", fmt.Sprintf("/repos/acme/app/pulls/%d/merge", pull.Number), access.Token, body)
		var answer struct {
			SHA     string `json:"sha"`
			Message string `json:"message"`
		}
		require.NoError(t, json.Unmarshal(raw, &answer))
		if status == 200 {
			return status, answer.SHA
		}
		return status, answer.Message
	}
	type comparison struct {
		Status   string `json:"status"`
		AheadBy  int    `json:"ahead_by"`
		BehindBy int    `json:"behind_by"`
	}
	compare := func(head string) (int, comparison) {
		t.Helper()
		var answer comparison
		status, raw := request(t, server, "GET", "/repos/acme/app/compare/main..."+head, access.Token, nil)
		if status == 200 {
			require.NoError(t, json.Unmarshal(raw, &answer))
		}
		return status, answer
	}
	main := func() string { return git("--git-dir", bare, "rev-parse", "refs/heads/main") }

	first := open("smithers/first")
	status, squash := merge(first, "Add a greeting (#1)", "TODO T1, reviewed at "+first.Head.SHA+".")
	require.Equal(t, 200, status, squash)
	require.Equal(t, squash, main(), "GitHub's main is the squash commit")
	require.Equal(t, base, git("--git-dir", bare, "rev-parse", squash+"^"), "one parent: the old main")
	require.Equal(t, "", git("--git-dir", bare, "rev-list", "--no-walk", "--merges", squash), "a squash is not a merge commit")
	require.Equal(t, git("--git-dir", bare, "rev-parse", first.Head.SHA+"^{tree}"), git("--git-dir", bare, "rev-parse", squash+"^{tree}"))
	require.Equal(t, "Add a greeting (#1)\n\nTODO T1, reviewed at "+first.Head.SHA+".", git("--git-dir", bare, "log", "-1", "--format=%B", squash))
	require.Equal(t, "GitHub <noreply@github.com>", git("--git-dir", bare, "log", "-1", "--format=%cn <%ce>", squash))
	var read Pull
	status, raw := request(t, server, "GET", "/repos/acme/app/pulls/1", access.Token, nil)
	require.Equal(t, 200, status)
	require.NoError(t, json.Unmarshal(raw, &read))
	require.True(t, read.Merged)
	require.Equal(t, squash, read.MergeCommitSHA)
	status, on := compare(squash)
	require.Equal(t, 200, status)
	require.Equal(t, comparison{Status: "identical"}, on)
	status, on = compare(first.Head.SHA)
	require.Equal(t, 200, status)
	require.Equal(t, comparison{Status: "diverged", AheadBy: 1, BehindBy: 1}, on, "a squash never puts the branch's own commit on main")
	status, _ = compare(strings.Repeat("0", 40))
	require.Equal(t, 404, status)

	// A held merge is GitHub reporting the merge before main contains it.
	server.HoldMain()
	second := open("smithers/second")
	status, held := merge(second, "", "")
	require.Equal(t, 200, status, held)
	require.Equal(t, squash, main(), "main does not contain a held merge")
	require.Equal(t, "T (#2)", git("--git-dir", bare, "log", "-1", "--format=%B", held), "GitHub's default title")
	status, on = compare(held)
	require.Equal(t, 200, status)
	require.Equal(t, comparison{Status: "ahead", AheadBy: 1}, on)
	server.ReleaseMain()
	require.Equal(t, held, main())
	require.Equal(t, squash, git("--git-dir", bare, "rev-parse", held+"^"))
	// second branched from the seed: its file joins main's merged tree.
	require.Equal(t, "hello\n", git("--git-dir", bare, "show", held+":JOURNEY.md")+"\n")
	require.Equal(t, "second\n", git("--git-dir", bare, "show", held+":SECOND.md")+"\n")
	status, on = compare(squash)
	require.Equal(t, 200, status)
	require.Equal(t, comparison{Status: "behind", BehindBy: 1}, on)

	// A pull request whose changes conflict with main is not mergeable.
	conflict := open("smithers/conflict")
	status, message := merge(conflict, "", "")
	require.Equal(t, 405, status)
	require.Equal(t, "Pull Request is not mergeable", message)
	require.Equal(t, held, main())
	status, raw = request(t, server, "GET", fmt.Sprintf("/repos/acme/app/pulls/%d", conflict.Number), access.Token, nil)
	require.Equal(t, 200, status)
	require.NoError(t, json.Unmarshal(raw, &read))
	require.False(t, read.Merged)
	require.Equal(t, "open", read.State)

	// A person's merge on github.com writes main too.
	git("-C", seed, "fetch", "-q", bare, "refs/heads/main")
	git("-C", seed, "checkout", "-q", "-B", "smithers/person", held)
	commit("PERSON.md", "person\n", "person")
	git("-C", seed, "push", "-q", bare, "smithers/person:refs/heads/smithers/person")
	person := open("smithers/person")
	server.MergeAsPerson("acme/app", person.Number)
	require.Equal(t, held, git("--git-dir", bare, "rev-parse", "refs/heads/main^"))
	require.Equal(t, "person\n", git("--git-dir", bare, "show", "refs/heads/main:PERSON.md")+"\n")
}

func TestSquashMergeIsHeadBoundAndProjectsOnlyAfterTheWrite(t *testing.T) {
	server, cfg, key := fixture(t)
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	status, body = request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"First","head":"smithers/first","base":"main"}`))
	require.Equal(t, 201, status)
	var pull Pull
	require.NoError(t, json.Unmarshal(body, &pull))
	require.Len(t, pull.Head.SHA, 40)
	require.False(t, pull.Merged)
	require.Nil(t, pull.MergedAt)
	merge := func(head, method string) int {
		body, _ := json.Marshal(map[string]string{"sha": head, "merge_method": method})
		status, _ := request(t, server, "PUT", "/repos/acme/app/pulls/1/merge", access.Token, body)
		return status
	}
	require.Equal(t, 409, merge(strings.Repeat("0", 40), "squash"))
	require.Equal(t, 422, merge(pull.Head.SHA, "merge"))
	status, body = request(t, server, "GET", "/repos/acme/app/pulls/1", access.Token, nil)
	require.Equal(t, 200, status)
	require.NoError(t, json.Unmarshal(body, &pull))
	require.False(t, pull.Merged)
	status, _ = request(t, server, "GET", "/repos/acme/app/pulls/1/merge", access.Token, nil)
	require.Equal(t, 404, status)
	require.Equal(t, 200, merge(pull.Head.SHA, "squash"))
	status, body = request(t, server, "GET", "/repos/acme/app/pulls/1", access.Token, nil)
	require.Equal(t, 200, status)
	require.NoError(t, json.Unmarshal(body, &pull))
	require.True(t, pull.Merged)
	require.NotNil(t, pull.MergedAt)
	require.Len(t, pull.MergeCommitSHA, 40)
	require.Equal(t, "closed", pull.State)
	firstSHA, firstTime := pull.MergeCommitSHA, *pull.MergedAt
	require.Equal(t, 405, merge(pull.Head.SHA, "squash"), "GitHub refuses to merge a merged pull request")
	_, body = request(t, server, "GET", "/repos/acme/app/pulls/1", access.Token, nil)
	require.NoError(t, json.Unmarshal(body, &pull))
	require.Equal(t, firstSHA, pull.MergeCommitSHA)
	require.Equal(t, firstTime, *pull.MergedAt)
	status, _ = request(t, server, "GET", "/repos/acme/app/pulls/1/merge", access.Token, nil)
	require.Equal(t, 204, status)
	status, _ = request(t, server, "PUT", "/repos/acme/foreign/pulls/1/merge", access.Token, []byte(`{}`))
	require.Equal(t, 404, status)
}

func TestGitPushNeedsInstallationTokenAndPullHeadsFollowTheBranch(t *testing.T) {
	server, cfg, key := fixture(t)
	root := t.TempDir()
	run := func(args ...string) (string, error) {
		out, err := exec.Command("/usr/bin/git", args...).CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
	git := func(args ...string) string {
		t.Helper()
		out, err := run(args...)
		require.NoError(t, err, out)
		return out
	}
	seed := filepath.Join(root, "seed")
	git("init", "-b", "main", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "JOURNEY.md"), []byte("canary\n"), 0600))
	git("-C", seed, "add", "JOURNEY.md")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Seed")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "acme"), 0700))
	bare := filepath.Join(root, "acme/app.git")
	git("clone", "--bare", seed, bare)
	server.config.GitRoot = root
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	basic := func(token string) string {
		return "http.extraHeader=Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))
	}
	remote := server.URL + "/acme/app.git"
	work := filepath.Join(root, "work")
	git("-c", basic(access.Token), "clone", remote, work)
	commit := func(content string) string {
		require.NoError(t, os.WriteFile(filepath.Join(work, "JOURNEY.md"), []byte(content), 0600))
		git("-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qam", content)
		return git("-C", work, "rev-parse", "HEAD")
	}
	branchHead := func() string {
		out, _ := run("--git-dir", bare, "rev-parse", "--verify", "--quiet", "refs/heads/smithers/retry")
		return out
	}
	push := func(token string) error {
		_, err := run("-C", work, "-c", basic(token), "push", remote, "HEAD:refs/heads/smithers/retry")
		return err
	}
	first := commit("first\n")
	require.NoError(t, push(access.Token))
	require.Equal(t, first, branchHead(), "an installation token pushes")

	status, _ = request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"Absent","head":"smithers/absent","base":"main"}`))
	require.Equal(t, 422, status, "no pull request without its head branch")
	status, body = request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"Retry","head":"smithers/retry","base":"main"}`))
	require.Equal(t, 201, status)
	var pull Pull
	require.NoError(t, json.Unmarshal(body, &pull))
	require.Equal(t, first, pull.Head.SHA, "the head is the branch's commit")
	second := commit("second\n")
	require.NoError(t, push(access.Token))
	status, body = request(t, server, "GET", "/repos/acme/app/pulls/1", access.Token, nil)
	require.Equal(t, 200, status)
	require.NoError(t, json.Unmarshal(body, &pull))
	require.Equal(t, second, pull.Head.SHA, "an open pull request follows its branch")
	status, body = request(t, server, "GET", "/repos/acme/app/pulls?head=acme:smithers/retry&state=all", access.Token, nil)
	require.Equal(t, 200, status)
	var pulls []Pull
	require.NoError(t, json.Unmarshal(body, &pulls))
	require.Len(t, pulls, 1)
	require.Equal(t, second, pulls[0].Head.SHA)

	server.LoseNextResponses("/acme/app.git/git-receive-pack", 1)
	third := commit("third\n")
	require.Error(t, push(access.Token), "the answer is lost")
	require.Equal(t, third, branchHead(), "GitHub took the write")
	receipts := server.Writes()
	require.Equal(t, "/acme/app.git/git-receive-pack", receipts[len(receipts)-1].Path)
	require.Equal(t, http.StatusBadGateway, receipts[len(receipts)-1].Status)
	require.NoError(t, push(access.Token), "the next push answers again")

	// A person's OAuth token reads the repository but never pushes.
	status, _ = request(t, server, "POST", "/app-manifests/one-use-code/conversions", "", nil)
	require.Equal(t, 201, status)
	form := url.Values{"code": {"owner-code"}, "client_id": {cfg.ClientID}, "client_secret": {cfg.ClientSecret}, "redirect_uri": {"http://localhost:4000/api/auth/github/callback"}}
	status, _ = request(t, server, "POST", "/login/oauth/access_token", "", []byte(form.Encode()))
	require.Equal(t, 200, status)
	refs := git("-c", basic("ghu_githubfake_owner"), "ls-remote", remote)
	require.Contains(t, refs, third+"\trefs/heads/smithers/retry")
	commit("person\n")
	require.Error(t, push("ghu_githubfake_owner"))
	require.Equal(t, third, branchHead())
}

func TestIssueLabelsAndCommentsNeedAnIssueAndFailedWritesApplyNothing(t *testing.T) {
	server, cfg, key := fixture(t)
	// Issue 1 exists on acme/app; pull requests number after it, as GitHub
	// numbers issues and pull requests in one sequence.
	server.config.Installations[0].Repositories[0].Issues = []int64{1}
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	status, body = request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"Wait","head":"smithers/wait","base":"main"}`))
	require.Equal(t, 201, status)
	var pull Pull
	require.NoError(t, json.Unmarshal(body, &pull))
	require.Equal(t, int64(2), pull.Number)
	require.Empty(t, pull.Labels)

	waiting := []byte(`{"labels":["smithers:waiting"]}`)
	status, _ = request(t, server, "POST", "/repos/acme/app/issues/9/labels", access.Token, waiting)
	require.Equal(t, 404, status, "no label on an issue that does not exist")
	server.FailNextWrites("/repos/acme/app/issues/2/labels", 1)
	status, _ = request(t, server, "POST", "/repos/acme/app/issues/2/labels", access.Token, waiting)
	require.Equal(t, http.StatusBadGateway, status)
	status, body = request(t, server, "GET", "/repos/acme/app/pulls/2", access.Token, nil)
	require.Equal(t, 200, status)
	require.NoError(t, json.Unmarshal(body, &pull))
	require.Empty(t, pull.Labels, "a failed write applies nothing")
	for range 2 {
		status, body = request(t, server, "POST", "/repos/acme/app/issues/2/labels", access.Token, waiting)
		require.Equal(t, 200, status)
		require.JSONEq(t, `[{"name":"smithers:waiting"}]`, string(body), "adding a present label keeps one")
	}
	status, body = request(t, server, "GET", "/repos/acme/app/pulls?head=acme:smithers/wait", access.Token, nil)
	require.Equal(t, 200, status)
	var pulls []Pull
	require.NoError(t, json.Unmarshal(body, &pulls))
	require.Len(t, pulls, 1)
	require.Equal(t, []Label{{Name: "smithers:waiting"}}, pulls[0].Labels)

	status, body = request(t, server, "POST", "/repos/acme/app/issues/1/comments", access.Token, []byte(`{"body":"Smithers is holding this TODO."}`))
	require.Equal(t, 201, status)
	var comment map[string]any
	require.NoError(t, json.Unmarshal(body, &comment))
	require.Equal(t, "Smithers is holding this TODO.", comment["body"])
	require.Equal(t, map[string]any{"type": "Bot"}, comment["user"])
	require.Equal(t, map[string]any{"id": float64(cfg.AppID)}, comment["performed_via_github_app"])
	status, _ = request(t, server, "POST", "/repos/acme/app/issues/9/comments", access.Token, []byte(`{"body":"lost"}`))
	require.Equal(t, 404, status)
	status, _ = request(t, server, "POST", "/repos/acme/app/issues/1/comments", access.Token, []byte(`{"body":""}`))
	require.Equal(t, 422, status, "a comment needs a body")

	var receipts []string
	for _, write := range server.Writes() {
		if strings.HasPrefix(write.Path, "/repos/acme/app/issues/") {
			receipts = append(receipts, write.Path+" "+strconv.Itoa(write.Status))
		}
	}
	require.Equal(t, []string{
		"/repos/acme/app/issues/9/labels 404",
		"/repos/acme/app/issues/2/labels 502",
		"/repos/acme/app/issues/2/labels 200",
		"/repos/acme/app/issues/2/labels 200",
		"/repos/acme/app/issues/1/comments 201",
		"/repos/acme/app/issues/9/comments 404",
		"/repos/acme/app/issues/1/comments 422",
	}, receipts)
}

// The merge facts the stack reads: computed mergeability, main's
// containment of a merge (held until released), a refusal GitHub states
// once, protection's required checks and the check runs on a commit.
func TestMergeFactsContainmentRefusalAndChecks(t *testing.T) {
	server, cfg, key := fixture(t)
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	get := func(path string, out any) int {
		t.Helper()
		status, body := request(t, server, "GET", path, access.Token, nil)
		if out != nil && status == 200 {
			require.NoError(t, json.Unmarshal(body, out))
		}
		return status
	}
	open := func(head string) Pull {
		t.Helper()
		status, body := request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"T","head":"`+head+`","base":"main"}`))
		require.Equal(t, 201, status)
		var pull Pull
		require.NoError(t, json.Unmarshal(body, &pull))
		return pull
	}
	merge := func(pull Pull) (int, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"sha": pull.Head.SHA, "merge_method": "squash"})
		status, raw := request(t, server, "PUT", fmt.Sprintf("/repos/acme/app/pulls/%d/merge", pull.Number), access.Token, body)
		var answer struct{ Message string }
		require.NoError(t, json.Unmarshal(raw, &answer))
		return status, answer.Message
	}
	var account map[string]any
	require.Equal(t, 200, get("/user/7", &account))
	require.Equal(t, "User", account["type"])

	first := open("smithers/first")
	require.Equal(t, "clean", first.MergeableState)
	require.NotNil(t, first.Mergeable)
	require.True(t, *first.Mergeable)
	server.UpdatePull("acme/app", first.Number, func(p *Pull) { p.Draft = true })
	var read Pull
	require.Equal(t, 200, get("/repos/acme/app/pulls/1", &read))
	require.Equal(t, "draft", read.MergeableState)
	server.UpdatePull("acme/app", first.Number, func(p *Pull) { p.Draft, p.MergeableState = false, "dirty" })
	require.Equal(t, 200, get("/repos/acme/app/pulls/1", &read))
	require.Equal(t, "dirty", read.MergeableState)
	server.UpdatePull("acme/app", first.Number, func(p *Pull) { p.MergeableState = "" })

	server.RefuseNextMerge("acme/app", first.Number, Refusal{Status: 405, Message: "At least 1 approving review is required"})
	status, message := merge(first)
	require.Equal(t, 405, status)
	require.Equal(t, "At least 1 approving review is required", message)
	require.Equal(t, 200, get("/repos/acme/app/pulls/1", &read))
	require.False(t, read.Merged, "a refused merge changes nothing")
	require.Equal(t, 404, get("/repos/acme/app/compare/main..."+strings.Repeat("0", 40), nil))
	status, _ = merge(first)
	require.Equal(t, 200, status, "the refusal is said once")
	require.Equal(t, 200, get("/repos/acme/app/pulls/1", &read))
	require.Equal(t, "unknown", read.MergeableState)
	var compare struct {
		Status  string `json:"status"`
		AheadBy int    `json:"ahead_by"`
	}
	require.Equal(t, 200, get("/repos/acme/app/compare/main..."+read.MergeCommitSHA, &compare))
	require.Equal(t, 0, compare.AheadBy)

	server.HoldMain()
	second := open("smithers/second")
	status, _ = merge(second)
	require.Equal(t, 200, status)
	require.Equal(t, 200, get("/repos/acme/app/pulls/2", &read))
	require.True(t, read.Merged)
	require.Equal(t, 200, get("/repos/acme/app/compare/main..."+read.MergeCommitSHA, &compare))
	require.Equal(t, 1, compare.AheadBy, "GitHub reports the merge before main contains it")
	server.ReleaseMain()
	require.Equal(t, 200, get("/repos/acme/app/compare/main..."+read.MergeCommitSHA, &compare))
	require.Equal(t, 0, compare.AheadBy)
	require.Equal(t, 404, get("/repos/acme/app/compare/other..."+read.MergeCommitSHA, nil))

	server.RequireCheck("unit")
	server.SetCheck("acme/app", first.Head.SHA, "unit", "in_progress", "")
	server.SetCheck("acme/app", first.Head.SHA, "unit", "completed", "failure")
	server.SetCheck("acme/app", first.Head.SHA, "lint", "completed", "success")
	var protection struct {
		Required struct {
			Contexts []string `json:"contexts"`
		} `json:"required_status_checks"`
	}
	require.Equal(t, 200, get("/repos/acme/app/branches/main/protection", &protection))
	require.Equal(t, []string{"unit"}, protection.Required.Contexts)
	var runs struct {
		Total int        `json:"total_count"`
		Runs  []CheckRun `json:"check_runs"`
	}
	require.Equal(t, 200, get("/repos/acme/app/commits/"+first.Head.SHA+"/check-runs?filter=latest&per_page=100&page=1", &runs))
	require.Equal(t, 2, runs.Total, "the latest run of each check")
	require.Equal(t, "unit", runs.Runs[0].Name)
	require.Equal(t, "completed", runs.Runs[0].Status)
	require.Equal(t, "failure", *runs.Runs[0].Conclusion)
	require.Equal(t, 200, get("/repos/acme/app/commits/"+first.Head.SHA+"/check-runs?filter=latest&per_page=100&page=2", &runs))
	require.Empty(t, runs.Runs)
	var statuses []any
	require.Equal(t, 200, get("/repos/acme/app/commits/"+first.Head.SHA+"/statuses?per_page=100&page=1", &statuses))
	require.Empty(t, statuses)
	require.Equal(t, 200, get("/repos/acme/app/commits/"+second.Head.SHA+"/check-runs", &runs))
	require.Empty(t, runs.Runs)
}

// The authority facts the merge reads: a GitHub account by id and its
// repository permission, which SetCollaborator adds, demotes or promotes.
func TestCollaboratorAccountsAndPermissions(t *testing.T) {
	server, cfg, key := fixture(t)
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	permission := func(login string) (int, string, string) {
		t.Helper()
		status, body := request(t, server, "GET", "/repos/acme/app/collaborators/"+login+"/permission", access.Token, nil)
		var answer struct {
			Permission string `json:"permission"`
			Role       string `json:"role_name"`
		}
		if status == 200 {
			require.NoError(t, json.Unmarshal(body, &answer))
		}
		return status, answer.Permission, answer.Role
	}
	account := func(id int64) (int, string) {
		t.Helper()
		status, body := request(t, server, "GET", "/user/"+strconv.FormatInt(id, 10), access.Token, nil)
		var answer struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
		}
		if status == 200 {
			require.NoError(t, json.Unmarshal(body, &answer))
			require.Equal(t, id, answer.ID)
		}
		return status, answer.Login
	}

	status, login, role := permission("acme")
	require.Equal(t, []any{200, "admin", "admin"}, []any{status, login, role}, "the owner is admin by default")
	status, _, _ = permission("bea")
	require.Equal(t, 404, status, "a login GitHub does not know")
	status, login = account(7)
	require.Equal(t, []any{200, "acme"}, []any{status, login})
	status, _ = account(8)
	require.Equal(t, 404, status)

	server.SetCollaborator(8, "bea", "maintain")
	status, login, role = permission("bea")
	require.Equal(t, []any{200, "write", "maintain"}, []any{status, login, role})
	status, login = account(8)
	require.Equal(t, []any{200, "bea"}, []any{status, login})

	server.SetCollaborator(7, "acme", "read")
	status, login, role = permission("acme")
	require.Equal(t, []any{200, "read", "read"}, []any{status, login, role}, "the owner demoted")
	server.SetCollaborator(7, "acme", "none")
	_, login, _ = permission("acme")
	require.Equal(t, "none", login)

	other, err := New(cfg)
	require.NoError(t, err)
	t.Cleanup(other.Close)
	require.Equal(t, "admin", func() string { p, _ := other.permission("acme"); return p }(), "configuration is per server")
}

// Main's review rule as GitHub computes it: GraphQL's reviewDecision, the
// PR's mergeable_state and a merge's refusal agree, and each reviewer's
// latest review counts.
func TestRequiredReviewsDecideMergeability(t *testing.T) {
	server, cfg, key := fixture(t)
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	status, body = request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"T","head":"smithers/t","base":"main"}`))
	require.Equal(t, 201, status)
	var pull Pull
	require.NoError(t, json.Unmarshal(body, &pull))
	decision := func(repo string, number int64) (any, string) {
		t.Helper()
		owner, name, _ := strings.Cut(repo, "/")
		query, _ := json.Marshal(map[string]any{"query": "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewDecision } } }",
			"variables": map[string]any{"owner": owner, "name": name, "number": number}})
		status, raw := request(t, server, "POST", "/graphql", access.Token, query)
		require.Equal(t, 200, status)
		var answer struct {
			Data struct {
				Repository *struct {
					PullRequest struct {
						ReviewDecision any `json:"reviewDecision"`
					} `json:"pullRequest"`
				} `json:"repository"`
			} `json:"data"`
			Errors []struct{ Message string } `json:"errors"`
		}
		require.NoError(t, json.Unmarshal(raw, &answer))
		if len(answer.Errors) > 0 {
			return nil, answer.Errors[0].Message
		}
		return answer.Data.Repository.PullRequest.ReviewDecision, ""
	}
	state := func() string {
		t.Helper()
		var read Pull
		status, raw := request(t, server, "GET", "/repos/acme/app/pulls/1", access.Token, nil)
		require.Equal(t, 200, status)
		require.NoError(t, json.Unmarshal(raw, &read))
		return read.MergeableState
	}
	merge := func() (int, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"sha": pull.Head.SHA, "merge_method": "squash"})
		status, raw := request(t, server, "PUT", "/repos/acme/app/pulls/1/merge", access.Token, body)
		var answer struct{ Message string }
		require.NoError(t, json.Unmarshal(raw, &answer))
		return status, answer.Message
	}
	var protection map[string]any

	got, refused := decision("acme/app", 1)
	require.Equal(t, []any{nil, ""}, []any{got, refused}, "no review rule: GitHub answers null")
	require.Equal(t, "clean", state())
	status, _ = request(t, server, "GET", "/repos/acme/app/branches/main/protection", access.Token, nil)
	require.Equal(t, 404, status, "no review rule and no classic protection")

	server.RequireReviews(2)
	_, raw := request(t, server, "GET", "/repos/acme/app/branches/main/protection", access.Token, nil)
	require.NoError(t, json.Unmarshal(raw, &protection))
	require.Equal(t, map[string]any{"required_approving_review_count": float64(2)}, protection["required_pull_request_reviews"])
	got, _ = decision("acme/app", 1)
	require.Equal(t, "REVIEW_REQUIRED", got)
	require.Equal(t, "blocked", state())
	status, message := merge()
	require.Equal(t, []any{405, "At least 2 approving reviews are required by reviewers with write access."}, []any{status, message})

	server.Review("acme/app", 1, "bea", "APPROVED")
	got, _ = decision("acme/app", 1)
	require.Equal(t, "REVIEW_REQUIRED", got, "one of two approvals")
	server.Review("acme/app", 1, "cy", "CHANGES_REQUESTED")
	got, _ = decision("acme/app", 1)
	require.Equal(t, "CHANGES_REQUESTED", got)
	require.Equal(t, "blocked", state())
	server.Review("acme/app", 1, "cy", "APPROVED")
	got, _ = decision("acme/app", 1)
	require.Equal(t, "APPROVED", got, "a reviewer's latest review counts")
	require.Equal(t, "clean", state())

	server.UpdatePull("acme/app", 1, func(p *Pull) { p.Draft = true })
	server.Review("acme/app", 1, "cy", "DISMISSED")
	require.Equal(t, "draft", state(), "a draft is draft before blocked")
	server.UpdatePull("acme/app", 1, func(p *Pull) { p.Draft = false })
	require.Equal(t, "blocked", state())
	server.RequireReviews(1)
	status, message = merge()
	require.Equal(t, 200, status, message)

	_, refused = decision("acme/app", 9)
	require.Equal(t, "Could not resolve to a PullRequest with the number of 9.", refused)
	_, refused = decision("acme/other", 1)
	require.Equal(t, "Could not resolve to a PullRequest with the number of 1.", refused, "outside the installation")
}

// GitHub's answers the merge path depends on, each modeled apart: a main
// without classic protection is 404; an installation token answers only
// what it was granted (403 otherwise) and is never minted wider than the
// installation (422); protection is enforced again when the merge is asked
// (405); a merge goes to the pull request's base, whatever it is.
func TestProtectionPermissionsAndMergeTimeEnforcement(t *testing.T) {
	server, cfg, key := fixture(t)
	mint := func(permissions map[string]string) (int, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"repositories": []string{"app"}, "permissions": permissions})
		status, raw := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), body)
		var access struct {
			Token       string            `json:"token"`
			Permissions map[string]string `json:"permissions"`
		}
		require.NoError(t, json.Unmarshal(raw, &access))
		if status == 201 {
			require.Equal(t, permissions, access.Permissions, "the token holds what was asked")
		}
		return status, access.Token
	}
	_, admin := mint(map[string]string{"administration": "read", "pull_requests": "write"})
	_, contents := mint(map[string]string{"contents": "write"})
	_, reader := mint(map[string]string{"contents": "read"})
	message := func(raw []byte) string {
		var answer struct{ Message string }
		require.NoError(t, json.Unmarshal(raw, &answer))
		return answer.Message
	}
	answer := func(method, path, token string, body []byte) (int, string) {
		t.Helper()
		status, raw := request(t, server, method, path, token, body)
		return status, message(raw)
	}

	status, text := answer("GET", "/repos/acme/app/branches/main/protection", admin, nil)
	require.Equal(t, []any{404, "Branch not protected"}, []any{status, text})
	status, text = answer("GET", "/repos/acme/app/branches/main/protection", reader, nil)
	require.Equal(t, []any{403, "Resource not accessible by integration"}, []any{status, text}, "unreadable protection is not absent protection")
	server.RequireCheck("unit")
	status, _ = answer("GET", "/repos/acme/app/branches/main/protection", admin, nil)
	require.Equal(t, 200, status)

	open := func(head, base string) Pull {
		t.Helper()
		status, raw := request(t, server, "POST", "/repos/acme/app/pulls", admin, []byte(`{"title":"T","head":"`+head+`","base":"`+base+`"}`))
		require.Equal(t, 201, status)
		var pull Pull
		require.NoError(t, json.Unmarshal(raw, &pull))
		return pull
	}
	merge := func(pull Pull, token string) (int, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"sha": pull.Head.SHA, "merge_method": "squash", "commit_title": "T (#1)", "commit_message": "T1"})
		return answer("PUT", fmt.Sprintf("/repos/acme/app/pulls/%d/merge", pull.Number), token, body)
	}
	first := open("smithers/first", "main")
	var read Pull
	_, raw := request(t, server, "GET", "/repos/acme/app/pulls/1", admin, nil)
	require.NoError(t, json.Unmarshal(raw, &read))
	require.Equal(t, "blocked", read.MergeableState, "a required check with no run blocks")
	require.Equal(t, []any{403, "Resource not accessible by integration"}, func() []any { s, m := merge(first, reader); return []any{s, m} }())
	require.Equal(t, []any{405, `Required status check "unit" is expected.`}, func() []any { s, m := merge(first, contents); return []any{s, m} }())
	server.SetCheck("acme/app", first.Head.SHA, "unit", "completed", "failure")
	require.Equal(t, []any{405, `Required status check "unit" is failing.`}, func() []any { s, m := merge(first, contents); return []any{s, m} }())
	server.SetCheck("acme/app", first.Head.SHA, "unit", "completed", "success")
	server.UpdatePull("acme/app", first.Number, func(p *Pull) { p.MergeableState = "dirty" })
	require.Equal(t, []any{405, "Pull Request is not mergeable"}, func() []any { s, m := merge(first, contents); return []any{s, m} }())
	server.UpdatePull("acme/app", first.Number, func(p *Pull) { p.MergeableState = "" })

	// A hook runs once, before the answer; a lost answer still merged.
	hooked := 0
	server.OnNextRequest("PUT", "/repos/acme/app/pulls/1/merge", func() {
		hooked++
		server.SetCheck("acme/app", first.Head.SHA, "lint", "completed", "success")
	})
	server.LoseNextResponses("/repos/acme/app/pulls/1/merge", 1)
	status, _ = merge(first, contents)
	require.Equal(t, 502, status)
	require.Equal(t, 1, hooked)
	_, raw = request(t, server, "GET", "/repos/acme/app/pulls/1", admin, nil)
	require.NoError(t, json.Unmarshal(raw, &read))
	require.True(t, read.Merged, "GitHub took the merge its answer lost")
	status, _ = answer("GET", "/repos/acme/app/compare/main..."+read.MergeCommitSHA, admin, nil)
	require.Equal(t, 200, status)
	status, text = merge(first, contents)
	require.Equal(t, []any{405, "Pull Request is not mergeable"}, []any{status, text}, "the merge it took is not taken again")
	require.Equal(t, 1, hooked, "a hook runs once")

	release := open("smithers/release", "release")
	server.SetCheck("acme/app", release.Head.SHA, "unit", "completed", "success")
	status, _ = merge(release, contents)
	require.Equal(t, 200, status)
	_, raw = request(t, server, "GET", "/repos/acme/app/pulls/2", admin, nil)
	require.NoError(t, json.Unmarshal(raw, &read))
	require.True(t, read.Merged)
	status, _ = answer("GET", "/repos/acme/app/compare/main..."+read.MergeCommitSHA, admin, nil)
	require.Equal(t, 404, status, "merged into its base, not main")

	writes := server.Writes()
	var merges []Write
	for _, write := range writes {
		if write.Method == "PUT" {
			merges = append(merges, write)
		}
	}
	require.Equal(t, map[string]string{"contents": "read"}, merges[0].Permissions, "each write records its token's permissions")
	require.Equal(t, map[string]string{"contents": "write"}, merges[1].Permissions)

	server.SetInstallationPermission("administration", "")
	status, _ = mint(map[string]string{"administration": "read"})
	require.Equal(t, 422, status, "never wider than the installation")
	status, _ = mint(map[string]string{"contents": "write"})
	require.Equal(t, 201, status)
	server.SetInstallationPermission("administration", "read")
	status, _ = mint(map[string]string{"administration": "read"})
	require.Equal(t, 201, status)
}

// A merge request that times out while GitHub completes it later, and a
// merge a person makes on github.com: neither is answered by the request
// that asked, and each is one merge.
func TestDelayedMergesAndMergesByAPerson(t *testing.T) {
	server, cfg, key := fixture(t)
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	open := func(head string) Pull {
		t.Helper()
		status, body := request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"T","head":"`+head+`","base":"main"}`))
		require.Equal(t, 201, status)
		var pull Pull
		require.NoError(t, json.Unmarshal(body, &pull))
		return pull
	}
	read := func(number int64) Pull {
		t.Helper()
		_, body := request(t, server, "GET", fmt.Sprintf("/repos/acme/app/pulls/%d", number), access.Token, nil)
		var pull Pull
		require.NoError(t, json.Unmarshal(body, &pull))
		return pull
	}
	merge := func(pull Pull) int {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"sha": pull.Head.SHA, "merge_method": "squash"})
		status, _ := request(t, server, "PUT", fmt.Sprintf("/repos/acme/app/pulls/%d/merge", pull.Number), access.Token, body)
		return status
	}

	delayed := open("smithers/delayed")
	server.DelayNextMerge("acme/app", delayed.Number)
	require.Equal(t, 502, merge(delayed))
	require.False(t, read(delayed.Number).Merged, "not yet: GitHub is still completing it")
	server.CompleteDelayedMerges()
	merged := read(delayed.Number)
	require.True(t, merged.Merged, "GitHub completed the merge the request asked for")
	status, _ = request(t, server, "GET", "/repos/acme/app/compare/main..."+merged.MergeCommitSHA, access.Token, nil)
	require.Equal(t, 200, status)
	require.Equal(t, 405, merge(merged))
	server.CompleteDelayedMerges()
	require.Equal(t, merged.MergeCommitSHA, read(delayed.Number).MergeCommitSHA, "completed once")

	// A delayed request is bound to the sha it named: the head moving before
	// it takes effect fails it; the head restored before then lets it merge.
	moving := open("smithers/moving")
	server.DelayNextMerge("acme/app", moving.Number)
	require.Equal(t, 502, merge(moving))
	server.UpdatePull("acme/app", moving.Number, func(p *Pull) { p.Head.SHA = strings.Repeat("b", 40) })
	server.CompleteDelayedMerges()
	require.False(t, read(moving.Number).Merged, "another head: the request merges nothing")
	restored := open("smithers/restored")
	server.DelayNextMerge("acme/app", restored.Number)
	require.Equal(t, 502, merge(restored))
	server.UpdatePull("acme/app", restored.Number, func(p *Pull) { p.Head.SHA = strings.Repeat("b", 40) })
	server.UpdatePull("acme/app", restored.Number, func(p *Pull) { p.Head.SHA = restored.Head.SHA })
	server.CompleteDelayedMerges()
	require.True(t, read(restored.Number).Merged, "the head it named again: the request merges")

	person := open("smithers/person")
	server.MergeAsPerson("acme/app", person.Number)
	require.True(t, read(person.Number).Merged)
	require.Equal(t, 405, merge(person), "the App's merge after a person's is refused")
	puts := 0
	for _, write := range server.Writes() {
		if write.Method == "PUT" {
			puts++
		}
	}
	require.Equal(t, 5, puts, "a person's merge is not an App write")
}
