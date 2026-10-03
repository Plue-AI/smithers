package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestHostStatusAuthenticatedHTTPModelPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	u, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "hostowner", LowerUsername: "hostowner"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES ($1)`, u.ID)
	require.NoError(t, err)
	actor := u.ID
	token := func(value, scope string) string {
		seed := sha256.Sum256([]byte(value))
		value = "smithers_" + hex.EncodeToString(seed[:])[:40]
		digest := sha256.Sum256([]byte(value))
		hash := hex.EncodeToString(digest[:])
		_, err := q.CreateAccessToken(t.Context(), db.CreateAccessTokenParams{UserID: actor, Name: value, TokenHash: hash, TokenLastEight: hash[56:], Scopes: scope})
		require.NoError(t, err)
		return value
	}
	good := token("smithers_capacity_owner", "read:user")
	writer := token("smithers_capacity_write", "read:user,write:user")
	limited := token("smithers_capacity_limited", "read:repository")
	member, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "hostmember", LowerUsername: "hostmember"})
	require.NoError(t, err)
	actor = member.ID
	nonowner := token("smithers_capacity_member", "read:user,write:user")
	s := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: 400 << 30, MacOSVersion: "15.6", Hypervisor: true}, InUse: func() int { return 1 }}
	require.NoError(t, s.Set(t.Context(), u.ID, 2))
	router := hostStatusProductionRouter(testConfigAllFlagsOn(), q, &routes.HostStatusHandler{Service: s})
	get := func(credential string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/host", nil)
		if credential != "" {
			request.Header.Set("Authorization", "token "+credential)
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}
	require.Equal(t, 401, get("").Code)
	require.Equal(t, 403, get(limited).Code)
	response := get(good)
	require.Equal(t, 200, response.Code)
	var status services.HostStatus
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	// spec §8.2.1 and §14.3: profile + formula limits + effective machines count.
	require.Equal(t, s.Profile, status.Profile)
	require.Equal(t, 3, status.Limits.Capacity)
	require.Equal(t, services.MachineCapacity{InUse: 1, Capacity: 2}, status.Machines)
	// C-MCH-04 steps 3–5: production owner write refuses above-formula values.
	patch := func(credential, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPatch, "/api/host", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if credential != "" {
			request.Header.Set("Authorization", "token "+credential)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	require.Equal(t, 401, patch("", `{"capacity":1}`).Code)
	require.Equal(t, 403, patch(good, `{"capacity":1}`).Code)
	require.Equal(t, 403, patch(nonowner, `{"capacity":1}`).Code)
	require.Equal(t, 400, patch(writer, `{"capacity":1,"extra":true}`).Code)
	require.Equal(t, 400, patch(writer, `{"capacity":1} {}`).Code)
	require.Equal(t, 422, patch(writer, `{"capacity":4}`).Code)
	require.Equal(t, 422, patch(writer, `{"capacity":0}`).Code)
	response = patch(writer, `{"capacity":1}`)
	require.Equal(t, 200, response.Code)
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	require.Equal(t, services.MachineCapacity{InUse: 1, Capacity: 1}, status.Machines)
	s.Profile.DiskFreeBytes = 60 << 30
	response = get(good)
	require.Equal(t, 200, response.Code)
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	require.Zero(t, status.Machines.Capacity)
	require.Equal(t, "disk", status.Limits.LimitingTerm)
	require.NotEmpty(t, status.Limits.Fix)
	_, err = pool.Exec(t.Context(), `UPDATE install_settings SET value='0' WHERE key='capacity'`)
	require.NoError(t, err)
	response = get(good)
	require.Equal(t, 503, response.Code)
	require.JSONEq(t, `{"code":"host_status_unavailable","class":"infra","message":"host status unavailable"}`, response.Body.String())
}
