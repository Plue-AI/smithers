package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type secretInjectionCovCodec struct {
	errOn string
}

func (c secretInjectionCovCodec) EncryptString(plaintext string) (string, error) {
	return plaintext, nil
}

func (c secretInjectionCovCodec) DecryptString(ciphertext string) (string, error) {
	if c.errOn != "" && ciphertext == c.errOn {
		return "", errors.New("decrypt failed")
	}
	return "plain:" + ciphertext, nil
}

func TestSecretInjection_Cov_NilInjectorAndValidation(t *testing.T) {
	var nilInjector *SecretInjector
	env, err := nilInjector.RepositoryEnvironment(context.Background(), 1)
	if err != nil || len(env) != 0 {
		t.Fatalf("nil RepositoryEnvironment = %#v, %v", env, err)
	}
	_, secrets, err := nilInjector.RepositoryEnvironmentAndSecrets(context.Background(), 1, false)
	if err != nil || len(secrets) != 0 {
		t.Fatalf("nil RepositorySecrets = %#v, %v", secrets, err)
	}
	if err := nilInjector.ValidateRepository(context.Background(), 0); err == nil || !strings.Contains(err.Error(), "positive") {
		t.Fatalf("ValidateRepository error = %v", err)
	}
}

func TestSecretInjection_Cov_OrgAndRepoPrecedenceAndErrors(t *testing.T) {
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		getRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 8, OrgID: pgtype.Int8{Int64: 70, Valid: true}}, nil
		},
		listOrgVariablesFn: func(context.Context, int64) ([]db.OrganizationVariable, error) {
			return []db.OrganizationVariable{
				{Name: "REGION", Value: "us-east-1"},
				{Name: "EMPTY_ORG_VAR", Value: ""},
			}, nil
		},
		listVariablesFn: func(context.Context, int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: "REGION", Value: "us-west-2"}}, nil
		},
		listOrgSecretsFn: func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
			return []db.ListOrgSecretValuesRow{{Name: "API_TOKEN", ValueEncrypted: []byte("org")}}, nil
		},
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "API_TOKEN", ValueEncrypted: []byte("repo")},
				{Name: "EMPTY_SECRET", ValueEncrypted: []byte("")},
			}, nil
		},
	}, secretInjectionCovCodec{})

	env, err := injector.RepositoryEnvironment(context.Background(), 8)
	if err != nil {
		t.Fatalf("RepositoryEnvironment returned error: %v", err)
	}
	if env["REGION"] != "us-west-2" || env["API_TOKEN"] != "plain:repo" {
		t.Fatalf("env = %#v, want repo overrides", env)
	}

	_, secrets, err := injector.RepositoryEnvironmentAndSecrets(context.Background(), 8, false)
	if err != nil {
		t.Fatalf("RepositorySecrets returned error: %v", err)
	}
	if secrets["API_TOKEN"] != "plain:repo" {
		t.Fatalf("secrets = %#v, want repo secret override", secrets)
	}

	failing := NewSecretInjector(&mockSecretInjectionQuerier{
		getRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 9}, nil
		},
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{{Name: "BROKEN", ValueEncrypted: []byte("bad")}}, nil
		},
	}, secretInjectionCovCodec{errOn: "bad"})
	_, _, err = failing.RepositoryEnvironmentAndSecrets(context.Background(), 9, false)
	if err == nil || !strings.Contains(err.Error(), `decrypt repository secret "BROKEN"`) {
		t.Fatalf("decrypt err = %v", err)
	}
}

func TestSecretInjection_Cov_InjectCopiesBaseAndRedactsLongestFirst(t *testing.T) {
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(context.Context, int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: "BASE", Value: "override"}, {Name: "NEW_VALUE", Value: "new"}}, nil
		},
	}, nil)

	base := map[string]string{"BASE": "original", "KEEP": "yes"}
	env, err := injector.InjectRepositoryEnvironment(context.Background(), 10, base)
	if err != nil {
		t.Fatalf("InjectRepositoryEnvironment returned error: %v", err)
	}
	if base["BASE"] != "original" || env["BASE"] != "override" || env["KEEP"] != "yes" || env["NEW_VALUE"] != "new" {
		t.Fatalf("base=%#v env=%#v", base, env)
	}

	redacted := RedactSecretValues(map[string]string{
		"A": "token",
		"B": "token-suffix",
		"C": "  ",
		"D": "token",
	}, "token token-suffix")
	if redacted != "******** ********" {
		t.Fatalf("redacted = %q", redacted)
	}
}
