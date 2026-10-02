package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

func orgCovUniqueName(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}

func TestOrg_Cov_PgxCreateTxLifecycle(t *testing.T) {
	pool := setupTestPool(t)
	ctx := context.Background()
	queries := db.New(pool)

	username := orgCovUniqueName("org_cov_user")
	var userID int64
	err := pool.QueryRow(ctx,
		`INSERT INTO users (username, lower_username, email, lower_email, display_name)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		username,
		strings.ToLower(username),
		username+"@example.com",
		strings.ToLower(username)+"@example.com",
		"Org Cover User",
	).Scan(&userID)
	require.NoError(t, err)

	manager := &pgxOrgTxManager{pool: pool}
	tx, err := manager.BeginCreateTx(ctx)
	require.NoError(t, err)

	orgName := orgCovUniqueName("org_cov_committed")
	org, err := tx.CreateOrganization(ctx, db.CreateOrganizationParams{
		Name:       orgName,
		LowerName:  strings.ToLower(orgName),
		Visibility: "private",
	})
	require.NoError(t, err)
	_, err = tx.AddOrgMember(ctx, db.AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         userID,
		Role:           "owner",
	})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))

	loaded, err := queries.GetOrgByLowerName(ctx, strings.ToLower(orgName))
	require.NoError(t, err)
	assert.Equal(t, org.ID, loaded.ID)

	tx, err = manager.BeginCreateTx(ctx)
	require.NoError(t, err)
	rolledBackName := orgCovUniqueName("org_cov_rolled_back")
	_, err = tx.CreateOrganization(ctx, db.CreateOrganizationParams{
		Name:       rolledBackName,
		LowerName:  strings.ToLower(rolledBackName),
		Visibility: "public",
	})
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))

	_, err = queries.GetOrgByLowerName(ctx, strings.ToLower(rolledBackName))
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestOrg_Cov_CreateOrgTransactionalFailures(t *testing.T) {
	ctx := context.Background()
	actor := testOrgUser(42, "owner")

	t.Run("begin fails", func(t *testing.T) {
		svc := NewOrgService(&mockOrgQuerier{})
		svc.txManager = &mockOrgCreateTxManager{
			beginCreateTxFn: func(ctx context.Context) (orgCreateTx, error) {
				return nil, errors.New("begin exploded")
			},
		}

		_, err := svc.CreateOrg(ctx, actor, CreateOrgRequest{Name: "acme"})
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("create unique violation rolls back", func(t *testing.T) {
		rolledBack := false
		svc := NewOrgService(&mockOrgQuerier{})
		svc.txManager = &mockOrgCreateTxManager{
			beginCreateTxFn: func(ctx context.Context) (orgCreateTx, error) {
				return &mockOrgCreateTx{
					createOrganizationFn: func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
						return db.Organization{}, &pgconn.PgError{Code: "23505"}
					},
					rollbackFn: func(ctx context.Context) error {
						rolledBack = true
						return nil
					},
				}, nil
			},
		}

		_, err := svc.CreateOrg(ctx, actor, CreateOrgRequest{Name: "acme"})
		requireAPIErrorStatus(t, err, http.StatusConflict)
		assert.True(t, rolledBack)
	})

	t.Run("add owner failure rolls back", func(t *testing.T) {
		rolledBack := false
		svc := NewOrgService(&mockOrgQuerier{})
		svc.txManager = &mockOrgCreateTxManager{
			beginCreateTxFn: func(ctx context.Context) (orgCreateTx, error) {
				return &mockOrgCreateTx{
					createOrganizationFn: func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
						return db.Organization{ID: 99, Name: arg.Name, LowerName: arg.LowerName, Visibility: arg.Visibility}, nil
					},
					addOrgMemberFn: func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
						return db.OrgMember{}, errors.New("member insert failed")
					},
					rollbackFn: func(ctx context.Context) error {
						rolledBack = true
						return nil
					},
				}, nil
			},
		}

		_, err := svc.CreateOrg(ctx, actor, CreateOrgRequest{Name: "acme"})
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
		assert.True(t, rolledBack)
	})

	t.Run("commit failure reports internal", func(t *testing.T) {
		svc := NewOrgService(&mockOrgQuerier{})
		svc.txManager = &mockOrgCreateTxManager{
			beginCreateTxFn: func(ctx context.Context) (orgCreateTx, error) {
				return &mockOrgCreateTx{
					createOrganizationFn: func(ctx context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
						return db.Organization{ID: 100, Name: arg.Name, LowerName: arg.LowerName, Visibility: arg.Visibility}, nil
					},
					commitFn: func(ctx context.Context) error {
						return errors.New("commit failed")
					},
				}, nil
			},
		}

		_, err := svc.CreateOrg(ctx, actor, CreateOrgRequest{Name: "acme"})
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})
}

func TestOrg_Cov_ResolveAndPermissionHelpers(t *testing.T) {
	ctx := context.Background()

	t.Run("resolve organization input and store errors", func(t *testing.T) {
		svc := NewOrgService(&mockOrgQuerier{})
		viewer := testOrgUser(1, "viewer")
		_, err := svc.requireOrgRole(ctx, viewer, "  ")
		requireAPIErrorStatus(t, err, http.StatusBadRequest)

		svc = NewOrgService(&mockOrgQuerier{
			getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
				return db.Organization{}, errors.New("db down")
			},
		})
		_, err = svc.requireOrgRole(ctx, viewer, "acme")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("resolve team input and store errors", func(t *testing.T) {
		svc := NewOrgService(&mockOrgQuerier{})
		_, err := svc.resolveTeam(ctx, 7, "  ")
		requireAPIErrorStatus(t, err, http.StatusBadRequest)

		svc = NewOrgService(&mockOrgQuerier{
			getTeamByOrgAndLowerNameFn: func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{}, pgx.ErrNoRows
			},
		})
		_, err = svc.resolveTeam(ctx, 7, "backend")
		requireAPIErrorStatus(t, err, http.StatusNotFound)

		svc = NewOrgService(&mockOrgQuerier{
			getTeamByOrgAndLowerNameFn: func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{}, errors.New("lookup failed")
			},
		})
		_, err = svc.resolveTeam(ctx, 7, "backend")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("membership helpers distinguish not found from store failure", func(t *testing.T) {
		private := func(context.Context, string) (db.Organization, error) { return testOrg("private"), nil }
		svc := NewOrgService(&mockOrgQuerier{
			getOrgByLowerNameFn: private,
			getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: arg.OrganizationID, UserID: arg.UserID, Role: "member"}, nil
			},
		})
		viewer := testOrgUser(1, "viewer")
		_, err := svc.requireOrgRole(ctx, viewer, "acme")
		require.NoError(t, err)

		svc = NewOrgService(&mockOrgQuerier{
			getOrgByLowerNameFn: private,
			getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{}, errors.New("membership read failed")
			},
		})
		_, err = svc.requireOrgRole(ctx, viewer, "acme", "owner")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})
}

func TestOrg_Cov_ListErrorBranches(t *testing.T) {
	ctx := context.Background()
	viewer := testOrgUser(1, "owner")

	t.Run("private repos are hidden from non-members", func(t *testing.T) {
		svc := NewOrgService(&mockOrgQuerier{
			getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
				return testOrg("private"), nil
			},
		})
		_, _, err := svc.ListOrgRepos(ctx, nil, "acme", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusNotFound)
	})

	t.Run("member repository list and count errors", func(t *testing.T) {
		svc := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.listOrgReposFn = func(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
				return nil, errors.New("list failed")
			}
		}))
		_, _, err := svc.ListOrgRepos(ctx, viewer, "acme", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)

		svc = NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.listOrgReposFn = func(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error) {
				return []db.Repository{{ID: 1}}, nil
			}
			q.countOrgReposFn = func(ctx context.Context, orgID pgtype.Int8) (int64, error) {
				return 0, errors.New("count failed")
			}
		}))
		_, _, err = svc.ListOrgRepos(ctx, viewer, "acme", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("public repository list and count errors", func(t *testing.T) {
		publicNonMember := &mockOrgQuerier{
			getOrgByLowerNameFn: func(ctx context.Context, lowerName string) (db.Organization, error) {
				return testOrg("public"), nil
			},
			getOrgMemberFn: func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{}, pgx.ErrNoRows
			},
			listPublicOrgReposFn: func(ctx context.Context, arg db.ListPublicOrgReposParams) ([]db.Repository, error) {
				return nil, errors.New("list public failed")
			},
		}
		svc := NewOrgService(publicNonMember)
		_, _, err := svc.ListOrgRepos(ctx, testOrgUser(2, "outsider"), "acme", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)

		publicNonMember.listPublicOrgReposFn = func(ctx context.Context, arg db.ListPublicOrgReposParams) ([]db.Repository, error) {
			return []db.Repository{{ID: 1}}, nil
		}
		publicNonMember.countPublicOrgReposFn = func(ctx context.Context, orgID pgtype.Int8) (int64, error) {
			return 0, errors.New("count public failed")
		}
		_, _, err = svc.ListOrgRepos(ctx, testOrgUser(2, "outsider"), "acme", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("member and team collection count errors", func(t *testing.T) {
		svc := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.listOrgMembersFn = func(ctx context.Context, arg db.ListOrgMembersParams) ([]db.ListOrgMembersRow, error) {
				return nil, errors.New("members list failed")
			}
		}))
		_, _, err := svc.ListOrgMembers(ctx, viewer, "acme", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)

		svc = NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.listOrgTeamsFn = func(ctx context.Context, arg db.ListOrgTeamsParams) ([]db.Team, error) {
				return []db.Team{{ID: 1}}, nil
			}
			q.countOrgTeamsFn = func(ctx context.Context, orgID int64) (int64, error) {
				return 0, errors.New("teams count failed")
			}
		}))
		_, _, err = svc.ListOrgTeams(ctx, viewer, "acme", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("team member and repo collection errors", func(t *testing.T) {
		svc := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 55, OrganizationID: 7, Name: "backend", LowerName: "backend"}, nil
			}
			q.listTeamMembersFn = func(ctx context.Context, arg db.ListTeamMembersParams) ([]db.User, error) {
				return nil, errors.New("team members failed")
			}
		}))
		_, _, err := svc.ListTeamMembers(ctx, viewer, "acme", "backend", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)

		svc = NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 55, OrganizationID: 7, Name: "backend", LowerName: "backend"}, nil
			}
			q.listTeamReposFn = func(ctx context.Context, arg db.ListTeamReposParams) ([]db.Repository, error) {
				return []db.Repository{{ID: 1}}, nil
			}
			q.countTeamReposFn = func(ctx context.Context, teamID int64) (int64, error) {
				return 0, errors.New("team repos count failed")
			}
		}))
		_, _, err = svc.ListTeamRepos(ctx, viewer, "acme", "backend", 1, 30)
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})
}

func TestOrg_Cov_MutationErrorBranches(t *testing.T) {
	ctx := context.Background()
	actor := testOrgUser(1, "owner")

	t.Run("add organization member store errors", func(t *testing.T) {
		svc := NewOrgService(ownerOrgQuerier())
		err := svc.AddOrgMember(ctx, actor, "acme", 0, "member")
		requireAPIErrorStatus(t, err, http.StatusUnprocessableEntity)

		for _, tc := range []struct {
			name   string
			err    error
			status int
		}{
			{"duplicate", &pgconn.PgError{Code: "23505"}, http.StatusConflict},
			{"missing user", &pgconn.PgError{Code: "23503"}, http.StatusNotFound},
			{"internal", errors.New("insert failed"), http.StatusInternalServerError},
		} {
			t.Run(tc.name, func(t *testing.T) {
				svc := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
					q.addOrgMemberFn = func(ctx context.Context, arg db.AddOrgMemberParams) (db.OrgMember, error) {
						return db.OrgMember{}, tc.err
					}
				}))
				err := svc.AddOrgMember(ctx, actor, "acme", 2, "member")
				requireAPIErrorStatus(t, err, tc.status)
			})
		}
	})

	t.Run("team mutations report store errors", func(t *testing.T) {
		svc := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.createTeamFn = func(ctx context.Context, arg db.CreateTeamParams) (db.Team, error) {
				return db.Team{}, &pgconn.PgError{Code: "23505"}
			}
		}))
		_, err := svc.CreateTeam(ctx, actor, "acme", CreateTeamRequest{Name: "backend"})
		requireAPIErrorStatus(t, err, http.StatusConflict)

		svc = NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 9, OrganizationID: 7, Name: "backend", LowerName: "backend", Permission: "read"}, nil
			}
			q.updateTeamFn = func(ctx context.Context, arg db.UpdateTeamParams) (db.Team, error) {
				return db.Team{}, errors.New("update failed")
			}
		}))
		_, err = svc.UpdateTeam(ctx, actor, "acme", "backend", UpdateTeamRequest{Name: "platform"})
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)

		svc = NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
				return db.Team{ID: 9, OrganizationID: 7, Name: "backend", LowerName: "backend"}, nil
			}
			q.deleteTeamFn = func(ctx context.Context, id int64) error {
				return errors.New("delete failed")
			}
		}))
		err = svc.DeleteTeam(ctx, actor, "acme", "backend")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("team membership mutations report user and insert errors", func(t *testing.T) {
		base := func(extra func(*mockOrgQuerier)) *OrgService {
			return NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
				q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
					return db.Team{ID: 9, OrganizationID: 7, Name: "backend", LowerName: "backend"}, nil
				}
				if extra != nil {
					extra(q)
				}
			}))
		}

		err := base(nil).AddTeamMember(ctx, actor, "acme", "backend", " ")
		requireAPIErrorStatus(t, err, http.StatusBadRequest)

		svc := base(func(q *mockOrgQuerier) {
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{}, errors.New("user lookup failed")
			}
		})
		err = svc.AddTeamMember(ctx, actor, "acme", "backend", "bob")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)

		svc = base(func(q *mockOrgQuerier) {
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			}
			q.addTeamMemberIfOrgMemberFn = func(ctx context.Context, arg db.AddTeamMemberIfOrgMemberParams) (db.TeamMember, error) {
				return db.TeamMember{}, &pgconn.PgError{Code: "23505"}
			}
		})
		err = svc.AddTeamMember(ctx, actor, "acme", "backend", "bob")
		requireAPIErrorStatus(t, err, http.StatusConflict)

		svc = base(func(q *mockOrgQuerier) {
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			}
			q.removeTeamMemberFn = func(ctx context.Context, arg db.RemoveTeamMemberParams) error {
				return errors.New("remove failed")
			}
		})
		err = svc.RemoveTeamMember(ctx, actor, "acme", "backend", "bob")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("team repository mutations report lookup insert and dispatch errors", func(t *testing.T) {
		base := func(extra func(*mockOrgQuerier)) *mockOrgQuerier {
			return ownerOrgQuerier(func(q *mockOrgQuerier) {
				q.getTeamByOrgAndLowerNameFn = func(ctx context.Context, arg db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
					return db.Team{ID: 9, OrganizationID: 7, Name: "backend", LowerName: "backend"}, nil
				}
				if extra != nil {
					extra(q)
				}
			})
		}

		svc := NewOrgService(base(func(q *mockOrgQuerier) {
			q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{}, errors.New("repo lookup failed")
			}
		}))
		err := svc.AddTeamRepo(ctx, actor, "acme", "backend", "acme", "repo")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)

		svc = NewOrgService(base(func(q *mockOrgQuerier) {
			q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 22, Name: "repo", OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			}
			q.addTeamRepoIfOrgRepoFn = func(ctx context.Context, arg db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
				return db.TeamRepo{}, &pgconn.PgError{Code: "23505"}
			}
		}))
		err = svc.AddTeamRepo(ctx, actor, "acme", "backend", "acme", "repo")
		requireAPIErrorStatus(t, err, http.StatusConflict)

		dispatcher := &mockOrgDispatcher{
			dispatchFn: func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
				return errors.New("queue down")
			},
		}
		svc = NewOrgService(base(func(q *mockOrgQuerier) {
			q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 22, Name: "repo", OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			}
			q.addTeamRepoIfOrgRepoFn = func(ctx context.Context, arg db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
				return db.TeamRepo{TeamID: 9, RepositoryID: 22}, nil
			}
		}), WithOrgWebhookDispatcher(dispatcher))
		// The team repo row is committed; a webhook enqueue failure is logged,
		// never reported as a failed request.
		require.NoError(t, svc.AddTeamRepo(ctx, actor, "acme", "backend", "acme", "repo"))

		svc = NewOrgService(base(func(q *mockOrgQuerier) {
			q.getRepoByOwnerAndLowerNameFn = func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 22, Name: "repo", OrgID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			}
			q.removeTeamRepoFn = func(ctx context.Context, arg db.RemoveTeamRepoParams) error {
				return errors.New("remove repo failed")
			}
		}))
		err = svc.RemoveTeamRepo(ctx, actor, "acme", "backend", "acme", "repo")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})

	t.Run("remove organization member target errors", func(t *testing.T) {
		svc := NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			}
			q.getOrgMemberFn = func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
				if arg.UserID == actor.ID {
					return db.OrgMember{OrganizationID: 7, UserID: actor.ID, Role: "owner"}, nil
				}
				return db.OrgMember{}, pgx.ErrNoRows
			}
		}))
		err := svc.RemoveOrgMember(ctx, actor, "acme", "bob")
		requireAPIErrorStatus(t, err, http.StatusNotFound)

		svc = NewOrgService(ownerOrgQuerier(func(q *mockOrgQuerier) {
			q.getUserByLowerUsernameFn = func(ctx context.Context, lowerUsername string) (db.User, error) {
				return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
			}
			q.getOrgMemberFn = func(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
				if arg.UserID == actor.ID {
					return db.OrgMember{OrganizationID: 7, UserID: actor.ID, Role: "owner"}, nil
				}
				return db.OrgMember{OrganizationID: 7, UserID: arg.UserID, Role: "member"}, nil
			}
			q.removeOrgMemberFn = func(ctx context.Context, arg db.RemoveOrgMemberParams) error {
				return errors.New("remove org member failed")
			}
		}))
		err = svc.RemoveOrgMember(ctx, actor, "acme", "bob")
		requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	})
}

func TestOrg_Cov_DispatchAndUniqueHelpers(t *testing.T) {
	ctx := context.Background()

	svc := NewOrgService(&mockOrgQuerier{})
	svc.dispatchOrganizationEvent(ctx, 7, nil, "created")
	svc.dispatchTeamRepositoryEvent(ctx, db.Repository{ID: 9, Name: "Repo"}, " ACME ", nil, "repo_added")
	svc.dispatchTeamLifecycleEvent(ctx, 7, nil, "created")

	dispatcher := &mockOrgDispatcher{
		dispatchOrgFn: func(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error {
			return errors.New("org dispatch failed")
		},
	}
	svc = NewOrgService(&mockOrgQuerier{}, WithOrgWebhookDispatcher(dispatcher))
	svc.dispatchOrganizationEvent(ctx, 7, testOrgUser(1, "alice"), "created") // logged, never fails the caller

	dispatcher = &mockOrgDispatcher{}
	svc = NewOrgService(&mockOrgQuerier{}, WithOrgWebhookDispatcher(dispatcher))
	svc.dispatchTeamRepositoryEvent(ctx, db.Repository{ID: 9, Name: "Repo"}, " ACME ", nil, "repo_added")
	require.Len(t, dispatcher.calls, 1)
	payload, ok := dispatcher.calls[0].payload.(webhooks.RepositoryEventPayload)
	require.True(t, ok)
	assert.Equal(t, "acme/Repo", payload.Repository.FullName)
	assert.Empty(t, payload.Sender.Login)

	assert.False(t, isUniqueViolation(nil))
	assert.True(t, isUniqueViolation(errors.New("duplicate key value violates unique constraint")))
	assert.False(t, isUniqueViolation(&pgconn.PgError{Code: "23503"}))
}
