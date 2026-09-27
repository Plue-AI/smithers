package services

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceGateway_OwnerEnvironmentAndSharing(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	input := RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID}
	q.writableWorkspaceShares = true
	_, err := s.GetRepoGatewayConnectionInfo(context.Background(), input)
	assertAPIErrorStatus(t, err, http.StatusForbidden)
	require.Empty(t, vm.systemdSpecs)
	q.writableWorkspaceShares = false
	_, err = s.GetRepoGatewayConnectionInfo(context.Background(), input)
	require.NoError(t, err)
	require.Len(t, vm.systemdSpecs, 1)
	env := vm.systemdSpecs[0].Env
	assert.NotContains(t, env, "CEREBRAS_API_KEY")
	assert.NotContains(t, env, "OPENAI_API_KEY")
	assert.NotContains(t, env, "ANTHROPIC_AUTH_TOKEN")
	assert.NotEmpty(t, env["SMITHERS_API_KEY"])
	require.NotNil(t, vm.systemdSpecs[0].RestartPolicy.Sec)
	assert.Equal(t, int64(5), *vm.systemdSpecs[0].RestartPolicy.Sec)
}

func TestWorkspaceGateway_ExistingProviderProfilePreservesHostIdentity(t *testing.T) {
	profile := filepath.Join(t.TempDir(), "agent-environment.sh")
	require.NoError(t, os.WriteFile(profile, []byte("export ANTHROPIC_API_KEY='ANTHROPIC_API_KEY'\nexport SMITHERS_API_KEY='repository-value'\nexport SMITHERS_GATEWAY_ID='repository-id'\nexport HOME='/repository-home'\n"), 0600))
	command := workspaceGatewayCommand(runtimeports.RepoGateway{ID: "owned-host"})
	command = strings.ReplaceAll(command, "/etc/profile.d/10-smithers-agent-environment.sh", profile)
	command = command[:strings.LastIndex(command, "\nexec flock")] + "\nprintf '%s\\n' \"$SMITHERS_API_KEY\" \"$SMITHERS_GATEWAY_ID\" \"$ANTHROPIC_API_KEY\" \"$HOME\""
	process := exec.Command("sh", "-c", command)
	process.Env = []string{"SMITHERS_API_KEY=owner-placeholder", "SMITHERS_GATEWAY_ID=owned-host"}
	output, err := process.CombinedOutput()
	require.NoError(t, err, string(output))
	assert.Equal(t, "owner-placeholder\nowned-host\nANTHROPIC_API_KEY\n/home/developer\n", string(output))
}

func TestWorkspaceGateway_RetriesOnlyTombstonedServiceCleanup(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "recovered", true: "stop-failed"}[failed], func(t *testing.T) {
			s, q, vm, w := boundGatewayFixture(t)
			old := runtimeports.RepoGateway{ID: uuid.NewString(), VmID: w.VmID, WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, DeletedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}}
			q.discardedWorkspaceRows = []runtimeports.RepoGateway{old}
			var cleanupSeen bool
			vm.execAwaitFn = func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
				if strings.Contains(request.Command, "LoadState") {
					cleanupSeen = true
					assert.Contains(t, request.Command, workspaceGatewayServiceName(old))
					assert.NotContains(t, request.Command, "smithers-gateway-*")
					assert.NotContains(t, request.Command, q.nextGatewayID)
					if failed {
						return sandbox.ExecResult{}, errors.New("VM stop unavailable")
					}
				}
				zero := int32(0)
				return sandbox.ExecResult{StatusCode: &zero}, nil
			}
			_, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
			require.True(t, cleanupSeen)
			if failed {
				assertAPIErrorStatus(t, err, http.StatusConflict)
				assert.Empty(t, vm.systemdSpecs, "replacement must not race an unstopped lock holder")
			} else {
				require.NoError(t, err)
				require.Len(t, vm.systemdSpecs, 1)
			}
			assert.Empty(t, vm.deletedVMIDs)
		})
	}
}

