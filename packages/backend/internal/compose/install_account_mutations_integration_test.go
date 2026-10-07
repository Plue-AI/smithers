package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type accountMutationProbe struct {
	routes.UserProfileService
	before            func()
	userID, accountID int64
	bio               *string
}

func (p *accountMutationProbe) UpdateAuthenticatedUser(ctx context.Context, userID int64, input services.UpdateUserRequest) (services.UserProfile, error) {
	if p.before != nil {
		p.before()
	}
	if p.userID != 0 {
		userID = p.userID
	}
	if p.bio != nil {
		input.Bio = p.bio
	}
	return p.UserProfileService.UpdateAuthenticatedUser(ctx, userID, input)
}
func (p *accountMutationProbe) DeleteConnectedAccount(ctx context.Context, userID, accountID int64) error {
	if p.accountID != 0 {
		accountID = p.accountID
	}
	return p.UserProfileService.DeleteConnectedAccount(ctx, userID, accountID)
}

type accountDeviceProbe struct {
	routes.UserDeviceRouteService
	before  func()
	replace bool
	userID  int64
}

func (p *accountDeviceProbe) RegisterDevice(ctx context.Context, userID int64, input services.RegisterUserDeviceRequest) (services.UserDeviceResponse, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		input.Platform = "android"
	}
	if p.userID != 0 {
		userID = p.userID
	}
	return p.UserDeviceRouteService.RegisterDevice(ctx, userID, input)
}
func (p *accountDeviceProbe) DeleteDevice(ctx context.Context, userID int64, token string) error {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		token = "other-device"
	}
	if p.userID != 0 {
		userID = p.userID
	}
	return p.UserDeviceRouteService.DeleteDevice(ctx, userID, token)
}

type accountSignupProbe struct {
	routes.UserSignupProfileService
	before  func()
	replace bool
	userID  int64
}

func (p *accountSignupProbe) Put(ctx context.Context, userID int64, input services.SignupProfile) (services.SignupProfileReceipt, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		input.Answers = map[string]services.SignupAnswer{"replaced": {One: "different"}}
	}
	if p.userID != 0 {
		userID = p.userID
	}
	return p.UserSignupProfileService.Put(ctx, userID, input)
}

func TestInstallAccountMutationsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName, cfg.Auth.SessionRefreshWindow = "selfhost", "session", "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewUserService(q, services.WithUserInstallAuthorization(pool))
	devices := services.NewUserDeviceService(q, services.WithUserDeviceInstallAuthorization(pool))
	signup := services.NewSignupProfileService(q, services.WithSignupProfileInstallAuthorization(pool))
	handler := &routes.UserHandler{ProfileService: service, DeviceService: devices, SignupProfiles: signup}
	router := buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, handler, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerCookie, memberCookie := "account-owner", "account-member"
	ownerHash := session(f.owner, ownerCookie)
	session(f.other, memberCookie)
	connect := func(user db.User, name string) db.OauthAccount {
		row, err := f.q.CreateOAuthAccount(f.ctx, db.CreateOAuthAccountParams{UserID: user.ID, Provider: "github", ProviderUserID: name, AccessTokenEncrypted: []byte("private-sealed-token"), ProfileData: json.RawMessage(`{}`)})
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `INSERT INTO github_synced_repo_read_grants(user_id,owner_login_lower,repo_name_lower) VALUES($1,'private-source','repo')`, user.ID)
		require.NoError(t, err)
		return row
	}
	ownerAccount, otherAccount := connect(f.owner, "owner"), connect(f.other, "member")
	external := f.token(f.owner, "account-external", "write:user,via:codex", true)
	app := f.token(f.owner, "account-app", "write:user,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	run := f.token(f.owner, "account-run", "write:user", true)
	machine := f.token(f.owner, "account-machine", "write:user,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	request := func(method, path, cookie, bearer, body string) *http.Request {
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("X-CSRF-Token", "account-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "account-csrf"})
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		return req
	}
	call := func(t *testing.T, method, path, cookie, bearer, body, command string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := request(method, path, cookie, bearer, body)
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{command}, commands)
		require.NotContains(t, out.Body.String(), "private-sealed-token")
		return out
	}
	assertConnections := func(t *testing.T, ownerCount int) {
		t.Helper()
		accounts, err := f.q.ListUserOAuthAccounts(f.ctx, f.owner.ID)
		require.NoError(t, err)
		require.Len(t, accounts, ownerCount)
		accounts, err = f.q.ListUserOAuthAccounts(f.ctx, f.other.ID)
		require.NoError(t, err)
		require.Len(t, accounts, 1)
		require.Equal(t, otherAccount.ID, accounts[0].ID)
	}
	signupBody := `{"name":"Owner","account":"owner-account","stage":"poll","question":1,"answers":{"choices":["one","two"],"text":"hello"}}`
	assertSetup := func(t *testing.T, count int, name string) {
		t.Helper()
		var deviceCount int
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM user_devices WHERE user_id=$1`, f.owner.ID).Scan(&deviceCount))
		require.Equal(t, count, deviceCount)
		profile, err := signup.Get(f.ctx, f.owner.ID)
		require.NoError(t, err)
		if name == "" {
			require.Nil(t, profile.Profile)
		} else {
			require.NotNil(t, profile.Profile)
			require.Equal(t, name, profile.Profile.Name)
		}
		other, err := signup.Get(f.ctx, f.other.ID)
		require.NoError(t, err)
		require.Nil(t, other.Profile)
	}
	for _, actor := range []struct {
		name, cookie, bearer string
		status               int
		code                 string
	}{
		{"member", memberCookie, "", 403, "permission"},
		{"external", "", external, 403, "never"},
		{"app", "", app, 403, "never"},
		{"run", "", run, 403, "permission"},
		{"machine", "", machine, 403, "permission"},
		{"read-only", "", f.token(f.owner, "account-read", "read:user,via:codex", true), 403, "permission"},
		{"repository-scope", "", f.token(f.owner, "account-repository", "write:repository,via:codex", true), 403, "permission"},
		{"anonymous", "", "", 401, "unauthenticated"},
	} {
		for _, op := range []struct{ method, path, body, command string }{
			{"PUT", "/api/user/settings/signup", signupBody, "account.signup.update"},
			{"POST", "/api/user/devices", `{"apns_token":"own-device","platform":"ios"}`, "account.device.register"},
			{"DELETE", "/api/user/devices", `{"apns_token":"own-device"}`, "account.device.delete"},
			{"PATCH", "/api/user", `{"display_name":"must not change"}`, "account.profile.update"},
			{"PUT", "/api/user/settings/notifications", `{"email_notifications_enabled":false}`, "account.notifications.update"},
			{"DELETE", fmt.Sprintf("/api/user/connections/%d", ownerAccount.ID), "", "account.connection.delete"},
		} {
			t.Run(actor.name+"/"+op.command, func(t *testing.T) {
				out := call(t, op.method, op.path, actor.cookie, actor.bearer, op.body, op.command, actor.status)
				require.Contains(t, out.Body.String(), `"code":"`+actor.code+`"`)
				owner, err := f.q.GetUserByID(f.ctx, f.owner.ID)
				require.NoError(t, err)
				require.Equal(t, f.owner.DisplayName, owner.DisplayName)
				require.True(t, owner.EmailNotificationsEnabled)
				assertConnections(t, 1)
				assertSetup(t, 0, "")
			})
		}
	}

	t.Run("owner saves signup and registers own device", func(t *testing.T) {
		call(t, "PUT", "/api/user/settings/signup", ownerCookie, "", signupBody, "account.signup.update", 200)
		out := call(t, "POST", "/api/user/devices", ownerCookie, "", fmt.Sprintf(`{"apns_token":"own-device","platform":"ios","user_id":%d}`, f.other.ID), "account.device.register", 201)
		var receipt services.UserDeviceResponse
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &receipt))
		require.Equal(t, f.owner.ID, receipt.UserID)
		require.Equal(t, "ios", receipt.Platform)
		profile, err := signup.Get(f.ctx, f.owner.ID)
		require.NoError(t, err)
		raw, err := json.Marshal(profile.Profile.Answers)
		require.NoError(t, err)
		require.JSONEq(t, `{"choices":["one","two"],"text":"hello"}`, string(raw))
		assertSetup(t, 1, "Owner")
	})
	for _, op := range []struct{ method, path, body, command string }{
		{"PUT", "/api/user/settings/signup", signupBody, "account.signup.update"},
		{"POST", "/api/user/devices", `{"apns_token":"own-device","platform":"ios"}`, "account.device.register"},
		{"DELETE", "/api/user/devices", `{"apns_token":"own-device"}`, "account.device.delete"},
	} {
		for _, mode := range []string{"payload", "account", "expired"} {
			t.Run(op.command+"/substitution/"+mode, func(t *testing.T) {
				dp := &accountDeviceProbe{UserDeviceRouteService: devices}
				sp := &accountSignupProbe{UserSignupProfileService: signup}
				status := 403
				switch mode {
				case "payload":
					dp.replace, sp.replace = true, true
				case "account":
					dp.userID, sp.userID = f.other.ID, f.other.ID
				case "expired":
					status = 401
					before := func() {
						_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
						require.NoError(t, err)
					}
					dp.before, sp.before = before, before
				}
				handler.DeviceService, handler.SignupProfiles = dp, sp
				defer func() {
					handler.DeviceService, handler.SignupProfiles = devices, signup
					_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
					require.NoError(t, err)
				}()
				call(t, op.method, op.path, ownerCookie, "", op.body, op.command, status)
				assertSetup(t, 1, "Owner")
				var platform string
				require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT platform FROM user_devices WHERE apns_token='own-device'`).Scan(&platform))
				require.Equal(t, "ios", platform)
				profile, err := signup.Get(f.ctx, f.owner.ID)
				require.NoError(t, err)
				require.Equal(t, "hello", profile.Profile.Answers["text"].One)
			})
		}
	}
	t.Run("owner deletes only own device", func(t *testing.T) {
		_, err := f.q.UpsertUserDevice(f.ctx, db.UpsertUserDeviceParams{UserID: f.other.ID, ApnsToken: "other-device", Platform: "android"})
		require.NoError(t, err)
		call(t, "DELETE", "/api/user/devices", ownerCookie, "", `{"apns_token":"other-device"}`, "account.device.delete", 204)
		var otherDevices int
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM user_devices WHERE user_id=$1`, f.other.ID).Scan(&otherDevices))
		require.Equal(t, 1, otherDevices)
		call(t, "DELETE", "/api/user/devices", ownerCookie, "", `{"apns_token":"own-device","platform":"ignored"}`, "account.device.delete", 204)
		assertSetup(t, 0, "Owner")
	})
	t.Run("signup and device validation has no partial effects", func(t *testing.T) {
		for _, op := range []struct {
			method, path, body, command string
			status                      int
		}{
			{"PUT", "/api/user/settings/signup", `{"name":"Changed","account":"invalid!","stage":"poll"}`, "account.signup.update", 422},
			{"PUT", "/api/user/settings/signup", `{"answers":{"bad":{}}}`, "account.signup.update", 400},
			{"POST", "/api/user/devices", `{"apns_token":"invalid token"}`, "account.device.register", 400},
			{"DELETE", "/api/user/devices", `{"apns_token":[]}`, "account.device.delete", 400},
		} {
			call(t, op.method, op.path, ownerCookie, "", op.body, op.command, op.status)
			call(t, op.method, op.path, "", external, op.body, op.command, 403)
		}
		assertSetup(t, 0, "Owner")
	})
	t.Run("invalid input still checks credential eligibility", func(t *testing.T) {
		for _, body := range []string{`{"bio":[]}`, `{"bio":"first"} {"bio":"second"}`} {
			call(t, "PATCH", "/api/user", ownerCookie, "", body, "account.profile.update", 400)
			out := call(t, "PATCH", "/api/user", "", external, body, "account.profile.update", 403)
			require.Contains(t, out.Body.String(), `"code":"never"`)
		}
		call(t, "PATCH", "/api/user", ownerCookie, "", `{"bio":"`+strings.Repeat("a", 1<<20)+`"}`, "account.profile.update", 413)
		owner, err := f.q.GetUserByID(f.ctx, f.owner.ID)
		require.NoError(t, err)
		require.Equal(t, f.owner.DisplayName, owner.DisplayName)
		require.Equal(t, f.owner.Bio, owner.Bio)
	})
	t.Run("owner writes only own profile and preferences", func(t *testing.T) {
		body := fmt.Sprintf(`{"display_name":"Changed owner","bio":"Bound bio","email":"ignored@example.test","user_id":%d}`, f.other.ID)
		call(t, "PATCH", "/api/user", ownerCookie, "", body, "account.profile.update", 200)
		call(t, "PUT", "/api/user/settings/notifications", ownerCookie, "", `{"email_notifications_enabled":false}`, "account.notifications.update", 200)
		owner, err := f.q.GetUserByID(f.ctx, f.owner.ID)
		require.NoError(t, err)
		require.Equal(t, "Changed owner", owner.DisplayName)
		require.Equal(t, "Bound bio", owner.Bio)
		require.Equal(t, f.owner.Email, owner.Email)
		require.False(t, owner.EmailNotificationsEnabled)
		other, err := f.q.GetUserByID(f.ctx, f.other.ID)
		require.NoError(t, err)
		require.Equal(t, f.other.DisplayName, other.DisplayName)
		require.True(t, other.EmailNotificationsEnabled)
	})
	for _, mode := range []string{"payload", "account", "connection", "expired"} {
		t.Run("substitution/"+mode, func(t *testing.T) {
			probe := &accountMutationProbe{UserProfileService: service}
			method, path, body, command, status := "PATCH", "/api/user", `{"bio":"admitted"}`, "account.profile.update", 403
			switch mode {
			case "payload":
				replacement := "replaced"
				probe.bio = &replacement
			case "account":
				probe.userID = f.other.ID
			case "connection":
				probe.accountID = otherAccount.ID
				method, path, body, command = "DELETE", fmt.Sprintf("/api/user/connections/%d", ownerAccount.ID), "", "account.connection.delete"
			case "expired":
				status = 401
				probe.before = func() {
					_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
					require.NoError(t, err)
				}
			}
			handler.ProfileService = probe
			defer func() {
				handler.ProfileService = service
				_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
				require.NoError(t, err)
			}()
			call(t, method, path, ownerCookie, "", body, command, status)
			owner, err := f.q.GetUserByID(f.ctx, f.owner.ID)
			require.NoError(t, err)
			require.Equal(t, "Bound bio", owner.Bio)
			assertConnections(t, 1)
		})
	}
	t.Run("expiry during grant deletion rolls back the account deletion", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(f.ctx, 12*time.Second)
		defer cancel()
		held, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer held.Rollback(context.Background())
		_, err = held.Exec(ctx, `SELECT user_id FROM github_synced_repo_read_grants WHERE user_id=$1 FOR UPDATE`, f.owner.ID)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, ownerHash, deadline)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		req := request("DELETE", fmt.Sprintf("/api/user/connections/%d", ownerAccount.ID), ownerCookie, "", "")
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) }))
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { out := httptest.NewRecorder(); router.ServeHTTP(out, req); done <- out }()
		require.Eventually(t, func() bool {
			var count int
			err := f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%DELETE FROM github_synced_repo_read_grants%'`).Scan(&count)
			return err == nil && count == 1
		}, 3*time.Second, 10*time.Millisecond)
		timer := time.NewTimer(time.Until(deadline) + 25*time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.NoError(t, held.Commit(ctx))
		select {
		case out := <-done:
			require.Equal(t, 401, out.Code, out.Body.String())
			require.Contains(t, out.Body.String(), `"code":"unauthenticated"`)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.Equal(t, []string{"account.connection.delete"}, commands)
		assertConnections(t, 1)
		var grants int
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM github_synced_repo_read_grants WHERE user_id=$1`, f.owner.ID).Scan(&grants))
		require.Equal(t, 1, grants)
	})
	t.Run("connection removal preserves other accounts and revokes own read grants", func(t *testing.T) {
		call(t, "DELETE", fmt.Sprintf("/api/user/connections/%d", ownerAccount.ID), ownerCookie, "", "", "account.connection.delete", 204)
		assertConnections(t, 0)
		var grants int
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM github_synced_repo_read_grants WHERE user_id=$1`, f.owner.ID).Scan(&grants))
		require.Zero(t, grants)
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM github_synced_repo_read_grants WHERE user_id=$1`, f.other.ID).Scan(&grants))
		require.Equal(t, 1, grants)
	})
	t.Run("direct signup and device services require live own-account authority", func(t *testing.T) {
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		profile := services.SignupProfile{Name: "Direct owner", Account: "direct-owner", Stage: "ready"}
		for _, op := range []struct {
			command string
			effect  func(context.Context, int64) error
		}{
			{"account.signup.update", func(ctx context.Context, id int64) error { _, err := signup.Put(ctx, id, profile); return err }},
			{"account.device.register", func(ctx context.Context, id int64) error {
				_, err := devices.RegisterDevice(ctx, id, services.RegisterUserDeviceRequest{APNSToken: "direct-device"})
				return err
			}},
			{"account.device.delete", func(ctx context.Context, id int64) error { return devices.DeleteDevice(ctx, id, "direct-device") }},
		} {
			var commands []string
			observed := services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
			require.NoError(t, op.effect(observed, f.owner.ID))
			require.Equal(t, []string{op.command}, commands)
			for _, denied := range []struct {
				ctx    context.Context
				id     int64
				status int
			}{{f.ctx, f.owner.ID, 401}, {ctx, f.other.ID, 403}} {
				err := op.effect(denied.ctx, denied.id)
				var refusal *services.AccessError
				require.ErrorAs(t, err, &refusal)
				require.Equal(t, denied.status, refusal.Status)
			}
		}
		assertSetup(t, 0, "Direct owner")
	})
	t.Run("direct service entry authenticates and binds the account", func(t *testing.T) {
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		var commands []string
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		value := "direct"
		_, err := service.UpdateAuthenticatedUser(ctx, f.owner.ID, services.UpdateUserRequest{Bio: &value})
		require.NoError(t, err)
		require.Equal(t, []string{"account.profile.update"}, commands)
		_, err = service.UpdateAuthenticatedUser(f.ctx, f.owner.ID, services.UpdateUserRequest{Bio: &value})
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
		_, err = service.UpdateAuthenticatedUser(ctx, f.other.ID, services.UpdateUserRequest{Bio: &value})
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 403, refusal.Status)
	})
}
