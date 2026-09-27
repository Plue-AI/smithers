package ssh

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	gssh "github.com/gliderlabs/ssh"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type mockSSHPrincipalQuerier struct {
	getUserBySSHFingerprintFn         func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error)
	getAnyDeployKeyByFingerprint      func(ctx context.Context, fingerprint string) (db.DeployKey, error)
	getRepoByOwnerAndLowerNameFn      func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	getDeployKeyByFingerprintFn       func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error)
	touchDeployKeyLastUsedFn          func(ctx context.Context, id int64) error
	listAllProtectedBookmarksByRepoFn func(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
}

func (m *mockSSHPrincipalQuerier) GetUserBySSHFingerprint(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
	if m.getUserBySSHFingerprintFn != nil {
		return m.getUserBySSHFingerprintFn(ctx, fingerprint)
	}
	return db.GetUserBySSHFingerprintRow{}, assert.AnError
}

func (m *mockSSHPrincipalQuerier) GetAnyDeployKeyByFingerprint(ctx context.Context, fingerprint string) (db.DeployKey, error) {
	if m.getAnyDeployKeyByFingerprint != nil {
		return m.getAnyDeployKeyByFingerprint(ctx, fingerprint)
	}
	return db.DeployKey{}, assert.AnError
}

func (m *mockSSHPrincipalQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, assert.AnError
}

func (m *mockSSHPrincipalQuerier) GetDeployKeyByFingerprint(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
	if m.getDeployKeyByFingerprintFn != nil {
		return m.getDeployKeyByFingerprintFn(ctx, arg)
	}
	return db.DeployKey{}, assert.AnError
}

func (m *mockSSHPrincipalQuerier) TouchDeployKeyLastUsed(ctx context.Context, id int64) error {
	if m.touchDeployKeyLastUsedFn != nil {
		return m.touchDeployKeyLastUsedFn(ctx, id)
	}
	return nil
}

func (m *mockSSHPrincipalQuerier) ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
	if m.listAllProtectedBookmarksByRepoFn != nil {
		return m.listAllProtectedBookmarksByRepoFn(ctx, repositoryID)
	}
	return nil, nil
}

type mockSSHAuthorizer struct {
	authorizeFn func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error
}

func (m *mockSSHAuthorizer) Authorize(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
	if m.authorizeFn != nil {
		return m.authorizeFn(ctx, userID, owner, repo, mode)
	}
	return nil
}

type mockRepoHostGitProxy struct {
	proxyReceivePackFn    func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error
	proxyUploadPackFn     func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error
	proxyUploadPackBodyFn func(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error
	infoRefsUploadPackFn  func(ctx context.Context, owner, repo string) ([]byte, error)
	infoRefsReceivePackFn func(ctx context.Context, owner, repo string) ([]byte, error)
	lastReceiveMeta       repohost.ReceivePackMetadata
}

type mockSSHRepoResolver struct {
	getRepoByOwnerAndNameFn    func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	getRepoByOwnerAndNameCalls int
}

func (m *mockSSHRepoResolver) GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	m.getRepoByOwnerAndNameCalls++
	if m.getRepoByOwnerAndNameFn != nil {
		return m.getRepoByOwnerAndNameFn(ctx, arg)
	}
	return db.GetRepoByOwnerAndNameRow{}, nil
}

type mockSSHWebhookDispatcher struct {
	dispatchEventFn func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error
	dispatchCalls   int
	lastRepoID      int64
	lastEventType   webhooks.EventType
	lastPayload     any
}

type mockSSHAuditQuerier struct {
	insertAuditLogFn func(ctx context.Context, arg db.InsertAuditLogParams) error
	lastInsertArg    db.InsertAuditLogParams
	insertCalls      int
}

func (m *mockSSHAuditQuerier) InsertAuditLog(ctx context.Context, arg db.InsertAuditLogParams) error {
	m.lastInsertArg = arg
	m.insertCalls++
	if m.insertAuditLogFn != nil {
		return m.insertAuditLogFn(ctx, arg)
	}
	return nil
}

func (m *mockSSHWebhookDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.dispatchCalls++
	m.lastRepoID = repoID
	m.lastEventType = eventType
	m.lastPayload = payload
	if m.dispatchEventFn != nil {
		return m.dispatchEventFn(ctx, repoID, eventType, payload)
	}
	return nil
}

func (m *mockRepoHostGitProxy) ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
	if len(meta) > 0 {
		m.lastReceiveMeta = meta[0]
	}
	if m.proxyReceivePackFn != nil {
		return m.proxyReceivePackFn(ctx, owner, repo, stdin, stdout, meta...)
	}
	return nil
}

func (m *mockRepoHostGitProxy) ProxyUploadPack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error {
	if m.proxyUploadPackFn != nil {
		return m.proxyUploadPackFn(ctx, owner, repo, stdin, stdout)
	}
	return nil
}

func (m *mockRepoHostGitProxy) ProxyUploadPackBody(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
	if m.proxyUploadPackBodyFn != nil {
		return m.proxyUploadPackBodyFn(ctx, owner, repo, body, stdout)
	}
	return nil
}

func (m *mockRepoHostGitProxy) InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error) {
	if m.infoRefsUploadPackFn != nil {
		return m.infoRefsUploadPackFn(ctx, owner, repo)
	}
	return []byte("0000"), nil // empty refs by default
}

func (m *mockRepoHostGitProxy) InfoRefsReceivePack(ctx context.Context, owner, repo string) ([]byte, error) {
	if m.infoRefsReceivePackFn != nil {
		return m.infoRefsReceivePackFn(ctx, owner, repo)
	}
	return []byte("0000"), nil // empty refs by default
}

func TestSessionHandler_Unauthorized_DoesNotProxyGit(t *testing.T) {
	t.Parallel()

	receiveCalls := 0
	uploadCalls := 0
	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return apierrors.Forbidden("permission denied")
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				receiveCalls++
				return nil
			},
			proxyUploadPackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error {
				uploadCalls++
				return nil
			},
		},
	}

	sess := newTestSession("git-upload-pack 'bob/private.git'", "request-body")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		UserID:   42,
		Username: "alice",
	})

	server.sessionHandler(sess)

	assert.Equal(t, 0, receiveCalls)
	assert.Equal(t, 0, uploadCalls)
	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "Could not read from remote repository.")
}