func TestWorkspaceGateway_BoundActivityAndRevocation(t *testing.T) {
	s, _, vm, w := boundGatewayFixture(t)
	var touched []string
	s.workspaces.q.(*mockWorkspaceQuerier).touchWorkspaceActivityFn = func(_ context.Context, id string) error { touched = append(touched, id); return nil }
	info, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.NoError(t, err)
	require.Contains(t, touched, w.ID)
	publisher := &recordingPublisher{}
	s.revocations = publisher
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{}, errors.New("asleep")
	}
	s.discardGateway(context.Background(), runtimeports.RepoGateway{ID: info.GatewayID, VmID: w.VmID, UserID: w.UserID, RepositoryID: w.RepositoryID, WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}})
	require.Len(t, publisher.all(), 1)
	assert.Equal(t, revocation.KindGatewayRevoked, publisher.all()[0].Kind)
	assert.Equal(t, info.GatewayID, publisher.all()[0].GatewayID)
	assert.Empty(t, vm.deletedVMIDs)
}

func TestWorkspaceGateway_ReaperRetainsFailedCleanupAndRetriesAfterResume(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	old := runtimeports.RepoGateway{ID: uuid.NewString(), VmID: w.VmID, WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true}, DeletedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}, AuthTokenHash: "retained"}
	q.discardedWorkspaceRows = []runtimeports.RepoGateway{old}
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		return sandbox.ExecResult{}, errors.New("asleep")
	}
	s.sweepDiscardedWorkspaceGateways(context.Background())
	require.Empty(t, q.clearedWorkspaceCredentials, "a tombstone is not proof of process death")
	require.Equal(t, []string{old.ID}, q.workspaceCleanupAttempts)
	vm.execAwaitFn = func(_ context.Context, _ string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
		assert.Contains(t, request.Command, workspaceGatewayServiceName(old))
		zero := int32(0)
		return sandbox.ExecResult{StatusCode: &zero}, nil
	}
	s.sweepDiscardedWorkspaceGateways(context.Background())
	require.Equal(t, []string{old.ID}, q.clearedWorkspaceCredentials)
	require.Equal(t, []string{old.ID, old.ID}, q.workspaceCleanupAttempts)
	assert.Empty(t, vm.deletedVMIDs)
}

// The production defect this guards: the workspace gateway service environment
// omitted SMITHERS_JJHUB_TOKEN and SMITHERS_JJHUB_API_URL, so the coding host's
// landing configuration resolved to nothing and coding/vibe — the only flow
// that creates and lands a landing request — was never registered on a live
// workspace.
func TestWorkspaceGateway_LandingCredentialIsRepositoryScopedAndNeverLogged(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	info, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.NoError(t, err)
	require.Len(t, vm.systemdSpecs, 1)
	env := vm.systemdSpecs[0].Env
	landing := env["SMITHERS_JJHUB_TOKEN"]
	require.NotEmpty(t, landing, "coding/vibe never registers without the landing credential")
	assert.True(t, strings.HasPrefix(landing, "smithers_"), landing)
	assert.NotEqual(t, info.Token, landing, "the gateway relay credential is not the landing credential")
	// The coding host refuses a credential whose API base does not match the
	// apiBaseUrl in its provisioned /etc/smithers/workspace-coding.json binding,
	// which the workspace installer writes as <public base>/api.
	assert.Equal(t, "https://jjhub.example/api", env["SMITHERS_JJHUB_API_URL"])

	var minted *db.CreateAccessTokenParams
	for i := range q.accessTokens {
		if strings.Contains(q.accessTokens[i].Scopes, "repo:") && strings.HasPrefix(q.accessTokens[i].Name, "workspace-gateway-landing-") {
			minted = &q.accessTokens[i]
		}
	}
	require.NotNil(t, minted, "the landing credential must be minted for this gateway")
	assert.Equal(t, "workspace-gateway-landing-"+info.GatewayID, minted.Name)
	assert.Equal(t, w.UserID, minted.UserID)
	// write:repository implies read:repository (bookmarks, landing reads);
	// repo:<id> fences a leaked credential out of the owner's other repos; no
	// workspace:<id> restriction, which would refuse every landing route.
	assert.Equal(t, workspaceGatewayLandingTokenScopes(101, w.ID), minted.Scopes)
	assert.Equal(t, []string{"**"}, middleware.ParseTokenPathRestrictions(minted.Scopes))
	assert.Equal(t, strings.ToLower(w.ID), middleware.ParseTokenLandingWorkspace(minted.Scopes), "the credential names the workspace that opens its landings")
	assert.Empty(t, middleware.ParseTokenWorkspaceRestriction(minted.Scopes))
	assert.True(t, landingRequestIsAgentAuthored(middleware.ContextWithAuthInfo(context.Background(),
		&middleware.AuthInfo{IsTokenAuth: true, RawScopes: minted.Scopes})), "the actual minted credential must produce an agent-authored landing receipt")
	assert.True(t, minted.ExpiresAt.Valid)
	assert.WithinDuration(t, time.Now().UTC().Add(workspaceGatewayLandingTokenTTL), minted.ExpiresAt.Time, time.Minute)

	require.NotEmpty(t, q.landingTokenWrites)
	assert.Equal(t, info.GatewayID, q.landingTokenWrites[0].ID)
	assert.True(t, q.landingTokenWrites[0].LandingTokenID.Valid)

	// Never in argv, never in an exec'd command, never in a log line.
	assert.NotContains(t, vm.systemdSpecs[0].Exec[0], landing)
	for _, request := range vm.execAwaitReqs {
		assert.NotContains(t, request.Command, landing)
	}
}

