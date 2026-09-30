package compose

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// One account's finished registration is served to another account for the
// same public repository and commit, and a private repository's report is
// neither stored nor served (#2158). Postgres is real; only GitHub, which the
// test cannot reach anonymously, is answered by a local server.
func TestRegistrationReportIsSharedForPublicRepositoriesOnly(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch strings.TrimPrefix(r.URL.Path, "/repos/") {
		case "acme/widgets":
			_, _ = w.Write([]byte(`{"private":false}`))
		case "acme/widgets/commits/HEAD", "acme/widgets/commits/" + reportCommit:
			_, _ = w.Write([]byte(reportCommit))
		default: // GitHub answers 404 to an anonymous read of a private repository
			http.NotFound(w, r)
		}
	}))
	defer github.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", github.URL)

	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
	journal := func(repo string) *snapshotDispatcher {
		return &snapshotDispatcher{answer: journalPage(terminalRow("register-repository", "https://github.com/"+repo, "Complete", "Success", repo, reportCommit))}
	}
	registrant := &browserFlowAPI{repos: deps, queries: deps, dispatcher: journal("acme/widgets"), reports: services.NewRegistrationReports(pool)}
	second := &browserFlowAPI{repos: deps, queries: deps, dispatcher: &snapshotDispatcher{}, reports: services.NewRegistrationReports(pool)}
	lookup := func(repo string) json.RawMessage {
		w := reportCall(second, 2, "Registration.Report", `{"repo":"`+repo+`"}`)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var answer struct {
			Payload struct {
				Report json.RawMessage `json:"report"`
			} `json:"payload"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &answer))
		return answer.Payload.Report
	}

	require.JSONEq(t, `null`, string(lookup("acme/widgets")), "nothing is shared before a registration completes")

	// Account 1 polls its finished run; the backend records the public report.
	require.Equal(t, http.StatusOK, reportCall(registrant, 1, "Projection.Snapshot", `{"selector":{"_tag":"run-events","runId":"r"}}`).Code)
	registrant.observed.wait.Wait()

	shared := lookup("acme/widgets")
	var served struct {
		Repo   string `json:"repo"`
		Commit string `json:"commit"`
		Report struct {
			Repo string `json:"repo"`
		} `json:"report"`
	}
	require.NoError(t, json.Unmarshal(shared, &served))
	require.Equal(t, "acme/widgets", served.Repo)
	require.Equal(t, reportCommit, served.Commit)
	require.Equal(t, "acme/widgets", served.Report.Repo)
	require.NotContains(t, string(shared), "private", "the admin's review is never shared")

	// A private repository's finished run is never stored, so no account is served it.
	private := &browserFlowAPI{repos: deps, queries: deps, dispatcher: journal("acme/secret"), reports: services.NewRegistrationReports(pool)}
	require.Equal(t, http.StatusOK, reportCall(private, 1, "Projection.Snapshot", `{"selector":{"_tag":"run-events","runId":"r"}}`).Code)
	private.observed.wait.Wait()
	require.JSONEq(t, `null`, string(lookup("acme/secret")))
	var rows int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM repository_registration_reports WHERE owner = 'acme' AND name = 'secret'`).Scan(&rows))
	require.Zero(t, rows)
}