func TestSessionHandler_LFSAuthenticateUserUploadIssuesScopedHTTPBase(t *testing.T) {
	t.Parallel()

	bridge, err := lfsauth.NewBridge(lfsauth.BridgeConfig{
		Secret:        "test-session-secret",
		PublicBaseURL: "https://git.smithers.test/",
		TokenTTL:      2 * time.Minute,
	})
	require.NoError(t, err)

	audit := &mockSSHAuditQuerier{}
	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				assert.Equal(t, "alice", arg.Owner)
				assert.Equal(t, "demo", arg.LowerName)
				return db.Repository{ID: 21}, nil
			},
		},
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				assert.Equal(t, int64(42), userID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, services.AccessModeWrite, mode)
				return nil
			},
		},
		LFSAuthBridge: bridge,
		AuditService:  services.NewAuditService(audit),
	}
	sess := newTestSession("git-lfs-authenticate 'alice/demo.git' upload", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 42, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 0, sess.exitCode)
	assert.Empty(t, sess.stderr.String())
	var response lfsauth.AuthenticateResponse
	require.NoError(t, json.Unmarshal(sess.stdout.Bytes(), &response))
	assert.Equal(t, "https://git.smithers.test/api/repos/alice/demo/lfs", response.Href)
	assert.NotContains(t, response.Href, "/objects/batch", "href is the LFS API base; git-lfs appends /objects/batch")
	assert.Equal(t, int64(120), response.ExpiresIn)

	authHeader := response.Header["Authorization"]
	require.True(t, strings.HasPrefix(authHeader, lfsauth.AuthorizationScheme+" "))
	claims, err := bridge.Manager().Verify(strings.TrimPrefix(authHeader, lfsauth.AuthorizationScheme+" "))
	require.NoError(t, err)
	assert.Equal(t, int64(21), claims.RepositoryID)
	assert.Equal(t, "alice", claims.Owner)
	assert.Equal(t, "demo", claims.Repository)
	assert.Equal(t, lfsauth.OperationUpload, claims.Operation)
	assert.Equal(t, lfsauth.PrincipalUser, claims.Principal)
	require.Equal(t, 1, audit.insertCalls)
	assert.Equal(t, "ssh.lfs_credential", audit.lastInsertArg.EventType)
	assert.Equal(t, "repository", audit.lastInsertArg.TargetType)
	assert.True(t, audit.lastInsertArg.TargetID.Valid)
	assert.Equal(t, int64(21), audit.lastInsertArg.TargetID.Int64)
	assert.Equal(t, "alice/demo", audit.lastInsertArg.TargetName)
	assert.Equal(t, "issue", audit.lastInsertArg.Action)
	assert.True(t, audit.lastInsertArg.ActorID.Valid)
	assert.Equal(t, int64(42), audit.lastInsertArg.ActorID.Int64)
	var auditMetadata map[string]any
	require.NoError(t, json.Unmarshal(audit.lastInsertArg.Metadata, &auditMetadata))
	assert.Equal(t, "upload", auditMetadata["operation"])
	assert.Equal(t, "user", auditMetadata["principal_type"])
	assert.NotEmpty(t, auditMetadata["session_id"])
	assert.NotNil(t, auditMetadata["duration_ms"])
}

func TestSessionHandler_LFSAuthenticateDeployKeyDownload(t *testing.T) {
	t.Parallel()

	bridge, err := lfsauth.NewBridge(lfsauth.BridgeConfig{
		Secret:        "test-session-secret",
		PublicBaseURL: "https://git.smithers.test",
	})
	require.NoError(t, err)
	repoLookups := 0
	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				repoLookups++
				return db.Repository{ID: 21}, nil
			},
			getDeployKeyByFingerprintFn: func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
				assert.Equal(t, int64(21), arg.RepositoryID)
				assert.Equal(t, "SHA256:deploy", arg.KeyFingerprint)
				return db.DeployKey{ID: 9, Title: "CI", ReadOnly: true}, nil
			},
		},
		LFSAuthBridge: bridge,
	}
	sess := newTestSession("git-lfs-authenticate 'alice/demo.git' download", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		Username:    "deploy-key",
		Fingerprint: "SHA256:deploy",
		IsDeployKey: true,
	})

	server.sessionHandler(sess)

	assert.Equal(t, 0, sess.exitCode)
	assert.Empty(t, sess.stderr.String())
	assert.Equal(t, 2, repoLookups, "authorization and credential issuance both resolve the repository")
	var response lfsauth.AuthenticateResponse
	require.NoError(t, json.Unmarshal(sess.stdout.Bytes(), &response))
	authHeader := response.Header["Authorization"]
	claims, err := bridge.Manager().Verify(strings.TrimPrefix(authHeader, lfsauth.AuthorizationScheme+" "))
	require.NoError(t, err)
	assert.Equal(t, lfsauth.OperationDownload, claims.Operation)
	assert.Equal(t, lfsauth.PrincipalDeployKey, claims.Principal)
}

func TestSessionHandler_LFSAuthenticateReadOnlyDeployKeyCannotUpload(t *testing.T) {
	t.Parallel()

	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 21}, nil
			},
			getDeployKeyByFingerprintFn: func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
				return db.DeployKey{ID: 9, Title: "CI", ReadOnly: true}, nil
			},
		},
	}
	sess := newTestSession("git-lfs-authenticate 'alice/demo.git' upload", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		Username:    "deploy-key",
		Fingerprint: "SHA256:deploy",
		IsDeployKey: true,
	})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Empty(t, sess.stdout.String(), "denied sessions must not receive a credential")
	assert.Contains(t, sess.stderr.String(), "Could not read from remote repository")
}

func TestSessionHandler_LFSAuthenticateRejectsRepositoryIdentitySwap(t *testing.T) {
	t.Parallel()

	bridge, err := lfsauth.NewBridge(lfsauth.BridgeConfig{
		Secret:        "test-session-secret",
		PublicBaseURL: "https://git.smithers.test",
	})
	require.NoError(t, err)
	lookup := 0
	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				lookup++
				if lookup == 1 {
					return db.Repository{ID: 21}, nil
				}
				return db.Repository{ID: 22}, nil
			},
		},
		Authorizer:    &mockSSHAuthorizer{},
		LFSAuthBridge: bridge,
	}
	sess := newTestSession("git-lfs-authenticate 'alice/demo.git' upload", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 42, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 2, lookup)
	assert.Equal(t, 1, sess.exitCode)
	assert.Empty(t, sess.stdout.String(), "a renamed replacement repository must never receive the original authorization")
	assert.Contains(t, sess.stderr.String(), "Could not read from remote repository")
}

