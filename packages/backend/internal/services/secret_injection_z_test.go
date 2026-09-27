package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestSecretInjection_Z_RepositorySecretsErrors(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	_, _, err := NewSecretInjector(&mockSecretInjectionQuerier{}, nil).RepositoryEnvironmentAndSecrets(ctx, 0, false)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "positive")

	_, _, err = NewSecretInjector(&mockSecretInjectionQuerier{
		getRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}, nil).RepositoryEnvironmentAndSecrets(ctx, 1, false)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load repository")

	for _, tc := range []struct {
		name  string
		q     *mockSecretInjectionQuerier
		codec secretInjectionCovCodec
		want  string
	}{
		{
			name: "org list error",
			q: &mockSecretInjectionQuerier{
				getRepoFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: 1, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
				},
				listOrgSecretsFn: func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
					return nil, errors.New("org list failed")
				},
			},
			want: "list organization secrets",
		},
		{
			name: "org invalid name",
			q: &mockSecretInjectionQuerier{
				getRepoFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: 1, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
				},
				listOrgSecretsFn: func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
					return []db.ListOrgSecretValuesRow{{Name: "BAD-NAME", ValueEncrypted: []byte("x")}}, nil
				},
			},
			want: "organization secret",
		},
		{
			name: "org decrypt error",
			q: secretInjectionZOrgRepo(func(q *mockSecretInjectionQuerier) {
				q.listOrgSecretsFn = func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
					return []db.ListOrgSecretValuesRow{{Name: "ORG_SECRET", ValueEncrypted: []byte("bad")}}, nil
				}
			}),
			codec: secretInjectionCovCodec{errOn: "bad"},
			want:  "decrypt organization secret",
		},
		{
			name: "repo list error",
			q: &mockSecretInjectionQuerier{
				listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
					return nil, errors.New("repo list failed")
				},
			},
			want: "list repository secrets",
		},
		{
			name: "repo invalid name",
			q: &mockSecretInjectionQuerier{
				listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
					return []db.ListSecretValuesRow{{Name: "BAD-NAME", ValueEncrypted: []byte("x")}}, nil
				},
			},
			want: "repository secret",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := NewSecretInjector(tc.q, tc.codec).RepositoryEnvironmentAndSecrets(ctx, 1, false)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}

	_, env, err := NewSecretInjector(secretInjectionZOrgRepo(func(q *mockSecretInjectionQuerier) {
		q.listOrgSecretsFn = func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
			return []db.ListOrgSecretValuesRow{{Name: "EMPTY_ORG_SECRET", ValueEncrypted: []byte("")}}, nil
		}
		q.listSecretValuesFn = func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{{Name: "EMPTY_SECRET", ValueEncrypted: []byte("")}}, nil
		}
	}), nil).RepositoryEnvironmentAndSecrets(ctx, 1, false)
	require.NoError(t, err)
	assert.Empty(t, env)

	_, env, err = NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{{Name: "EMPTY_SECRET", ValueEncrypted: []byte("")}}, nil
		},
	}, nil).RepositoryEnvironmentAndSecrets(ctx, 1, false)
	require.NoError(t, err)
	assert.Empty(t, env)
}

