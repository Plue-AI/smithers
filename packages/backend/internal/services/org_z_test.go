package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

func orgZActor() *db.User {
	return testOrgUser(1, "alice")
}

func orgZTeam() db.Team {
	return db.Team{ID: 8, OrganizationID: 7, Name: "ops", LowerName: "ops", Permission: "read"}
}

func orgZRepo() db.Repository {
	return db.Repository{ID: 22, Name: "demo", LowerName: "demo", OrgID: pgtype.Int8{Int64: 7, Valid: true}}
}

func orgZQuerier() *mockOrgQuerier {
	return &mockOrgQuerier{
		getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
			return testOrg("private"), nil
		},
		getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 7, UserID: 1, Role: "owner"}, nil
		},
		getTeamByOrgAndLowerNameFn: func(context.Context, db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return orgZTeam(), nil
		},
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return db.User{ID: 2, Username: "bob", LowerUsername: "bob"}, nil
		},
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return orgZRepo(), nil
		},
	}
}

func TestOrg_Z_ConstructorsTransactionsAndCreateErrors(t *testing.T) {
	ctx := context.Background()
	pool := getAgentTestPool(t)

	dispatcher := &mockOrgDispatcher{}
	svc := NewOrgServiceWithPool(orgZQuerier(), pool, nil, WithOrgWebhookDispatcher(dispatcher))
	require.NotNil(t, svc.txManager)
	assert.Same(t, dispatcher, svc.dispatcher)

	ctxCanceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err := (&pgxOrgTxManager{pool: pool}).BeginCreateTx(ctxCanceled)
	require.Error(t, err)

	noPool := NewOrgServiceWithPool(orgZQuerier(), nil, nil)
	assert.Nil(t, noPool.txManager)

	txSvc := NewOrgService(orgZQuerier(), WithOrgWebhookDispatcher(dispatcher))
	txSvc.txManager = &mockOrgCreateTxManager{beginCreateTxFn: func(context.Context) (orgCreateTx, error) {
		return &mockOrgCreateTx{
			createOrganizationFn: func(context.Context, db.CreateOrganizationParams) (db.Organization, error) {
				return db.Organization{ID: 33, Name: "Acme", LowerName: "acme", Visibility: "private"}, nil
			},
		}, nil
	}}
	org, err := txSvc.CreateOrg(ctx, orgZActor(), CreateOrgRequest{Name: "Acme", Visibility: "private"})
	require.NoError(t, err)
	assert.Equal(t, int64(33), org.ID)

	txSvc.txManager = &mockOrgCreateTxManager{beginCreateTxFn: func(context.Context) (orgCreateTx, error) {
		return nil, errors.New("begin failed")
	}}
	_, err = txSvc.CreateOrg(ctx, orgZActor(), CreateOrgRequest{Name: "Acme"})
	assert.Equal(t, 500, apiStatus(t, err))

	txSvc.txManager = &mockOrgCreateTxManager{beginCreateTxFn: func(context.Context) (orgCreateTx, error) {
		return &mockOrgCreateTx{createOrganizationFn: func(context.Context, db.CreateOrganizationParams) (db.Organization, error) {
			return db.Organization{}, errors.New("insert failed")
		}}, nil
	}}
	_, err = txSvc.CreateOrg(ctx, orgZActor(), CreateOrgRequest{Name: "Acme"})
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewOrgService(&mockOrgQuerier{
		createOrganizationFn: func(context.Context, db.CreateOrganizationParams) (db.Organization, error) {
			return db.Organization{}, errors.New("insert failed")
		},
	}).CreateOrg(ctx, orgZActor(), CreateOrgRequest{Name: "Acme"})
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewOrgService(&mockOrgQuerier{
		createOrganizationFn: func(context.Context, db.CreateOrganizationParams) (db.Organization, error) {
			return db.Organization{ID: 44, Name: "Acme"}, nil
		},
		addOrgMemberFn: func(context.Context, db.AddOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{}, errors.New("member insert failed")
		},
	}).CreateOrg(ctx, orgZActor(), CreateOrgRequest{Name: "Acme"})
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestOrg_Z_GuardsAndResolveErrors(t *testing.T) {
	ctx := context.Background()
	actor := orgZActor()
	emptySvc := NewOrgService(&mockOrgQuerier{})

	nilActorCalls := map[string]func(*OrgService) error{
		"AddOrgMember": func(s *OrgService) error { return s.AddOrgMember(ctx, nil, "acme", 2, "member") },
		"CreateTeam": func(s *OrgService) error {
			_, err := s.CreateTeam(ctx, nil, "acme", CreateTeamRequest{Name: "ops"})
			return err
		},
		"GetTeam": func(s *OrgService) error { _, err := s.GetTeam(ctx, nil, "acme", "ops"); return err },
		"UpdateTeam": func(s *OrgService) error {
			_, err := s.UpdateTeam(ctx, nil, "acme", "ops", UpdateTeamRequest{Name: "ops"})
			return err
		},
		"DeleteTeam":       func(s *OrgService) error { return s.DeleteTeam(ctx, nil, "acme", "ops") },
		"ListTeamMembers":  func(s *OrgService) error { _, _, err := s.ListTeamMembers(ctx, nil, "acme", "ops", 1, 10); return err },
		"AddTeamMember":    func(s *OrgService) error { return s.AddTeamMember(ctx, nil, "acme", "ops", "bob") },
		"RemoveTeamMember": func(s *OrgService) error { return s.RemoveTeamMember(ctx, nil, "acme", "ops", "bob") },
		"ListTeamRepos":    func(s *OrgService) error { _, _, err := s.ListTeamRepos(ctx, nil, "acme", "ops", 1, 10); return err },
		"AddTeamRepo":      func(s *OrgService) error { return s.AddTeamRepo(ctx, nil, "acme", "ops", "acme", "demo") },
		"RemoveTeamRepo":   func(s *OrgService) error { return s.RemoveTeamRepo(ctx, nil, "acme", "ops", "acme", "demo") },
	}
	for name, call := range nilActorCalls {
		t.Run("nil actor "+name, func(t *testing.T) {
			require.Error(t, call(NewOrgService(orgZQuerier())))
		})
	}

	resolveOrgCalls := map[string]func(*OrgService) error{
		"UpdateOrg": func(s *OrgService) error {
			_, err := s.UpdateOrg(ctx, actor, "missing", UpdateOrgRequest{Name: "x"})
			return err
		},
		"ListOrgRepos":   func(s *OrgService) error { _, _, err := s.ListOrgRepos(ctx, actor, "missing", 1, 10); return err },
		"ListOrgMembers": func(s *OrgService) error { _, _, err := s.ListOrgMembers(ctx, actor, "missing", 1, 10); return err },
		"AddOrgMember":   func(s *OrgService) error { return s.AddOrgMember(ctx, actor, "missing", 2, "member") },
		"ListOrgTeams":   func(s *OrgService) error { _, _, err := s.ListOrgTeams(ctx, actor, "missing", 1, 10); return err },
		"CreateTeam": func(s *OrgService) error {
			_, err := s.CreateTeam(ctx, actor, "missing", CreateTeamRequest{Name: "ops"})
			return err
		},
		"GetTeam": func(s *OrgService) error { _, err := s.GetTeam(ctx, actor, "missing", "ops"); return err },
		"UpdateTeam": func(s *OrgService) error {
			_, err := s.UpdateTeam(ctx, actor, "missing", "ops", UpdateTeamRequest{})
			return err
		},
		"DeleteTeam": func(s *OrgService) error { return s.DeleteTeam(ctx, actor, "missing", "ops") },
		"ListTeamMembers": func(s *OrgService) error {
			_, _, err := s.ListTeamMembers(ctx, actor, "missing", "ops", 1, 10)
			return err
		},
		"AddTeamMember":    func(s *OrgService) error { return s.AddTeamMember(ctx, actor, "missing", "ops", "bob") },
		"RemoveTeamMember": func(s *OrgService) error { return s.RemoveTeamMember(ctx, actor, "missing", "ops", "bob") },
		"ListTeamRepos": func(s *OrgService) error {
			_, _, err := s.ListTeamRepos(ctx, actor, "missing", "ops", 1, 10)
			return err
		},
		"AddTeamRepo":     func(s *OrgService) error { return s.AddTeamRepo(ctx, actor, "missing", "ops", "acme", "demo") },
		"RemoveTeamRepo":  func(s *OrgService) error { return s.RemoveTeamRepo(ctx, actor, "missing", "ops", "acme", "demo") },
		"RemoveOrgMember": func(s *OrgService) error { return s.RemoveOrgMember(ctx, actor, "missing", "bob") },
	}
	for name, call := range resolveOrgCalls {
		t.Run("resolve org "+name, func(t *testing.T) {
			require.Error(t, call(emptySvc))
		})
	}

	_, err := NewOrgService(orgZQuerier()).GetOrg(ctx, nil, "acme")
	assert.Equal(t, 404, apiStatus(t, err))

	_, err = NewOrgService(orgZQuerier()).GetOrg(ctx, actor, "acme")
	require.NoError(t, err)
}

func TestOrg_Z_UpdateListAndTeamBranches(t *testing.T) {
	ctx := context.Background()
	actor := orgZActor()

	q := orgZQuerier()
	q.updateOrganizationFn = func(context.Context, db.UpdateOrganizationParams) (db.Organization, error) {
		return db.Organization{}, &pgconn.PgError{Code: "23505"}
	}
	_, err := NewOrgService(q).UpdateOrg(ctx, actor, "acme", UpdateOrgRequest{Description: "updated"})
	assert.Equal(t, 409, apiStatus(t, err))

	q = orgZQuerier()
	q.updateOrganizationFn = func(context.Context, db.UpdateOrganizationParams) (db.Organization, error) {
		return db.Organization{}, errors.New("update failed")
	}
	_, err = NewOrgService(q).UpdateOrg(ctx, actor, "acme", UpdateOrgRequest{Description: "updated"})
	assert.Equal(t, 500, apiStatus(t, err))

	q = orgZQuerier()
	q.updateOrganizationFn = func(_ context.Context, arg db.UpdateOrganizationParams) (db.Organization, error) {
		assert.Equal(t, "https://example.test", arg.Website)
		assert.Equal(t, "NYC", arg.Location)
		return db.Organization{ID: arg.ID, Name: arg.Name, Website: arg.Website, Location: arg.Location, Visibility: arg.Visibility}, nil
	}
	_, err = NewOrgService(q).UpdateOrg(ctx, actor, "acme", UpdateOrgRequest{
		Website:  "https://example.test",
		Location: "NYC",
	})
	require.NoError(t, err)

	_, err = NewOrgService(orgZQuerier()).UpdateOrg(ctx, actor, "acme", UpdateOrgRequest{Name: strings.Repeat("x", 256)})
	assert.Equal(t, 422, apiStatus(t, err))

	q = orgZQuerier()
	q.getOrgMemberFn = func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
		return db.OrgMember{}, errors.New("member lookup failed")
	}
	_, _, err = NewOrgService(q).ListOrgRepos(ctx, actor, "acme", 1, 10)
	assert.Equal(t, 500, apiStatus(t, err))

	q = orgZQuerier()
	q.countOrgMembersFn = func(context.Context, int64) (int64, error) { return 0, errors.New("count failed") }
	_, _, err = NewOrgService(q).ListOrgMembers(ctx, actor, "acme", 1, 10)
	assert.Equal(t, 500, apiStatus(t, err))

	q = orgZQuerier()
	q.listOrgTeamsFn = func(context.Context, db.ListOrgTeamsParams) ([]db.Team, error) {
		return nil, errors.New("list failed")
	}
	_, _, err = NewOrgService(q).ListOrgTeams(ctx, actor, "acme", 1, 10)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = NewOrgService(orgZQuerier()).CreateTeam(ctx, actor, "acme", CreateTeamRequest{Name: "bad\x00team"})
	assert.Equal(t, 422, apiStatus(t, err))

	q = orgZQuerier()
	q.createTeamFn = func(context.Context, db.CreateTeamParams) (db.Team, error) {
		return db.Team{}, errors.New("create failed")
	}
	_, err = NewOrgService(q).CreateTeam(ctx, actor, "acme", CreateTeamRequest{Name: "ops"})
	assert.Equal(t, 500, apiStatus(t, err))

	q = orgZQuerier()
	q.getTeamByOrgAndLowerNameFn = func(context.Context, db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
		return db.Team{}, pgx.ErrNoRows
	}
	_, err = NewOrgService(q).UpdateTeam(ctx, actor, "acme", "missing", UpdateTeamRequest{})
	assert.Equal(t, 404, apiStatus(t, err))

	q = orgZQuerier()
	q.updateTeamFn = func(_ context.Context, arg db.UpdateTeamParams) (db.Team, error) {
		assert.Equal(t, "new description", arg.Description)
		return db.Team{ID: arg.ID, Name: arg.Name, Description: arg.Description, Permission: arg.Permission}, nil
	}
	_, err = NewOrgService(q).UpdateTeam(ctx, actor, "acme", "ops", UpdateTeamRequest{Description: "new description"})
	require.NoError(t, err)

	_, err = NewOrgService(orgZQuerier()).UpdateTeam(ctx, actor, "acme", "ops", UpdateTeamRequest{Name: strings.Repeat("x", 256)})
	assert.Equal(t, 422, apiStatus(t, err))

	q = orgZQuerier()
	q.updateTeamFn = func(context.Context, db.UpdateTeamParams) (db.Team, error) {
		return db.Team{}, &pgconn.PgError{Code: "23505"}
	}
	_, err = NewOrgService(q).UpdateTeam(ctx, actor, "acme", "ops", UpdateTeamRequest{Name: "ops2"})
	assert.Equal(t, 409, apiStatus(t, err))

	q = orgZQuerier()
	q.getTeamByOrgAndLowerNameFn = func(context.Context, db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
		return db.Team{}, pgx.ErrNoRows
	}
	assert.Equal(t, 404, apiStatus(t, NewOrgService(q).DeleteTeam(ctx, actor, "acme", "ops")))

	resolveTeamErr := func() *mockOrgQuerier {
		q := orgZQuerier()
		q.getTeamByOrgAndLowerNameFn = func(context.Context, db.GetTeamByOrgAndLowerNameParams) (db.Team, error) {
			return db.Team{}, pgx.ErrNoRows
		}
		return q
	}
	_, _, err = NewOrgService(resolveTeamErr()).ListTeamMembers(ctx, actor, "acme", "ops", 1, 10)
	assert.Equal(t, 404, apiStatus(t, err))
	assert.Equal(t, 404, apiStatus(t, NewOrgService(resolveTeamErr()).AddTeamMember(ctx, actor, "acme", "ops", "bob")))
	assert.Equal(t, 404, apiStatus(t, NewOrgService(resolveTeamErr()).RemoveTeamMember(ctx, actor, "acme", "ops", "bob")))
	_, _, err = NewOrgService(resolveTeamErr()).ListTeamRepos(ctx, actor, "acme", "ops", 1, 10)
	assert.Equal(t, 404, apiStatus(t, err))
	assert.Equal(t, 404, apiStatus(t, NewOrgService(resolveTeamErr()).AddTeamRepo(ctx, actor, "acme", "ops", "acme", "demo")))
	assert.Equal(t, 404, apiStatus(t, NewOrgService(resolveTeamErr()).RemoveTeamRepo(ctx, actor, "acme", "ops", "acme", "demo")))

	q = orgZQuerier()
	q.countTeamMembersFn = func(context.Context, int64) (int64, error) { return 0, errors.New("count failed") }
	_, _, err = NewOrgService(q).ListTeamMembers(ctx, actor, "acme", "ops", 1, 10)
	assert.Equal(t, 500, apiStatus(t, err))

	q = orgZQuerier()
	q.listTeamReposFn = func(context.Context, db.ListTeamReposParams) ([]db.Repository, error) {
		return nil, errors.New("list failed")
	}
	_, _, err = NewOrgService(q).ListTeamRepos(ctx, actor, "acme", "ops", 1, 10)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestOrg_Z_TeamMembershipRepoAndRemovalErrors(t *testing.T) {
	ctx := context.Background()
	actor := orgZActor()

	q := orgZQuerier()
	q.getUserByLowerUsernameFn = func(context.Context, string) (db.User, error) {
		return db.User{}, pgx.ErrNoRows
	}
	assert.Equal(t, 404, apiStatus(t, NewOrgService(q).AddTeamMember(ctx, actor, "acme", "ops", "bob")))

	q = orgZQuerier()
	q.addTeamMemberIfOrgMemberFn = func(context.Context, db.AddTeamMemberIfOrgMemberParams) (db.TeamMember, error) {
		return db.TeamMember{}, errors.New("insert failed")
	}
	assert.Equal(t, 500, apiStatus(t, NewOrgService(q).AddTeamMember(ctx, actor, "acme", "ops", "bob")))

	assert.Equal(t, 400, apiStatus(t, NewOrgService(orgZQuerier()).RemoveTeamMember(ctx, actor, "acme", "ops", " ")))

	q = orgZQuerier()
	q.getUserByLowerUsernameFn = func(context.Context, string) (db.User, error) {
		return db.User{}, pgx.ErrNoRows
	}
	assert.Equal(t, 404, apiStatus(t, NewOrgService(q).RemoveTeamMember(ctx, actor, "acme", "ops", "bob")))

	q = orgZQuerier()
	q.getUserByLowerUsernameFn = func(context.Context, string) (db.User, error) {
		return db.User{}, errors.New("load failed")
	}
	assert.Equal(t, 500, apiStatus(t, NewOrgService(q).RemoveTeamMember(ctx, actor, "acme", "ops", "bob")))

	q = orgZQuerier()
	q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return db.Repository{}, pgx.ErrNoRows
	}
	assert.Equal(t, 404, apiStatus(t, NewOrgService(q).AddTeamRepo(ctx, actor, "acme", "ops", "acme", "demo")))

	q = orgZQuerier()
	q.addTeamRepoIfOrgRepoFn = func(context.Context, db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
		return db.TeamRepo{}, errors.New("insert failed")
	}
	assert.Equal(t, 500, apiStatus(t, NewOrgService(q).AddTeamRepo(ctx, actor, "acme", "ops", "acme", "demo")))

	q = orgZQuerier()
	q.addTeamRepoIfOrgRepoFn = func(context.Context, db.AddTeamRepoIfOrgRepoParams) (db.TeamRepo, error) {
		return db.TeamRepo{}, nil
	}
	dispatcher := &mockOrgDispatcher{dispatchFn: func(context.Context, int64, webhooks.EventType, any) error {
		return errors.New("dispatch failed")
	}}
	assert.NoError(t, NewOrgService(q, WithOrgWebhookDispatcher(dispatcher)).AddTeamRepo(ctx, actor, "acme", "ops", "acme", "demo"), "webhook enqueue is best effort after commit")

	q = orgZQuerier()
	q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return db.Repository{}, pgx.ErrNoRows
	}
	assert.Equal(t, 404, apiStatus(t, NewOrgService(q).RemoveTeamRepo(ctx, actor, "acme", "ops", "acme", "demo")))

	q = orgZQuerier()
	q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return db.Repository{}, errors.New("load failed")
	}
	assert.Equal(t, 500, apiStatus(t, NewOrgService(q).RemoveTeamRepo(ctx, actor, "acme", "ops", "acme", "demo")))

	q = orgZQuerier()
	dispatcher = &mockOrgDispatcher{dispatchFn: func(context.Context, int64, webhooks.EventType, any) error {
		return errors.New("dispatch failed")
	}}
	assert.NoError(t, NewOrgService(q, WithOrgWebhookDispatcher(dispatcher)).RemoveTeamRepo(ctx, actor, "acme", "ops", "acme", "demo"), "webhook enqueue is best effort after commit")

	q = orgZQuerier()
	q.getUserByLowerUsernameFn = func(context.Context, string) (db.User, error) {
		return db.User{}, errors.New("load failed")
	}
	assert.Equal(t, 500, apiStatus(t, NewOrgService(q).RemoveOrgMember(ctx, actor, "acme", "bob")))

	q = orgZQuerier()
	q.getOrgMemberFn = func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
		if arg.UserID == actor.ID {
			return db.OrgMember{OrganizationID: 7, UserID: actor.ID, Role: "owner"}, nil
		}
		return db.OrgMember{}, errors.New("target lookup failed")
	}
	assert.Equal(t, 500, apiStatus(t, NewOrgService(q).RemoveOrgMember(ctx, actor, "acme", "bob")))

	q = orgZQuerier()
	q.getOrgMemberFn = func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
		if arg.UserID == actor.ID {
			return db.OrgMember{OrganizationID: 7, UserID: actor.ID, Role: "owner"}, nil
		}
		return db.OrgMember{OrganizationID: 7, UserID: arg.UserID, Role: "member"}, nil
	}
	q.deleteTeamMembershipsForOrgUserFn = func(context.Context, db.DeleteTeamMembershipsForOrgUserParams) error {
		return errors.New("delete team memberships failed")
	}
	assert.Equal(t, 500, apiStatus(t, NewOrgService(q).RemoveOrgMember(ctx, actor, "acme", "bob")))
}