func TestSessionHandler_LFSAuthenticateRejectsUnknownOperation(t *testing.T) {
	t.Parallel()

	server := &Server{}
	sess := newTestSession("git-lfs-authenticate 'alice/demo.git' delete", "")

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Empty(t, sess.stdout.String())
	assert.Contains(t, sess.stderr.String(), "invalid Git LFS operation")
}

func TestAuditAuthFailure_EmitsFailureAuditEvent(t *testing.T) {
	t.Parallel()

	q := &mockSSHAuditQuerier{}
	server := &Server{
		AuditService: services.NewAuditService(q),
	}

	server.auditAuthFailure(context.Background(), "SHA256:deadbeef", "203.0.113.10")

	require.Equal(t, 1, q.insertCalls)
	assert.Equal(t, "ssh.auth", q.lastInsertArg.EventType)
	assert.False(t, q.lastInsertArg.ActorID.Valid)
	assert.Empty(t, q.lastInsertArg.ActorName)
	assert.Equal(t, "failure", q.lastInsertArg.Action)
	assert.Equal(t, "203.0.113.10", q.lastInsertArg.IpAddress)
	assert.JSONEq(t, `{"fingerprint":"SHA256:deadbeef"}`, string(q.lastInsertArg.Metadata))
}

func TestSessionHandler_AuthorizedUploadPack_ProxiesStream(t *testing.T) {
	t.Parallel()

	receiveCalls := 0
	uploadBodyCalls := 0
	// Simulate a git client sending a want + done via pkt-line protocol
	// "0032want abcdef1234567890abcdef1234567890abcdef12\n00000009done\n"
	wantLine := "want abcdef1234567890abcdef1234567890abcdef12\n"
	wantPkt := fmt.Sprintf("%04x%s", len(wantLine)+4, wantLine)
	clientInput := wantPkt + "0000" + "0009done\n"
	refAdvertisement := []byte("003f1234567890abcdef1234567890abcdef12345678 refs/heads/main\n0000")

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				assert.Equal(t, int64(1), userID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, services.AccessModeRead, mode)
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				receiveCalls++
				return nil
			},
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				return refAdvertisement, nil
			},
			proxyUploadPackBodyFn: func(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
				uploadBodyCalls++
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				_, err := io.WriteString(stdout, "upload-pack-response")
				require.NoError(t, err)
				return nil
			},
		},
	}

	sess := newTestSession("git-upload-pack 'alice/demo.git'", clientInput)
	sess.ctx.SetValue(principalKey, sshPrincipal{
		UserID:   1,
		Username: "alice",
	})

	server.sessionHandler(sess)

	assert.Equal(t, 0, receiveCalls)
	assert.Equal(t, 1, uploadBodyCalls)
	// stdout should contain ref advertisement + upload-pack response
	assert.Contains(t, sess.stdout.String(), "refs/heads/main")
	assert.Contains(t, sess.stdout.String(), "upload-pack-response")
	assert.Empty(t, sess.stderr.String())
	assert.Equal(t, 0, sess.exitCode)
}

func TestSessionHandler_UploadPackRequestExceedsLimit_ReturnsFatal(t *testing.T) {
	t.Parallel()

	uploadBodyCalls := 0
	wantLine := "want abcdef1234567890abcdef1234567890abcdef12\n"
	wantPkt := fmt.Sprintf("%04x%s", len(wantLine)+4, wantLine)
	clientInput := wantPkt + "0000" + "0009done\n"

	server := &Server{
		MaxUploadPackRequestSize: 12,
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyUploadPackBodyFn: func(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
				uploadBodyCalls++
				return nil
			},
		},
	}

	sess := newTestSession("git-upload-pack 'alice/demo.git'", clientInput)
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 0, uploadBodyCalls)
	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "fatal: request exceeds maximum allowed size")
	assert.NotContains(t, sess.stderr.String(), "ERROR: repository operation failed")
}

func TestSessionHandler_UploadPackRequestAtLimit_ProxiesStream(t *testing.T) {
	t.Parallel()

	uploadBodyCalls := 0
	clientInput := "0009done\n"

	server := &Server{
		MaxUploadPackRequestSize: int64(len(clientInput)),
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyUploadPackBodyFn: func(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
				uploadBodyCalls++
				return nil
			},
		},
	}

	sess := newTestSession("git-upload-pack 'alice/demo.git'", clientInput)
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, uploadBodyCalls)
	assert.Equal(t, 0, sess.exitCode)
}

func TestSessionHandler_AuthorizedReceivePack_ProxiesStream(t *testing.T) {
	t.Parallel()

	receiveCalls := 0
	uploadCalls := 0
	refAdvertisement := []byte("003f1234567890abcdef1234567890abcdef12345678 refs/heads/main\n0000")

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				assert.Equal(t, int64(1), userID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, services.AccessModeWrite, mode)
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return refAdvertisement, nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				receiveCalls++
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				body, err := io.ReadAll(stdin)
				require.NoError(t, err)
				assert.Equal(t, "0000receive-pack-request", string(body))
				_, err = io.WriteString(stdout, "receive-pack-response")
				require.NoError(t, err)
				return nil
			},
			proxyUploadPackBodyFn: func(ctx context.Context, owner, repo string, body io.Reader, stdout io.Writer) error {
				uploadCalls++
				return nil
			},
		},
	}

	sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		UserID:   1,
		Username: "alice",
	})

	server.sessionHandler(sess)

	assert.Equal(t, 1, receiveCalls)
	assert.Equal(t, 0, uploadCalls)
	// stdout should contain ref advertisement + receive-pack response
	assert.Contains(t, sess.stdout.String(), "refs/heads/main")
	assert.Contains(t, sess.stdout.String(), "receive-pack-response")
	assert.Empty(t, sess.stderr.String())
	assert.Equal(t, 0, sess.exitCode)
}

func TestSessionHandler_AuthorizedReceivePack_Success(t *testing.T) {
	t.Parallel()

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				_, err := io.Copy(io.Discard, stdin)
				return err
			},
		},
	}

	sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		UserID:   1,
		Username: "alice",
	})

	server.sessionHandler(sess)

	assert.Equal(t, 0, sess.exitCode)
}

func TestSessionHandler_ReceivePack_ProxyFailure(t *testing.T) {
	t.Parallel()

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				return stdErrors.New("repo-host unavailable")
			},
		},
	}

	sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		UserID:   1,
		Username: "alice",
	})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "ERROR: repository operation failed")
}

func TestSessionHandler_AuthorizedReceivePack_CompletesSuccessfully(t *testing.T) {
	t.Parallel()

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				_, err := io.Copy(io.Discard, stdin)
				return err
			},
		},
	}

	sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		UserID:   1,
		Username: "alice",
	})

	server.sessionHandler(sess)

	assert.Equal(t, 0, sess.exitCode)
}

