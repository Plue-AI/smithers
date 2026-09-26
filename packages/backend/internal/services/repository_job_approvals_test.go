package services

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func repositoryJobApprovalTestInput() RepositoryJobApprovalInput {
	return RepositoryJobApprovalInput{PlanID: "plan-01", PlanDigest: strings.Repeat("d", 64), FlowID: "nightly-lint",
		Envelope: json.RawMessage(`{"capabilities":["read","write"],"flows":["nightly-lint"],"budget":{"tokens":12000,"milliseconds":600000}}`)}
}

func repositoryJobApprovalCollaborator(t *testing.T, pool *pgxpool.Pool, repoID int64, permission string) int64 {
	t.Helper()
	ctx, name := context.Background(), fmt.Sprintf("approval_collab_%d", time.Now().UnixNano())
	var userID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1,$1,$2,$2,$1) RETURNING id`, name, name+"@test.com").Scan(&userID))
	t.Cleanup(func() {
		_, err := pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
		require.NoError(t, err)
	})
	if permission != "" {
		_, err := pool.Exec(ctx, `INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1,$2,$3)`, repoID, userID, permission)
		require.NoError(t, err)
	}
	return userID
}

// Nothing on the wire can name who approved or when. The request carries the
// plan identity Control produced and nothing else.
func TestRepositoryJobApprovalWireCarriesNoProvenance(t *testing.T) {
	t.Parallel()
	encoded, err := json.Marshal(repositoryJobApprovalTestInput())
	require.NoError(t, err)
	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &fields))
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	require.Equal(t, []string{"envelope", "flow_id", "plan_digest", "plan_id"}, names)
}

func TestRepositoryJobApprovalIsStampedByAnAuthenticatedWriter(t *testing.T) {
	pool, _, s, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	input := repositoryJobApprovalTestInput()

	before := time.Now().UTC().Add(-time.Second)
	row, err := s.RecordApproval(ctx, g.target.RepositoryID, g.target.UserID, "flow:nightly-lint", input)
	require.NoError(t, err)
	require.Equal(t, g.target.UserID, row.ApprovedBy)
	require.WithinRange(t, row.ApprovedAt, before, time.Now().UTC().Add(time.Second))
	require.Equal(t, "flow:nightly-lint", row.Job)
	require.Equal(t, input.PlanID, row.PlanID)
	require.Equal(t, input.PlanDigest, row.PlanDigest)
	require.Equal(t, input.FlowID, row.FlowID)

	reader := repositoryJobApprovalCollaborator(t, pool, g.target.RepositoryID, "read")
	_, err = s.RecordApproval(ctx, g.target.RepositoryID, reader, "flow:nightly-lint", input)
	require.ErrorContains(t, err, "repository permission required")
	stranger := repositoryJobApprovalCollaborator(t, pool, g.target.RepositoryID, "")
	_, err = s.RecordApproval(ctx, g.target.RepositoryID, stranger, "flow:nightly-lint", input)
	require.ErrorContains(t, err, "repository permission required")

	listed, err := s.Approvals(ctx, g.target.RepositoryID, reader, "flow:nightly-lint")
	require.NoError(t, err)
	require.Len(t, listed, 1)
	require.Equal(t, g.target.UserID, listed[0].ApprovedBy)

	writer, err := s.RecordApproval(ctx, g.target.RepositoryID, g.target.UserID, "flow:nightly-lint", input)
	require.NoError(t, err)
	require.False(t, writer.ApprovedAt.Before(row.ApprovedAt), "re-approving the same plan restamps the moment")
}

func TestRepositoryJobApprovalRefusesAnythingButAReviewedFlowPlan(t *testing.T) {
	_, _, s, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	for name, edit := range map[string]struct {
		job     string
		edit    func(*RepositoryJobApprovalInput)
		message string
	}{
		"built-in job": {"chores", func(*RepositoryJobApprovalInput) {}, "invalid repository job or registered flow"},
		"bad slug":     {"flow:Nightly", func(*RepositoryJobApprovalInput) {}, "invalid repository job or registered flow"},
		"bad flow id":  {"flow:nightly-lint", func(i *RepositoryJobApprovalInput) { i.FlowID = "../escape" }, "invalid repository job or registered flow"},
		"no plan id":   {"flow:nightly-lint", func(i *RepositoryJobApprovalInput) { i.PlanID = "" }, "a flow trigger must name the plan a person approved"},
		"short digest": {"flow:nightly-lint", func(i *RepositoryJobApprovalInput) { i.PlanDigest = "plan-digest" }, "a flow trigger must name the plan a person approved"},
		"no envelope":  {"flow:nightly-lint", func(i *RepositoryJobApprovalInput) { i.Envelope = json.RawMessage(`{}`) }, "automatic work needs the reviewed envelope"},
		"unbounded run": {"flow:nightly-lint", func(i *RepositoryJobApprovalInput) {
			i.Envelope = json.RawMessage(`{"capabilities":[],"flows":[],"budget":{"tokens":1,"milliseconds":21600001}}`)
		}, "automatic work needs the reviewed envelope"},
	} {
		t.Run(name, func(t *testing.T) {
			input := repositoryJobApprovalTestInput()
			edit.edit(&input)
			_, err := s.RecordApproval(ctx, g.target.RepositoryID, g.target.UserID, edit.job, input)
			require.ErrorContains(t, err, edit.message)
		})
	}
	_, err := s.Approvals(ctx, g.target.RepositoryID, g.target.UserID, "chores")
	require.ErrorContains(t, err, "unknown repository job")
}
