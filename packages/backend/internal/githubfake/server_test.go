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
	for _, path := range []string{"/repos/acme/app/branches/main/protection", "/repos/acme/app/rules/branches/main"} {
		status, _ = request(t, server, "GET", path, token.Token, nil)
		require.Equal(t, 200, status)
	}
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
	require.Equal(t, 200, merge(pull.Head.SHA, "squash"))
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

	server.LoseNextPushResponses(1)
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