func TestSessionHandler_AuthorizedReceivePack_ForwardsPusherMetadata(t *testing.T) {
	t.Parallel()

	var capturedMeta repohost.ReceivePackMetadata
	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				if len(meta) > 0 {
					capturedMeta = meta[0]
				}
				_, _ = io.Copy(io.Discard, stdin)
				return nil
			},
		},
	}

	sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		UserID:   42,
		Username: "alice",
	})

	server.sessionHandler(sess)

	assert.Equal(t, 0, sess.exitCode)
	// Verify pusher identity was forwarded to repo-host
	assert.Equal(t, int64(42), capturedMeta.PusherID)
	assert.Equal(t, "alice", capturedMeta.PusherLogin)
}

func TestSessionHandler_ReceivePackRequestExceedsLimit_ReturnsFatal(t *testing.T) {
	t.Parallel()

	server := &Server{
		MaxReceivePackSize: 10,
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				_, _ = io.Copy(io.Discard, stdin)
				return nil
			},
		},
	}

	// Flush packet (empty command section) + 11 bytes of pack data: 15 bytes
	// total, over the 10-byte cap.
	sess := newTestSession("git-receive-pack 'alice/demo.git'", "000001234567890")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "fatal: request exceeds maximum allowed size")
	assert.NotContains(t, sess.stderr.String(), "ERROR: repository operation failed")
}

func TestSessionHandler_ReceivePackRequestAtLimit_ProxiesStream(t *testing.T) {
	t.Parallel()

	receiveCalls := 0
	server := &Server{
		MaxReceivePackSize: 10,
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				receiveCalls++
				body, err := io.ReadAll(stdin)
				require.NoError(t, err)
				assert.Equal(t, "0000123456", string(body))
				return nil
			},
		},
	}

	// Flush packet (empty command section) + 6 bytes of pack data: exactly the
	// 10-byte cap.
	sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000123456")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, receiveCalls)
	assert.Equal(t, 0, sess.exitCode)
}

func TestProxyReceivePack_StreamsBeforeClientEOF(t *testing.T) {
	t.Parallel()

	refAdvertisement := []byte("0000")
	// The first chunk opens with a flush packet so the fail-closed
	// protected-bookmark peek sees an empty command section and replays the
	// stream unchanged.
	firstChunk := []byte("0000chunk-one")
	secondChunk := []byte("chunk-two")
	pipeReader, pipeWriter := io.Pipe()

	proxyStarted := make(chan struct{})
	firstChunkRead := make(chan struct{})
	errCh := make(chan error, 1)

	server := &Server{
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return refAdvertisement, nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				close(proxyStarted)
				buf := make([]byte, len(firstChunk))
				_, err := io.ReadFull(stdin, buf)
				require.NoError(t, err)
				assert.Equal(t, firstChunk, buf)
				close(firstChunkRead)

				rest, err := io.ReadAll(stdin)
				require.NoError(t, err)
				assert.Equal(t, secondChunk, rest)

				_, err = io.WriteString(stdout, "receive-pack-response")
				require.NoError(t, err)
				return nil
			},
		},
	}

	sess := newTestSessionWithReader("git-receive-pack 'alice/demo.git'", pipeReader)
	principal := sshPrincipal{UserID: 1, Username: "alice"}

	go func() {
		errCh <- server.proxyReceivePack(context.Background(), sess, "alice", "demo", principal)
	}()

	_, err := pipeWriter.Write(firstChunk)
	require.NoError(t, err)

	select {
	case <-proxyStarted:
	case <-time.After(250 * time.Millisecond):
		_ = pipeWriter.Close()
		<-errCh
		t.Fatalf("proxy receive-pack did not start before client EOF")
	}

	select {
	case <-firstChunkRead:
	case <-time.After(250 * time.Millisecond):
		_ = pipeWriter.Close()
		<-errCh
		t.Fatalf("proxy receive-pack did not consume first chunk before client EOF")
	}

	_, err = pipeWriter.Write(secondChunk)
	require.NoError(t, err)
	require.NoError(t, pipeWriter.Close())
	require.NoError(t, <-errCh)

	assert.Equal(t, string(refAdvertisement)+"receive-pack-response", sess.stdout.String())
}

// The configured timeout bounds the wait for the repository; once the push
// starts it has the timeout afresh.
func TestProxyReceivePack_UsesConfiguredTimeoutContext(t *testing.T) {
	t.Parallel()

	for _, starts := range []bool{false, true} {
		var outcome string
		server := &Server{
			ReceivePackTimeout: 200 * time.Millisecond,
			RepoHostClient: &mockRepoHostGitProxy{
				infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
					return []byte("0000"), nil
				},
				proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
					body, err := io.ReadAll(stdin)
					if err != nil || string(body) != "0000receive-pack-request" {
						return fmt.Errorf("unexpected body %q: %v", body, err)
					}
					if starts {
						time.Sleep(150 * time.Millisecond)
						repohost.PushStarted(ctx)
					}
					select {
					case <-ctx.Done():
						outcome = "cancelled"
						return ctx.Err()
					case <-time.After(300 * time.Millisecond):
						outcome = "alive"
						return nil
					}
				},
			},
		}
		sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
		principal := sshPrincipal{UserID: 1, Username: "alice"}
		err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", principal)
		if starts {
			require.NoError(t, err)
			assert.Equal(t, "alive", outcome, "the timeout did not start afresh with the push")
		} else {
			require.Error(t, err)
			assert.Equal(t, "cancelled", outcome, "the wait outlived the timeout")
		}
	}
}

func TestServer_ReceivePackTimeout_DefaultWhenUnset(t *testing.T) {
	t.Parallel()

	server := &Server{}
	assert.Equal(t, defaultReceivePackTimeout, server.receivePackTimeout())
}