func TestSecretInjection_Z_RepositoryEnvironmentErrors(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	_, err := NewSecretInjector(&mockSecretInjectionQuerier{}, nil).RepositoryEnvironment(ctx, 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "positive")

	cases := []struct {
		name  string
		q     *mockSecretInjectionQuerier
		codec secretInjectionCovCodec
		want  string
	}{
		{
			name: "load repo",
			q: &mockSecretInjectionQuerier{
				getRepoFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{}, errors.New("repo failed")
				},
			},
			want: "load repository",
		},
		{
			name: "org variables list",
			q: secretInjectionZOrgRepo(func(q *mockSecretInjectionQuerier) {
				q.listOrgVariablesFn = func(context.Context, int64) ([]db.OrganizationVariable, error) {
					return nil, errors.New("org vars failed")
				}
			}),
			want: "list organization variables",
		},
		{
			name: "org variable invalid",
			q: secretInjectionZOrgRepo(func(q *mockSecretInjectionQuerier) {
				q.listOrgVariablesFn = func(context.Context, int64) ([]db.OrganizationVariable, error) {
					return []db.OrganizationVariable{{Name: "BAD-NAME", Value: "x"}}, nil
				}
			}),
			want: "organization variable",
		},
		{
			name: "repo variables list",
			q: &mockSecretInjectionQuerier{
				listVariablesFn: func(context.Context, int64) ([]db.RepositoryVariable, error) {
					return nil, errors.New("repo vars failed")
				},
			},
			want: "list repository variables",
		},
		{
			name: "org secret list",
			q: secretInjectionZOrgRepo(func(q *mockSecretInjectionQuerier) {
				q.listOrgSecretsFn = func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
					return nil, errors.New("org secrets failed")
				}
			}),
			want: "list organization secrets",
		},
		{
			name: "org secret invalid",
			q: secretInjectionZOrgRepo(func(q *mockSecretInjectionQuerier) {
				q.listOrgSecretsFn = func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
					return []db.ListOrgSecretValuesRow{{Name: "BAD-NAME", ValueEncrypted: []byte("x")}}, nil
				}
			}),
			want: "organization secret",
		},
		{
			name: "org secret decrypt",
			q: secretInjectionZOrgRepo(func(q *mockSecretInjectionQuerier) {
				q.listOrgSecretsFn = func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
					return []db.ListOrgSecretValuesRow{{Name: "ORG_SECRET", ValueEncrypted: []byte("bad")}}, nil
				}
			}),
			codec: secretInjectionCovCodec{errOn: "bad"},
			want:  "decrypt organization secret",
		},
		{
			name: "repo secret list",
			q: &mockSecretInjectionQuerier{
				listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
					return nil, errors.New("repo secrets failed")
				},
			},
			want: "list repository secrets",
		},
		{
			name: "repo secret decrypt",
			q: &mockSecretInjectionQuerier{
				listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
					return []db.ListSecretValuesRow{{Name: "REPO_SECRET", ValueEncrypted: []byte("bad")}}, nil
				},
			},
			codec: secretInjectionCovCodec{errOn: "bad"},
			want:  "decrypt repository secret",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewSecretInjector(tc.q, tc.codec).RepositoryEnvironment(ctx, 1)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}

	env, err := NewSecretInjector(secretInjectionZOrgRepo(func(q *mockSecretInjectionQuerier) {
		q.listOrgVariablesFn = func(context.Context, int64) ([]db.OrganizationVariable, error) {
			return []db.OrganizationVariable{{Name: "EMPTY_ORG_VAR", Value: ""}}, nil
		}
		q.listVariablesFn = func(context.Context, int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: "EMPTY_REPO_VAR", Value: ""}}, nil
		}
		q.listOrgSecretsFn = func(context.Context, int64) ([]db.ListOrgSecretValuesRow, error) {
			return []db.ListOrgSecretValuesRow{{Name: "EMPTY_ORG_SECRET", ValueEncrypted: []byte("")}}, nil
		}
		q.listSecretValuesFn = func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{{Name: "EMPTY_REPO_SECRET", ValueEncrypted: []byte("")}}, nil
		}
	}), nil).RepositoryEnvironment(ctx, 1)
	require.NoError(t, err)
	assert.Empty(t, env)
}

func TestSecretInjection_Z_RedactEqualLengthOrdering(t *testing.T) {
	t.Parallel()

	redacted := RedactSecretValues(map[string]string{
		"A": "bbb",
		"B": "aaa",
	}, "aaa bbb ccc")
	assert.Equal(t, "******** ******** ccc", redacted)
	assert.Equal(t, "plain text", RedactSecretValues(nil, "plain text"))
	assert.Equal(t, "", RedactSecretValues(map[string]string{"A": "aaa"}, ""))
}

func secretInjectionZOrgRepo(mut func(*mockSecretInjectionQuerier)) *mockSecretInjectionQuerier {
	q := &mockSecretInjectionQuerier{
		getRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 1, OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
	}
	if mut != nil {
		mut(q)
	}
	return q
}

func TestSecretInjection_Z_ValidNameTrims(t *testing.T) {
	t.Parallel()

	assert.True(t, IsInjectedSecretName(" NAME_1 "))
	assert.False(t, IsInjectedSecretName("1_BAD"))
	assert.False(t, strings.Contains(RedactSecretValues(map[string]string{"S": "secret"}, "secret"), "secret"))
}
