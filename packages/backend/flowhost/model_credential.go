package flowhost

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ModelCredentialPrefix marks a managed host's platform-model credential.
const ModelCredentialPrefix = "smithers_flowhost_"

// ErrModelCredentialInvalid refuses a model credential that names no live
// binding or does not match it.
var ErrModelCredentialInvalid = errors.New("flow host model credential is invalid")

// ModelCredential is the credential a managed host spends platform models
// with, an HMAC of the binding's control credential. Holding it grants no
// control over the host, and forging it needs the control credential itself,
// which is stored only encrypted.
func ModelCredential(bindingID, credential string) string {
	mac := hmac.New(sha256.New, []byte(credential))
	mac.Write([]byte("smithers-model-proxy:" + bindingID))
	return ModelCredentialPrefix + bindingID + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// RoleModelCredential attenuates a host's model credential to one factory role.
// The role is authenticated with the control secret, not taken from model JSON.
func RoleModelCredential(bindingID, credential, role string) string {
	if !factoryModelRole(role) {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(credential))
	mac.Write([]byte("smithers-model-proxy:" + bindingID + ":" + role))
	return ModelCredentialPrefix + bindingID + "." + role + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func factoryModelRole(role string) bool {
	return role == "planner" || role == "implementer" || role == "reviewer"
}

// CredentialBinding is the live binding a host credential belongs to.
type CredentialBinding struct {
	FactoryRole  string
	ID           string
	UserID       int64
	RepositoryID int64
	WorkspaceID  string
}

// VerifyModelCredential resolves a model credential to its binding. A
// retired binding, or one whose control credential rotated, is refused.
func VerifyModelCredential(ctx context.Context, pool *pgxpool.Pool, codec SecretCodec, token string) (CredentialBinding, error) {
	rest, ok := strings.CutPrefix(token, ModelCredentialPrefix)
	if !ok || pool == nil || codec == nil {
		return CredentialBinding{}, ErrModelCredentialInvalid
	}
	id, mac, ok := strings.Cut(rest, ".")
	role := ""
	if candidate, signature, scoped := strings.Cut(mac, "."); scoped {
		if !factoryModelRole(candidate) {
			return CredentialBinding{}, ErrModelCredentialInvalid
		}
		role, mac = candidate, signature
	}
	if _, err := uuid.Parse(id); !ok || err != nil || mac == "" {
		return CredentialBinding{}, ErrModelCredentialInvalid
	}
	var out CredentialBinding
	var encrypted string
	var credentialHash []byte
	err := pool.QueryRow(ctx, `SELECT id::text, user_id, repository_id, workspace_id, credential_ciphertext, credential_hash
		FROM flow_runtime_host_bindings WHERE id = $1::uuid AND state <> 'retired'`, id).
		Scan(&out.ID, &out.UserID, &out.RepositoryID, &out.WorkspaceID, &encrypted, &credentialHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return CredentialBinding{}, ErrModelCredentialInvalid
	}
	if err != nil {
		return CredentialBinding{}, err
	}
	credential, err := codec.DecryptString(encrypted)
	if err != nil {
		return CredentialBinding{}, errors.New("open flow host credential")
	}
	digest := sha256.Sum256([]byte(credential))
	expected := ModelCredential(out.ID, credential)
	if role != "" {
		expected = RoleModelCredential(out.ID, credential, role)
	}
	if !hmac.Equal(digest[:], credentialHash) || !hmac.Equal([]byte(token), []byte(expected)) {
		return CredentialBinding{}, ErrModelCredentialInvalid
	}
	out.FactoryRole = role
	return out, nil
}

// ErrHostCredentialInvalid refuses a host control credential that names no
// live binding or does not match it.
var ErrHostCredentialInvalid = errors.New("flow host credential is invalid")

// VerifyHostCredential resolves the control credential a managed host calls
// the backend with (SMITHERS_GATEWAY_ID is the binding ID, SMITHERS_API_KEY
// the credential) to its binding. Only a host that is starting or running
// may call back; a retired or failed binding, or a rotated credential, is
// refused.
func VerifyHostCredential(ctx context.Context, pool *pgxpool.Pool, bindingID, token string) (CredentialBinding, error) {
	if _, err := uuid.Parse(bindingID); err != nil || pool == nil || strings.TrimSpace(token) == "" {
		return CredentialBinding{}, ErrHostCredentialInvalid
	}
	var out CredentialBinding
	var credentialHash []byte
	err := pool.QueryRow(ctx, `SELECT id::text, user_id, repository_id, workspace_id::text, credential_hash
		FROM flow_runtime_host_bindings WHERE id = $1::uuid AND state IN ('starting', 'running')`, bindingID).
		Scan(&out.ID, &out.UserID, &out.RepositoryID, &out.WorkspaceID, &credentialHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return CredentialBinding{}, ErrHostCredentialInvalid
	}
	if err != nil {
		return CredentialBinding{}, err
	}
	digest := sha256.Sum256([]byte(token))
	if len(credentialHash) != len(digest) || subtle.ConstantTimeCompare(credentialHash, digest[:]) != 1 {
		return CredentialBinding{}, ErrHostCredentialInvalid
	}
	return out, nil
}