func TestSessionHandler_AuthorizedReceivePack_StreamsLargePayloadBeforeEOF(t *testing.T) {
	t.Parallel()

	// A flush packet opens the stream so the fail-closed protected-bookmark
	// peek sees an empty command section and replays the payload unchanged.
	firstChunk := append([]byte("0000"), bytes.Repeat([]byte("a"), 1<<20)...)
	secondChunk := bytes.Repeat([]byte("b"), 10<<20)
	totalLen := len(firstChunk) + len(secondChunk)

	pipeReader, pipeWriter := io.Pipe()
	proxyStarted := make(chan struct{})
	firstChunkRead := make(chan struct{})
	var received int

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				close(proxyStarted)
				head := make([]byte, len(firstChunk))
				_, err := io.ReadFull(stdin, head)
				require.NoError(t, err)
				assert.Equal(t, firstChunk, head)
				received += len(head)
				close(firstChunkRead)

				tail, err := io.ReadAll(stdin)
				require.NoError(t, err)
				received += len(tail)
				assert.Equal(t, totalLen, received)
				_, err = io.WriteString(stdout, "ok")
				require.NoError(t, err)
				return nil
			},
		},
	}

	sess := newTestSessionWithReader("git-receive-pack 'alice/demo.git'", pipeReader)
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	done := make(chan struct{})
	go func() {
		server.sessionHandler(sess)
		close(done)
	}()

	_, err := pipeWriter.Write(firstChunk)
	require.NoError(t, err)

	select {
	case <-proxyStarted:
	case <-time.After(250 * time.Millisecond):
		_ = pipeWriter.Close()
		<-done
		t.Fatalf("session handler did not start proxy receive-pack before EOF")
	}

	select {
	case <-firstChunkRead:
	case <-time.After(250 * time.Millisecond):
		_ = pipeWriter.Close()
		<-done
		t.Fatalf("session handler did not stream first receive-pack chunk before EOF")
	}

	_, err = pipeWriter.Write(secondChunk)
	require.NoError(t, err)
	require.NoError(t, pipeWriter.Close())
	<-done

	assert.Equal(t, 0, sess.exitCode)
	assert.Equal(t, "0000ok", sess.stdout.String())
}

func TestSessionHandler_RepoHostProxyFailure_ExitsNonZero(t *testing.T) {
	t.Parallel()

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				return nil, stdErrors.New("repo-host unavailable")
			},
		},
	}

	sess := newTestSession("git-upload-pack 'alice/demo.git'", "upload-pack-request")
	sess.ctx.SetValue(principalKey, sshPrincipal{
		UserID:   1,
		Username: "alice",
	})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "ERROR: repository operation failed")
	assert.NotContains(t, sess.stderr.String(), "repo-host unavailable")
}

func TestSessionHandler_UsesSessionContextForAuthorize(t *testing.T) {
	t.Parallel()

	type markerKey struct{}
	marker := markerKey{}
	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				assert.Equal(t, "marker-value", ctx.Value(marker))
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsUploadPackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				assert.Equal(t, "marker-value", ctx.Value(marker))
				// Return empty refs so no wants are sent
				return []byte("0000"), nil
			},
		},
	}

	sess := newTestSession("git-upload-pack 'alice/demo.git'", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})
	sess.ctx.SetValue(marker, "marker-value")

	server.sessionHandler(sess)

	assert.Equal(t, 0, sess.exitCode)
}

func TestSessionHandler_EmptyCommand_DeniesInteractiveShell(t *testing.T) {
	t.Parallel()

	server := &Server{}
	sess := newTestSession("", "")

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "interactive shell not supported")
}

func TestSessionHandler_InvalidCommandFormat(t *testing.T) {
	t.Parallel()

	server := &Server{}
	sess := newTestSession("git-upload-pack", "")

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "invalid command")
}

func TestSessionHandler_InvalidRepositoryPath(t *testing.T) {
	t.Parallel()

	server := &Server{}
	sess := newTestSession("git-upload-pack 'alice/demo/extra.git'", "")

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "invalid repository path")
}

func TestSessionHandler_MissingPrincipal_Denied(t *testing.T) {
	t.Parallel()

	server := &Server{}
	sess := newTestSession("git-upload-pack 'alice/demo.git'", "")

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "permission denied")
}

func TestSessionHandler_NilAuthorizer_Denied(t *testing.T) {
	t.Parallel()

	server := &Server{}
	sess := newTestSession("git-upload-pack 'alice/demo.git'", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "permission denied")
}

func TestSessionHandler_AuthorizerUnexpectedError_Denied(t *testing.T) {
	t.Parallel()

	uploadCalls := 0
	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return stdErrors.New("authorization backend unavailable")
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			proxyUploadPackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error {
				uploadCalls++
				return nil
			},
		},
	}

	sess := newTestSession("git-upload-pack 'alice/demo.git'", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Equal(t, 0, uploadCalls)
	assert.Contains(t, sess.stderr.String(), "permission denied")
}

func TestSessionHandler_NilRepoHostClient_InternalError(t *testing.T) {
	t.Parallel()

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
	}

	sess := newTestSession("git-upload-pack 'alice/demo.git'", "")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "internal server error")
}

func TestProxyGitCommand_UnsupportedCommand(t *testing.T) {
	t.Parallel()

	server := &Server{RepoHostClient: &mockRepoHostGitProxy{}}
	sess := newTestSession("git-upload-pack 'alice/demo.git'", "")
	principal := sshPrincipal{UserID: 1, Username: "alice"}

	err := server.proxyGitCommand(context.Background(), sess, "git-upload-archive", "alice", "demo", principal)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported git command")
}

func TestPublicKeyHandler_StoresPrincipalInContext(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	sshPub, err := gossh.NewPublicKey(pub)
	require.NoError(t, err)

	hash := sha256.Sum256(sshPub.Marshal())
	expectedFingerprint := "SHA256:" + base64.RawStdEncoding.EncodeToString(hash[:])

	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				assert.IsType(t, &testSSHContext{}, ctx)
				assert.Equal(t, expectedFingerprint, fingerprint)
				return db.GetUserBySSHFingerprintRow{
					UserID:   7,
					Username: "alice",
				}, nil
			},
		},
	}

	ctx := newTestSSHContext()
	ok := server.publicKeyHandler(ctx, sshPub)
	require.True(t, ok)

	value := ctx.Value(principalKey)
	require.NotNil(t, value)

	principal, ok := value.(sshPrincipal)
	require.True(t, ok)
	assert.Equal(t, int64(7), principal.UserID)
	assert.Equal(t, "alice", principal.Username)
}

