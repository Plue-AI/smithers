package services

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func lfsScopedContext(t *testing.T, repositoryID int64, operation lfsauth.Operation, principal lfsauth.PrincipalType) context.Context {
	t.Helper()
	manager, err := lfsauth.NewManager("lfs-scoped-service-test-secret")
	require.NoError(t, err)
	token, claims, err := manager.Issue(lfsauth.Grant{
		RepositoryID: repositoryID,
		Owner:        "alice",
		Repository:   "demo",
		Operation:    operation,
		Principal:    principal,
	}, time.Minute)
	require.NoError(t, err)
	return lfsauth.ContextWithGrant(context.Background(), claims, token)
}

func TestLFSService_ScopedDeployKeyCredentialUploadsAndAuthenticatesVerify(t *testing.T) {
	ctx := lfsScopedContext(t, lfsRepo().ID, lfsauth.OperationUpload, lfsauth.PrincipalDeployKey)
	verifyManager, err := lfsauth.NewManager("lfs-scoped-service-test-secret")
	require.NoError(t, err)
	store := &mockBlobStore{existsFn: func(context.Context, string) (bool, error) { return false, nil }}
	svc := NewLFSService(lfsRepoQuerier(), store, time.Minute,
		WithLFSVerifyBaseURL("https://plue.test"), WithLFSVerifyTokenManager(verifyManager))

	resp, err := svc.Batch(ctx, nil, "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}},
	})
	require.NoError(t, err)
	verify := resp.Objects[0].Actions["verify"]
	assert.Equal(t, "https://plue.test/api/repos/alice/demo/lfs/verify", verify.Href)
	assert.Contains(t, verify.Header["Authorization"], lfsauth.AuthorizationScheme+" smithers_lfs_v1.")
	verifyToken := strings.TrimPrefix(verify.Header["Authorization"], lfsauth.AuthorizationScheme+" ")
	claims, err := verifyManager.Verify(verifyToken)
	require.NoError(t, err)
	assert.Equal(t, lfsauth.PurposeVerify, claims.Purpose)
	assert.Equal(t, strings.Repeat("a", 64), claims.OID)
	assert.Equal(t, int64(1), claims.Size)
}

func TestLFSService_ObjectBoundVerifyOutlivesBroadBridgeCredential(t *testing.T) {
	manager, err := lfsauth.NewManager("lfs-scoped-service-test-secret")
	require.NoError(t, err)
	oid, body := lfsTestOID("slow direct upload")
	broadToken, broadClaims, err := manager.Issue(lfsauth.Grant{
		RepositoryID: lfsRepo().ID,
		Owner:        "alice",
		Repository:   "demo",
		Operation:    lfsauth.OperationUpload,
		Principal:    lfsauth.PrincipalDeployKey,
	}, time.Second)
	require.NoError(t, err)
	ctx := lfsauth.ContextWithGrant(context.Background(), broadClaims, broadToken)
	uploaded := false
	store := &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return uploaded, nil },
		newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(body)), nil
		},
	}
	svc := NewLFSService(lfsRepoQuerier(), store, time.Minute,
		WithLFSVerifyBaseURL("https://plue.test"), WithLFSVerifyTokenManager(manager))

	resp, err := svc.Batch(ctx, nil, "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: int64(len(body))}},
	})
	require.NoError(t, err)
	verifyAuthorization := resp.Objects[0].Actions["verify"].Header["Authorization"]
	verifyToken := strings.TrimPrefix(verifyAuthorization, lfsauth.AuthorizationScheme+" ")
	_, err = manager.Verify(verifyToken)
	require.NoError(t, err)

	time.Sleep(1100 * time.Millisecond)
	_, err = manager.Verify(broadToken)
	assert.ErrorContains(t, err, "expired")
	verifyClaims, err := manager.Verify(verifyToken)
	require.NoError(t, err)
	uploaded = true
	confirmed, err := svc.ConfirmUpload(
		lfsauth.ContextWithGrant(context.Background(), verifyClaims, verifyToken),
		nil,
		"alice",
		"demo",
		LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))},
	)
	require.NoError(t, err)
	assert.Equal(t, oid, confirmed.Oid)
}