func TestWorkspaceGateway_TeardownRevokesTheLandingCredential(t *testing.T) {
	s, q, vm, w := boundGatewayFixture(t)
	info, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.NoError(t, err)
	require.Len(t, q.landingTokenWrites, 1)
	tokenID := q.landingTokenWrites[0].LandingTokenID

	tombstoned := runtimeports.RepoGateway{
		ID: info.GatewayID, VmID: w.VmID, UserID: w.UserID, RepositoryID: w.RepositoryID,
		WorkspaceID:    pgtype.UUID{Bytes: uuid.MustParse(w.ID), Valid: true},
		LandingTokenID: tokenID,
		DeletedAt:      pgtype.Timestamptz{Time: time.Now(), Valid: true},
	}
	require.NoError(t, s.stopWorkspaceGatewayChecked(context.Background(), tombstoned))
	assert.Contains(t, q.deletedTokens, db.DeleteAccessTokenParams{ID: tokenID.Int64, UserID: w.UserID})
	assert.Contains(t, q.clearedWorkspaceCredentials, info.GatewayID)
	last := q.landingTokenWrites[len(q.landingTokenWrites)-1]
	assert.Equal(t, info.GatewayID, last.ID)
	assert.False(t, last.LandingTokenID.Valid, "the revoked credential's reference is cleared")
	assert.Empty(t, vm.deletedVMIDs)
}

// landing-config.ts: "ordinary approved shell tools must not inherit this
// token". The credential lives in the coding host unit's environment only, so a
// repository admin's agent-environment profile can neither read it nor supply a
// substitute the coding host would accept.
func TestWorkspaceGateway_LandingCredentialNeverComesFromTheShellProfile(t *testing.T) {
	profile := filepath.Join(t.TempDir(), "agent-environment.sh")
	require.NoError(t, os.WriteFile(profile, []byte(
		"export SMITHERS_JJHUB_TOKEN='repository-declared-token'\nexport SMITHERS_JJHUB_API_URL='https://attacker.example/api'\n"), 0600))
	probe := func(t *testing.T, env []string) string {
		t.Helper()
		command := workspaceGatewayCommand(runtimeports.RepoGateway{ID: "owned-host"})
		command = strings.ReplaceAll(command, "/etc/profile.d/10-smithers-agent-environment.sh", profile)
		command = command[:strings.LastIndex(command, "\nexec flock")] +
			"\nprintf '%s\\n' \"${SMITHERS_JJHUB_TOKEN-absent}\" \"${SMITHERS_JJHUB_API_URL-absent}\""
		process := exec.Command("sh", "-c", command)
		process.Env = append([]string{"SMITHERS_API_KEY=owner-placeholder", "SMITHERS_GATEWAY_ID=owned-host"}, env...)
		output, err := process.CombinedOutput()
		require.NoError(t, err, string(output))
		return string(output)
	}
	assert.Equal(t, "provisioned-landing-token\nhttps://jjhub.example/api\n", probe(t, []string{
		"SMITHERS_JJHUB_TOKEN=provisioned-landing-token", "SMITHERS_JJHUB_API_URL=https://jjhub.example/api"}))
	// With no provisioned credential the coding host must see an absent
	// binding, not the repository's own value pointing at another host.
	assert.Equal(t, "absent\nabsent\n", probe(t, nil))
}