func TestPublicKeyHandler_AcceptsDeployKeyFingerprint(t *testing.T) {
	t.Parallel()

	pub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	sshPub, err := gossh.NewPublicKey(pub)
	require.NoError(t, err)

	hash := sha256.Sum256(sshPub.Marshal())
	expectedFingerprint := "SHA256:" + base64.RawStdEncoding.EncodeToString(hash[:])

	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				assert.Equal(t, expectedFingerprint, fingerprint)
				return db.GetUserBySSHFingerprintRow{}, pgx.ErrNoRows
			},
			getAnyDeployKeyByFingerprint: func(ctx context.Context, fingerprint string) (db.DeployKey, error) {
				assert.Equal(t, expectedFingerprint, fingerprint)
				return db.DeployKey{ID: 9}, nil
			},
		},
	}

	ctx := newTestSSHContext()
	ok := server.publicKeyHandler(ctx, sshPub)
	require.True(t, ok)

	value := ctx.Value(principalKey)
	require.NotNil(t, value)

	principal, ok := value.(sshPrincipal)
	require.True(t, ok)
	assert.True(t, principal.IsDeployKey)
	assert.Equal(t, expectedFingerprint, principal.Fingerprint)
	assert.Equal(t, "deploy-key", principal.Username)
}

func TestAuthorizePrincipal_DeployKeyAllowsMatchingRepoRead(t *testing.T) {
	t.Parallel()

	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				assert.Equal(t, "alice", arg.Owner)
				assert.Equal(t, "demo", arg.LowerName)
				return db.Repository{ID: 21, IsArchived: false}, nil
			},
			getDeployKeyByFingerprintFn: func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
				assert.Equal(t, int64(21), arg.RepositoryID)
				assert.Equal(t, "SHA256:key", arg.KeyFingerprint)
				return db.DeployKey{ID: 4, Title: "CI", ReadOnly: true}, nil
			},
		},
	}

	principal, err := server.authorizePrincipal(context.Background(), sshPrincipal{
		Username:    "deploy-key",
		Fingerprint: "SHA256:key",
		IsDeployKey: true,
	}, " Alice ", "demo", services.AccessModeRead)
	require.NoError(t, err)
	assert.True(t, principal.IsDeployKey)
	assert.Equal(t, "deploy-key:CI", principal.Username)
}

func TestAuthorizePrincipal_DeployKeyWriteDeniedWhenReadOnly(t *testing.T) {
	t.Parallel()

	server := &Server{
		Queries: &mockSSHPrincipalQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 21, IsArchived: false}, nil
			},
			getDeployKeyByFingerprintFn: func(ctx context.Context, arg db.GetDeployKeyByFingerprintParams) (db.DeployKey, error) {
				return db.DeployKey{ID: 4, Title: "CI", ReadOnly: true}, nil
			},
		},
	}

	_, err := server.authorizePrincipal(context.Background(), sshPrincipal{
		Username:    "deploy-key",
		Fingerprint: "SHA256:key",
		IsDeployKey: true,
	}, "alice", "demo", services.AccessModeWrite)
	require.Error(t, err)

	apiErr, ok := err.(*apierrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 403, apiErr.Status)
}

func TestPublicKeyHandler_AuthLimiterThrottlesPerIP(t *testing.T) {
	t.Parallel()

	pub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	sshPub, err := gossh.NewPublicKey(pub)
	require.NoError(t, err)

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	dbLookups := 0
	server := &Server{
		AuthLimiter: NewAuthLimiter(AuthLimiterConfig{
			AttemptsPerMinute: 1,
			MaxAuthFailures:   5,
			InitialBan:        15 * time.Minute,
			MaxBan:            24 * time.Hour,
			Now: func() time.Time {
				return now
			},
		}),
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				dbLookups++
				return db.GetUserBySSHFingerprintRow{
					UserID:   1,
					Username: "alice",
				}, nil
			},
		},
	}

	ctxOne := newTestSSHContextWithRemoteAddr("203.0.113.7:2222")
	assert.True(t, server.publicKeyHandler(ctxOne, sshPub))
	assert.Equal(t, 1, dbLookups)

	ctxTwo := newTestSSHContextWithRemoteAddr("203.0.113.7:2223")
	assert.False(t, server.publicKeyHandler(ctxTwo, sshPub))
	assert.Equal(t, 1, dbLookups, "throttled request should not query DB")
}

func TestPublicKeyHandler_AuthLimiterBansAfterFailures(t *testing.T) {
	t.Parallel()

	pub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	sshPub, err := gossh.NewPublicKey(pub)
	require.NoError(t, err)

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	dbLookups := 0
	server := &Server{
		AuthLimiter: NewAuthLimiter(AuthLimiterConfig{
			AttemptsPerMinute: 20,
			MaxAuthFailures:   2,
			InitialBan:        10 * time.Second,
			MaxBan:            time.Minute,
			Now: func() time.Time {
				return now
			},
		}),
		WorkspaceBridge: &stubWorkspaceBridge{},
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(context.Context, string) (db.GetUserBySSHFingerprintRow, error) {
				return db.GetUserBySSHFingerprintRow{}, pgx.ErrNoRows
			},
			getAnyDeployKeyByFingerprint: func(context.Context, string) (db.DeployKey, error) {
				return db.DeployKey{ID: 1}, nil
			},
		},
	}

	// A deploy key presented for a workspace shell is a genuine credential failure.
	ctx := newAuthTestContext("198.51.100.15:2222", "msb_test+developer:"+outageTestToken)
	assert.False(t, server.publicKeyHandler(ctx, sshPub))
	assert.False(t, server.publicKeyHandler(ctx, sshPub))

	server.Queries = &mockSSHPrincipalQuerier{
		getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
			dbLookups++
			return db.GetUserBySSHFingerprintRow{UserID: 7, Username: "alice"}, nil
		},
	}
	assert.False(t, server.publicKeyHandler(ctx, sshPub))
	assert.Equal(t, 0, dbLookups, "banned request should not query DB")

	now = now.Add(11 * time.Second)
	assert.True(t, server.publicKeyHandler(ctx, sshPub))
	assert.Equal(t, 1, dbLookups, "lookup should resume after ban expires")
}

