package services

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The touched pathname and policy read cross the real native repository
// boundary. Product PostgreSQL stores the repository and agent landing.
func TestNativeLeadingSpaceDirectoryBlocksAgentLanding(t *testing.T) {
	n := newNativeRepoHost(t, "acme", "demo")
	pool := newProductTestPool(t)
	var userID, repoID, landingID int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO users(username, lower_username, email, lower_email, display_name)
		VALUES ('owner', 'owner', 'owner@example.invalid', 'owner@example.invalid', 'Owner') RETURNING id`).Scan(&userID))
	// Keep the default-bookmark approval rule out of this OWNERS-specific gate test.
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO repositories(user_id, name, lower_name, default_bookmark)
		VALUES ($1, 'demo', 'demo', 'trunk') RETURNING id`, userID).Scan(&repoID))
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO landing_requests(repository_id, number, title, author_id, target_bookmark, agent_authored, stack_size)
		VALUES ($1, 1, 'Native ownership test', $2, 'main', true, 1) RETURNING id`, repoID, userID).Scan(&landingID))
	q := db.New(pool)
	repository := db.Repository{ID: repoID, Name: "demo", DefaultBookmark: "trunk"}
	landing := db.LandingRequest{ID: landingID, RepositoryID: repoID, TargetBookmark: "main", AgentAuthored: true}
	base := n.commit("demo", "refs/heads/main", "", map[string]string{
		"OWNERS":            "agents: auto-land\n",
		" secret/OWNERS":    "alice\nagents: deny\n",
		" secret/file.go":   "package secret\n",
		"protected/OWNERS":  "alice\nagents: deny\n",
		"protected/file.go": "package protected\n",
	})
	svc := NewLandingService(q, n.client)
	worker := NewLandingWorker(q, n.client)
	for _, dir := range []string{" secret", "protected"} {
		t.Run(dir, func(t *testing.T) {
			file := dir + "/file.go"
			commit := n.commit("demo", "refs/heads/feature", base, map[string]string{file: "package changed\n"})
			change, err := n.client.GetChange(t.Context(), "acme", "demo", commit)
			require.NoError(t, err)
			files, err := n.client.GetChangeFiles(t.Context(), "acme", "demo", commit)
			require.NoError(t, err)
			require.Len(t, files, 1)
			require.Equal(t, file, files[0].Path, "native changed-file enumeration must preserve the pathname")
			policy, err := n.client.GetFileAtChange(t.Context(), "acme", "demo", base, dir+"/OWNERS")
			require.NoError(t, err)
			require.Equal(t, "alice\nagents: deny\n", policy.Content)
			touched := []OwnershipTouchedFile{{Path: files[0].Path, ChangeID: change.ChangeID, CommitID: commit, RevisionSeq: 4}}
			t.Run("resolution", func(t *testing.T) {
				resolved, err := resolveChangeOwnership(t.Context(), q, n.client, repoID, "acme", "demo", base, touched, landingID)
				require.NoError(t, err)
				require.Equal(t, file, resolved.TouchedPaths[0].Path)
				require.Equal(t, "deny", resolved.TouchedPaths[0].AgentPolicy)
				require.Equal(t, []string{"alice"}, resolved.RequiredApprovers)
				require.Equal(t, []MissingOwnershipApproval{{Path: file, Candidates: []string{"alice"}}}, resolved.MissingApprovals)
			})
			t.Run("agent_gate", func(t *testing.T) {
				err := svc.enforceOwnershipGate(t.Context(), repository, "acme", "demo", db.GetLandingRequestWithChangeIDsByNumberRow{
					ID: landingID, TargetBookmark: "main", AgentAuthored: true,
				}, touched, true)
				require.Error(t, err)
				apiErr, ok := err.(*pkgerrors.APIError)
				require.True(t, ok)
				require.Equal(t, pkgerrors.CodeLandingBlocked, apiErr.Code)
				require.Equal(t, []LandingOwnerBlock{{Kind: "agent_policy", Path: file, Candidates: []string{"alice"}}}, apiErr.Details.(LandingBlockedDetails).BlockedBy)
			})
			t.Run("human_approval", func(t *testing.T) {
				err := svc.enforceOwnershipGate(t.Context(), repository, "acme", "demo", db.GetLandingRequestWithChangeIDsByNumberRow{
					ID: landingID, TargetBookmark: "main", AgentAuthored: false,
				}, touched, true)
				require.Error(t, err)
				apiErr, ok := err.(*pkgerrors.APIError)
				require.True(t, ok)
				require.Equal(t, []LandingOwnerBlock{{Kind: "owner", Path: file, Candidates: []string{"alice"}}}, apiErr.Details.(LandingBlockedDetails).BlockedBy)
			})
			t.Run("worker_gate", func(t *testing.T) {
				err := worker.recheckOwnership(t.Context(), repository, "acme", landing, []string{change.ChangeID}, nil, 0, false)
				require.ErrorContains(t, err, "agent policy denies "+file)
				human := landing
				human.AgentAuthored = false
				err = worker.recheckOwnership(t.Context(), repository, "acme", human, []string{change.ChangeID}, nil, 0, false)
				require.ErrorContains(t, err, "missing owner approval for "+file)
			})
		})
	}
}