func TestLFSService_ScopedCredentialFailsClosedForWrongOperationAndRepository(t *testing.T) {
	svc := NewLFSService(lfsRepoQuerier(), &mockBlobStore{}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))

	downloadCtx := lfsScopedContext(t, lfsRepo().ID, lfsauth.OperationDownload, lfsauth.PrincipalUser)
	_, err := svc.Batch(downloadCtx, nil, "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}},
	})
	assert.Equal(t, 404, apiStatus(t, err))

	wrongRepoCtx := lfsScopedContext(t, lfsRepo().ID+1, lfsauth.OperationUpload, lfsauth.PrincipalDeployKey)
	_, err = svc.Batch(wrongRepoCtx, nil, "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}},
	})
	assert.Equal(t, 404, apiStatus(t, err))

	_, err = svc.Batch(lfsScopedContext(t, lfsRepo().ID, lfsauth.OperationUpload, lfsauth.PrincipalUser), nil, "bob", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: strings.Repeat("a", 64), Size: 1}},
	})
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestLFSService_VerifyCredentialRejectsWrongPathOIDSizeAndBatch(t *testing.T) {
	manager, err := lfsauth.NewManager("lfs-scoped-service-test-secret")
	require.NoError(t, err)
	oid, body := lfsTestOID("object-bound verification")
	token, claims, err := manager.IssueVerify(lfsauth.VerifyGrant{
		RepositoryID: lfsRepo().ID,
		Owner:        "alice",
		Repository:   "demo",
		OID:          oid,
		Size:         int64(len(body)),
		Principal:    lfsauth.PrincipalDeployKey,
	}, time.Hour)
	require.NoError(t, err)
	ctx := lfsauth.ContextWithGrant(context.Background(), claims, token)
	svc := NewLFSService(lfsRepoQuerier(), &mockBlobStore{}, time.Minute,
		WithLFSVerifyBaseURL("https://plue.test"), WithLFSVerifyTokenManager(manager))

	_, err = svc.Batch(ctx, nil, "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: int64(len(body))}},
	})
	assert.Equal(t, 404, apiStatus(t, err))
	_, err = svc.ConfirmUpload(ctx, nil, "bob", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	assert.Equal(t, 403, apiStatus(t, err))
	_, err = svc.ConfirmUpload(ctx, nil, "alice", "demo", LFSConfirmUploadInput{Oid: strings.Repeat("b", 64), Size: int64(len(body))})
	assert.Equal(t, 403, apiStatus(t, err))
	_, err = svc.ConfirmUpload(ctx, nil, "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body)) + 1})
	assert.Equal(t, 403, apiStatus(t, err))
}

func TestLFSService_RepositoryBoundTokenCannotCrossRepositoryOnAnyOperation(t *testing.T) {
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{
		User:        lfsUser(),
		IsTokenAuth: true,
		RawScopes: strings.Join([]string{
			string(middleware.ScopeWriteRepository),
			middleware.RepositoryRestrictionScope(lfsRepo().ID + 1),
		}, ","),
		Scopes: middleware.ParseTokenScopes(string(middleware.ScopeWriteRepository)),
	})
	svc := NewLFSService(lfsRepoQuerier(), &mockBlobStore{}, time.Minute, WithLFSVerifyBaseURL("https://plue.test"))
	oid := strings.Repeat("a", 64)

	_, err := svc.Batch(ctx, lfsUser(), "alice", "demo", LFSBatchInput{
		Operation: "upload",
		Objects:   []LFSObjectInput{{Oid: oid, Size: 1}},
	})
	assert.Equal(t, 404, apiStatus(t, err))
	_, err = svc.ConfirmUpload(ctx, lfsUser(), "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: 1})
	assert.Equal(t, 403, apiStatus(t, err))
	err = svc.DeleteObject(ctx, lfsUser(), "alice", "demo", oid)
	assert.Equal(t, 403, apiStatus(t, err))
	_, _, err = svc.ListObjects(ctx, lfsUser(), "alice", "demo", 1, 10)
	assert.Equal(t, 403, apiStatus(t, err))
}

func TestLFSService_ScopedDeployKeyCredentialConfirmsWithoutUserIdentity(t *testing.T) {
	oid, body := lfsTestOID("scoped upload")
	q := lfsRepoQuerier()
	store := &mockBlobStore{newReaderFn: func(context.Context, string) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader(body)), nil
	}}
	svc := NewLFSService(q, store, time.Minute)
	ctx := lfsScopedContext(t, lfsRepo().ID, lfsauth.OperationUpload, lfsauth.PrincipalDeployKey)

	obj, err := svc.ConfirmUpload(ctx, nil, "alice", "demo", LFSConfirmUploadInput{Oid: oid, Size: int64(len(body))})
	require.NoError(t, err)
	assert.Equal(t, oid, obj.Oid)
}