func TestPublicKeyHandler_UnknownOfferedKeysDoNotTripAuthLimiter(t *testing.T) {
	t.Parallel()

	pubOne, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	unknownOne, err := gossh.NewPublicKey(pubOne)
	require.NoError(t, err)
	pubTwo, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	unknownTwo, err := gossh.NewPublicKey(pubTwo)
	require.NoError(t, err)
	pubThree, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	validKey, err := gossh.NewPublicKey(pubThree)
	require.NoError(t, err)

	validHash := sha256.Sum256(validKey.Marshal())
	validFingerprint := "SHA256:" + base64.RawStdEncoding.EncodeToString(validHash[:])

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	userLookups := 0
	deployLookups := 0
	server := &Server{
		AuthLimiter: NewAuthLimiter(AuthLimiterConfig{
			AttemptsPerMinute: 20,
			MaxAuthFailures:   2,
			InitialBan:        10 * time.Second,
			MaxBan:            time.Minute,
			Now: func() time.Time {
				return now
			},
		}),
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				userLookups++
				if fingerprint == validFingerprint {
					return db.GetUserBySSHFingerprintRow{UserID: 7, Username: "alice"}, nil
				}
				return db.GetUserBySSHFingerprintRow{}, pgx.ErrNoRows
			},
			getAnyDeployKeyByFingerprint: func(ctx context.Context, fingerprint string) (db.DeployKey, error) {
				deployLookups++
				return db.DeployKey{}, pgx.ErrNoRows
			},
		},
	}

	ctx := newTestSSHContextWithRemoteAddr("198.51.100.16:2222")
	assert.False(t, server.publicKeyHandler(ctx, unknownOne))
	assert.False(t, server.publicKeyHandler(ctx, unknownTwo))
	assert.True(t, server.publicKeyHandler(ctx, validKey))
	assert.Equal(t, 3, userLookups)
	assert.Equal(t, 2, deployLookups)
}

func TestPublicKeyHandler_LookupErrorsDoNotTripAuthLimiter(t *testing.T) {
	t.Parallel()

	pub, _, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	sshPub, err := gossh.NewPublicKey(pub)
	require.NoError(t, err)

	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	userLookups := 0
	server := &Server{
		AuthLimiter: NewAuthLimiter(AuthLimiterConfig{
			AttemptsPerMinute: 20,
			MaxAuthFailures:   2,
			InitialBan:        10 * time.Second,
			MaxBan:            time.Minute,
			Now: func() time.Time {
				return now
			},
		}),
		Queries: &mockSSHPrincipalQuerier{
			getUserBySSHFingerprintFn: func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
				userLookups++
				if userLookups <= 2 {
					return db.GetUserBySSHFingerprintRow{}, stdErrors.New("temporary database error")
				}
				return db.GetUserBySSHFingerprintRow{UserID: 7, Username: "alice"}, nil
			},
		},
	}

	ctx := newTestSSHContextWithRemoteAddr("198.51.100.17:2222")
	assert.False(t, server.publicKeyHandler(ctx, sshPub))
	assert.False(t, server.publicKeyHandler(ctx, sshPub))
	assert.True(t, server.publicKeyHandler(ctx, sshPub))
	assert.Equal(t, 3, userLookups)
}

func TestParseRepoPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		path        string
		wantOwner   string
		wantRepo    string
		expectValid bool
	}{
		{
			name:        "valid owner repo git suffix",
			path:        "alice/demo.git",
			wantOwner:   "alice",
			wantRepo:    "demo",
			expectValid: true,
		},
		{
			name:        "valid with leading slash",
			path:        "/alice/demo.git",
			wantOwner:   "alice",
			wantRepo:    "demo",
			expectValid: true,
		},
		{
			name:        "invalid owner only",
			path:        "alice",
			expectValid: false,
		},
		{
			name:        "invalid extra slash in repo segment",
			path:        "alice/demo/extra.git",
			expectValid: false,
		},
		{
			name:        "invalid owner traversal",
			path:        "../demo.git",
			expectValid: false,
		},
		{
			name:        "invalid repo traversal",
			path:        "alice/..",
			expectValid: false,
		},
		{
			name:        "invalid encoded slash sequence",
			path:        "alice/demo%2Fextra.git",
			expectValid: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			owner, repo := parseRepoPath(tc.path)

			if !tc.expectValid {
				assert.Equal(t, "", owner)
				assert.Equal(t, "", repo)
				return
			}

			assert.Equal(t, tc.wantOwner, owner)
			assert.Equal(t, tc.wantRepo, repo)
		})
	}
}

func TestConnCallback_TotalLimit(t *testing.T) {
	t.Parallel()

	server := &Server{
		MaxConnections: 2,
	}

	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()

	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()

	ctx3, cancel3 := context.WithCancel(context.Background())
	defer cancel3()

	conn1 := &testNetConn{remote: &net.TCPAddr{IP: net.ParseIP("192.168.1.10"), Port: 1001}}
	conn2 := &testNetConn{remote: &net.TCPAddr{IP: net.ParseIP("192.168.1.11"), Port: 1002}}
	conn3 := &testNetConn{remote: &net.TCPAddr{IP: net.ParseIP("192.168.1.12"), Port: 1003}}

	require.NotNil(t, server.connCallback(newTestSSHContextWithContext(ctx1), conn1))
	require.NotNil(t, server.connCallback(newTestSSHContextWithContext(ctx2), conn2))
	assert.Nil(t, server.connCallback(newTestSSHContextWithContext(ctx3), conn3))

	assertConnState(t, server, 2, map[string]int{
		"192.168.1.10": 1,
		"192.168.1.11": 1,
	})

	cancel1()
	require.Eventually(t, func() bool {
		server.connMu.Lock()
		defer server.connMu.Unlock()
		return server.activeConns == 1
	}, time.Second, 10*time.Millisecond)

	require.NotNil(t, server.connCallback(newTestSSHContextWithContext(ctx3), conn3))
	assertConnState(t, server, 2, map[string]int{
		"192.168.1.11": 1,
		"192.168.1.12": 1,
	})
}

func TestConnCallback_PerIPLimit(t *testing.T) {
	t.Parallel()

	server := &Server{
		MaxConnectionsPerIP: 2,
	}

	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	ctx3, cancel3 := context.WithCancel(context.Background())
	defer cancel3()
	ctx4, cancel4 := context.WithCancel(context.Background())
	defer cancel4()

	conn1 := &testNetConn{remote: &net.TCPAddr{IP: net.ParseIP("192.168.1.1"), Port: 2001}}
	conn2 := &testNetConn{remote: &net.TCPAddr{IP: net.ParseIP("192.168.1.1"), Port: 2002}}
	conn3 := &testNetConn{remote: &net.TCPAddr{IP: net.ParseIP("192.168.1.1"), Port: 2003}}
	conn4 := &testNetConn{remote: &net.TCPAddr{IP: net.ParseIP("10.0.0.1"), Port: 3001}}

	require.NotNil(t, server.connCallback(newTestSSHContextWithContext(ctx1), conn1))
	require.NotNil(t, server.connCallback(newTestSSHContextWithContext(ctx2), conn2))
	assert.Nil(t, server.connCallback(newTestSSHContextWithContext(ctx3), conn3))
	require.NotNil(t, server.connCallback(newTestSSHContextWithContext(ctx4), conn4))

	assertConnState(t, server, 3, map[string]int{
		"192.168.1.1": 2,
		"10.0.0.1":    1,
	})
}

