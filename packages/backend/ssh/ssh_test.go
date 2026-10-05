package ssh_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/repository"
	productssh "github.com/smithersai/smithers/packages/backend/ssh"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func TestNewRejectsAbsentProductDependencies(t *testing.T) {
	_, err := productssh.New(context.Background(), productssh.Config{})
	require.ErrorContains(t, err, "database")
}

// smithersai/plue#593: SSH pushes are capped at the owner's storage, so the
// server never starts without the admission policy that caps them.
func TestNewRequiresAdmission(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	_, err := productssh.New(context.Background(), productssh.Config{Database: pool, Repository: repository.NewRemoteClient(nil, "test-token")})
	require.ErrorContains(t, err, "admission policy is required")
}

func TestProductSSHUsesCanonicalKeyAndRepositoryAuthorization(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	queries := db.New(pool)
	user, err := queries.CreateUser(ctx, db.CreateUserParams{Username: "ssh-fixture", LowerUsername: "ssh-fixture"})
	require.NoError(t, err)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = queries.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: user.ID, Name: "fixture", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	server, err := productssh.New(ctx, productssh.Config{Database: pool, Repository: repository.NewRemoteClient(nil, "test-token"), Admission: policy, Addr: address, HostKeyDir: t.TempDir(), LFSSigningSecret: "test-lfs-secret", PublicAPIOrigin: "http://127.0.0.1:4000"})
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	t.Cleanup(func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, server.Shutdown(shutdown))
		<-done
	})
	var client *gossh.Client
	require.Eventually(t, func() bool {
		client, err = gossh.Dial("tcp", address, &gossh.ClientConfig{User: "git", Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
		return err == nil
	}, 5*time.Second, 20*time.Millisecond)
	defer client.Close()
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	output, err := session.CombinedOutput("git-upload-pack 'other/private.git'")
	require.Error(t, err, "real product repository authorization must reject an inaccessible repository")
	require.True(t, strings.Contains(strings.ToLower(string(output)), "denied") || strings.Contains(strings.ToLower(string(output)), "not found"), string(output))
}

// The SSH door takes the install main fact from the repository engine it
// is given, so it cannot be composed in front of an install's engine without
// it, and hosted composition never has it.
func TestNewTakesInstallMainFactFromTheEngine(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	pool, _ := postgresfixture.NewProductDatabase(t)
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	for _, install := range []bool{true, false} {
		local, err := repository.OpenLocal(repository.Config{StoragePath: t.TempDir(), AuthToken: "ssh-engine-token", FFILibraryPath: ffi, InstallMainMirror: install})
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
		server, err := productssh.New(context.Background(), productssh.Config{Database: pool, Repository: local.Client(), Admission: policy, HostKeyDir: t.TempDir(), LFSSigningSecret: "test-lfs-secret", PublicAPIOrigin: "http://127.0.0.1:4000"})
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
		require.Equal(t, install, productssh.InstallMainMirror(server))
	}
	server, err := productssh.New(context.Background(), productssh.Config{Database: pool, Repository: repository.NewRemoteClient(nil, "test-token"), Admission: policy, HostKeyDir: t.TempDir(), LFSSigningSecret: "test-lfs-secret", PublicAPIOrigin: "http://127.0.0.1:4000"})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	require.False(t, productssh.InstallMainMirror(server))
}