func assertConnState(t *testing.T, server *Server, wantTotal int, wantPerIP map[string]int) {
	t.Helper()

	server.connMu.Lock()
	defer server.connMu.Unlock()

	assert.Equal(t, wantTotal, server.activeConns)
	assert.Equal(t, wantPerIP, server.activeConnsPerIP)
}

type testSSHContext struct {
	context.Context
	mu         sync.Mutex
	values     map[any]any
	remoteAddr net.Addr
}

func newTestSSHContext() *testSSHContext {
	return newTestSSHContextWithContext(context.Background())
}

func newTestSSHContextWithContext(ctx context.Context) *testSSHContext {
	return &testSSHContext{
		Context: ctx,
		values:  map[any]any{},
	}
}

func newTestSSHContextWithRemoteAddr(addr string) *testSSHContext {
	ctx := newTestSSHContext()
	tcpAddr, err := net.ResolveTCPAddr("tcp", addr)
	if err == nil {
		ctx.remoteAddr = tcpAddr
	}
	return ctx
}

func (c *testSSHContext) Lock() {
	c.mu.Lock()
}

func (c *testSSHContext) Unlock() {
	c.mu.Unlock()
}

func (c *testSSHContext) Value(key any) any {
	if value, ok := c.values[key]; ok {
		return value
	}
	return c.Context.Value(key)
}

func (c *testSSHContext) User() string { return "git" }

func (c *testSSHContext) SessionID() string { return "session" }

func (c *testSSHContext) ClientVersion() string { return "client" }

func (c *testSSHContext) ServerVersion() string { return "server" }

func (c *testSSHContext) RemoteAddr() net.Addr { return c.remoteAddr }

func (c *testSSHContext) LocalAddr() net.Addr { return nil }

func (c *testSSHContext) Permissions() *gssh.Permissions {
	return &gssh.Permissions{Permissions: &gossh.Permissions{}}
}

func (c *testSSHContext) SetValue(key, value any) {
	c.values[key] = value
}

type testSession struct {
	ctx        *testSSHContext
	rawCommand string
	subsystem  string
	stdin      io.Reader
	stdout     bytes.Buffer
	stderr     bytes.Buffer
	exitCode   int
}

func newTestSession(rawCommand, stdin string) *testSession {
	return newTestSessionWithReader(rawCommand, bytes.NewBufferString(stdin))
}

func newTestSessionWithReader(rawCommand string, stdin io.Reader) *testSession {
	return &testSession{
		ctx:        newTestSSHContext(),
		rawCommand: rawCommand,
		stdin:      stdin,
	}
}

func (s *testSession) Read(p []byte) (int, error) { return s.stdin.Read(p) }

func (s *testSession) Write(p []byte) (int, error) { return s.stdout.Write(p) }

func (s *testSession) Close() error { return nil }

func (s *testSession) CloseWrite() error { return nil }

func (s *testSession) SendRequest(name string, wantReply bool, payload []byte) (bool, error) {
	_ = name
	_ = wantReply
	_ = payload
	return true, nil
}

func (s *testSession) Stderr() io.ReadWriter { return &s.stderr }

func (s *testSession) User() string { return "git" }

func (s *testSession) RemoteAddr() net.Addr { return nil }

func (s *testSession) LocalAddr() net.Addr { return nil }

func (s *testSession) Environ() []string { return nil }

func (s *testSession) Exit(code int) error {
	s.exitCode = code
	return nil
}

func (s *testSession) Command() []string { return nil }

func (s *testSession) RawCommand() string { return s.rawCommand }

func (s *testSession) Subsystem() string { return s.subsystem }

func (s *testSession) PublicKey() gssh.PublicKey { return nil }

func (s *testSession) Context() gssh.Context { return s.ctx }

func (s *testSession) Permissions() gssh.Permissions {
	return gssh.Permissions{Permissions: &gossh.Permissions{}}
}

func (s *testSession) Pty() (gssh.Pty, <-chan gssh.Window, bool) { return gssh.Pty{}, nil, false }

func (s *testSession) Signals(c chan<- gssh.Signal) { _ = c }

func (s *testSession) Break(c chan<- bool) { _ = c }

var _ gssh.Session = (*testSession)(nil)
var _ gssh.Context = (*testSSHContext)(nil)

type testNetConn struct {
	remote net.Addr
	local  net.Addr
}

func (c *testNetConn) Read(p []byte) (int, error)  { return 0, io.EOF }
func (c *testNetConn) Write(p []byte) (int, error) { return len(p), nil }
func (c *testNetConn) Close() error                { return nil }
func (c *testNetConn) LocalAddr() net.Addr {
	if c.local != nil {
		return c.local
	}
	return &net.TCPAddr{}
}
func (c *testNetConn) RemoteAddr() net.Addr {
	if c.remote != nil {
		return c.remote
	}
	return &net.TCPAddr{}
}
func (c *testNetConn) SetDeadline(t time.Time) error      { _ = t; return nil }
func (c *testNetConn) SetReadDeadline(t time.Time) error  { _ = t; return nil }
func (c *testNetConn) SetWriteDeadline(t time.Time) error { _ = t; return nil }

// A push to a repository repo-host holds fails at once with repo-host's
// message, which git shows the user: at discovery, or at the push itself.
func TestSessionHandler_ReceivePack_HeldRepository(t *testing.T) {
	t.Parallel()
	for _, atDiscovery := range []bool{true, false} {
		assertHeldPushRefused(t, atDiscovery)
	}
}

func assertHeldPushRefused(t *testing.T, atDiscovery bool) {
	held := &repohost.StatusError{StatusCode: http.StatusServiceUnavailable, Code: repohost.RepositoryHeldCode,
		Message: "repository maintenance is finishing; retry in 5s", RetryAfter: 5}

	server := &Server{
		Authorizer: &mockSSHAuthorizer{
			authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode services.AccessMode) error {
				return nil
			},
		},
		RepoHostClient: &mockRepoHostGitProxy{
			infoRefsReceivePackFn: func(ctx context.Context, owner, repo string) ([]byte, error) {
				if atDiscovery {
					return nil, held
				}
				return []byte("0000"), nil
			},
			proxyReceivePackFn: func(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
				return held
			},
		},
	}

	sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
	sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})

	server.sessionHandler(sess)

	assert.Equal(t, 1, sess.exitCode)
	assert.Contains(t, sess.stderr.String(), "ERROR: repository maintenance is finishing; retry in 5s")
}
