package compose

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

const reportCommit = "fc3f257b643b41dd8de24d4b0d3248253ab411c5"

func terminalRow(flow, link, tag, exit, repo, commit string) json.RawMessage {
	return json.RawMessage(`{"sequence":9,"kind":"control.engine.event","payload":{"eventType":"flows.engine.run-decision","payload":{"state":{"flowName":"` + flow +
		`","payload":{"link":"` + link + `"},"result":{"_tag":"` + tag + `","exit":{"_tag":"` + exit +
		`","value":{"report":{"repo":"` + repo + `","clone":{"_tag":"clone","repo":"` + repo + `","commit":"` + commit + `"}},"review":{"decision":"approve","note":"private"}}}}}}}}`)
}

func TestCompletedRegistrationsReadsOnlyFinishedRegistrationOutcomes(t *testing.T) {
	good := terminalRow("register-repository", "https://github.com/Acme/Widgets", "Complete", "Success", "acme/widgets", reportCommit)
	other := json.RawMessage(`{"kind":"control.engine.event","payload":{"eventType":"flows.engine.node-settled","payload":{}}}`)
	for name, tc := range map[string]struct {
		rows json.RawMessage
		want int
	}{
		"finished":            {good, 1},
		"another flow":        {terminalRow("coding/fix", "https://github.com/acme/widgets", "Complete", "Success", "acme/widgets", reportCommit), 0},
		"still running":       {terminalRow("register-repository", "https://github.com/acme/widgets", "Suspended", "Success", "acme/widgets", reportCommit), 0},
		"failed":              {terminalRow("register-repository", "https://github.com/acme/widgets", "Complete", "Failure", "acme/widgets", reportCommit), 0},
		"other repository":    {terminalRow("register-repository", "https://github.com/acme/other", "Complete", "Success", "acme/widgets", reportCommit), 0},
		"not a decision":      {other, 0},
		"malformed":           {json.RawMessage(`[]`), 0},
		"report without repo": {terminalRow("register-repository", "https://github.com/acme/widgets", "Complete", "Success", "", reportCommit), 0},
	} {
		t.Run(name, func(t *testing.T) {
			require.Len(t, completedRegistrations([]json.RawMessage{tc.rows}), tc.want)
		})
	}
	found := completedRegistrations([]json.RawMessage{other, good})
	require.Equal(t, "acme/widgets", found[0].repo)
	require.Equal(t, reportCommit, found[0].commit)
	require.NotContains(t, string(found[0].report), "review", "the admin's decision is never shared")
	require.NotContains(t, string(found[0].report), "private")
}

type reportStore struct {
	mu       sync.Mutex
	recorded []string
	err      error
	shared   *services.SharedRegistrationReport
	looked   []string
}

func (s *reportStore) Record(_ context.Context, repo, commit string, _ json.RawMessage) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recorded = append(s.recorded, repo+"@"+commit)
	return s.err == nil, s.err
}

func (s *reportStore) Lookup(_ context.Context, repo string) (services.SharedRegistrationReport, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.looked = append(s.looked, repo)
	if s.err != nil || s.shared == nil {
		return services.SharedRegistrationReport{}, false, s.err
	}
	return *s.shared, true, nil
}

type snapshotDispatcher struct{ answer string }

func (d *snapshotDispatcher) CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error) {
	return json.RawMessage(d.answer), nil
}
func (*snapshotDispatcher) StartHost(context.Context, flowruntime.Target) (bool, error) {
	return true, nil
}

func journalPage(rows ...json.RawMessage) string {
	joined, _ := json.Marshal(rows)
	return `{"ok":true,"payload":{"rows":` + string(joined) + `}}`
}

func reportCall(api *browserFlowAPI, userID int64, procedure, payload string) *httptest.ResponseRecorder {
	body := `{"repo":"owner/repo","workspaceId":"` + browserBoxID + `","procedure":"` + procedure + `","payload":` + payload + `}`
	request := httptest.NewRequest(http.MethodPost, "/api/workflow/rpc", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: userID}))
	writer := httptest.NewRecorder()
	api.rpc(writer, request)
	return writer
}

func TestRelayedCompletedRegistrationIsRecordedOnceFromTheHostsJournal(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
	store := &reportStore{}
	page := journalPage(terminalRow("register-repository", "https://github.com/acme/widgets", "Complete", "Success", "acme/widgets", reportCommit))
	api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: &snapshotDispatcher{answer: page}, reports: store}
	for range 3 { // the app polls the same page
		w := reportCall(api, 17, "Projection.Snapshot", `{"selector":{"_tag":"run-events","runId":"r"}}`)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		require.JSONEq(t, page, w.Body.String(), "the relay answers the page unchanged")
	}
	api.observed.wait.Wait()
	require.Equal(t, []string{"acme/widgets@" + reportCommit}, store.recorded)

	// A page without a finished registration records nothing, and reads with no store are inert.
	quiet := &reportStore{}
	api.reports, api.dispatcher = quiet, &snapshotDispatcher{answer: journalPage(json.RawMessage(`{"kind":"control.agent.turn-opened"}`))}
	require.Equal(t, http.StatusOK, reportCall(api, 17, "Projection.Snapshot", `{}`).Code)
	api.reports, api.dispatcher = nil, &snapshotDispatcher{answer: page}
	require.Equal(t, http.StatusOK, reportCall(api, 17, "Projection.Snapshot", `{}`).Code)
	api.reports, api.dispatcher = quiet, &snapshotDispatcher{answer: `not json register-repository`}
	require.Equal(t, http.StatusOK, reportCall(api, 17, "Projection.Snapshot", `{}`).Code)
	api.observed.wait.Wait()
	require.Empty(t, quiet.recorded)
}

func TestRegistrationObservationRetriesTransientFailureButNotRefusal(t *testing.T) {
	page := journalPage(terminalRow("register-repository", "https://github.com/acme/widgets", "Complete", "Success", "acme/widgets", reportCommit))
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
	store := &reportStore{err: errors.New("github unreachable")}
	api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: &snapshotDispatcher{answer: page}, reports: store}
	reportCall(api, 17, "Projection.Snapshot", `{}`)
	api.observed.wait.Wait()
	reportCall(api, 17, "Projection.Snapshot", `{}`)
	api.observed.wait.Wait()
	require.Len(t, store.recorded, 2, "a transient failure is asked again on the next poll")

	store.recorded, store.err = nil, services.ErrRegistrationReportUnshareable
	private := journalPage(terminalRow("register-repository", "https://github.com/acme/secret", "Complete", "Success", "acme/secret", reportCommit))
	api.dispatcher = &snapshotDispatcher{answer: private}
	for range 3 {
		reportCall(api, 17, "Projection.Snapshot", `{}`)
		api.observed.wait.Wait()
	}
	require.Len(t, store.recorded, 1, "a refusal is not asked again while it stands")

	// The refusal expires: the repository may have become public.
	api.observed.mu.Lock()
	for key := range api.observed.seen {
		api.observed.seen[key] = time.Now().Add(-2 * registrationObservedTTL)
	}
	api.observed.mu.Unlock()
	reportCall(api, 17, "Projection.Snapshot", `{}`)
	api.observed.wait.Wait()
	require.Len(t, store.recorded, 2)
}

func TestRegistrationReportProcedure(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "suspended"}}
	shared := &services.SharedRegistrationReport{Repo: "acme/widgets", Commit: reportCommit, Report: json.RawMessage(`{"repo":"acme/widgets"}`)}
	store := &reportStore{shared: shared}
	api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: &reviewDispatcher{}, reports: store}

	w := reportCall(api, 5, "Registration.Report", `{"repo":"Acme/Widgets"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var answer struct {
		OK      bool `json:"ok"`
		Payload struct {
			Report struct {
				Repo   string          `json:"repo"`
				Commit string          `json:"commit"`
				Report json.RawMessage `json:"report"`
			} `json:"report"`
		} `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &answer))
	require.True(t, answer.OK)
	require.Equal(t, reportCommit, answer.Payload.Report.Commit)
	require.JSONEq(t, `{"repo":"acme/widgets"}`, string(answer.Payload.Report.Report))
	require.Equal(t, []string{"acme/widgets"}, store.looked, "the repository is looked up in its canonical case")

	store.shared = nil
	require.JSONEq(t, `{"ok":true,"payload":{"report":null}}`, reportCall(api, 5, "Registration.Report", `{"repo":"acme/secret"}`).Body.String())

	store.err = errors.New("github unreachable")
	require.Equal(t, http.StatusServiceUnavailable, reportCall(api, 5, "Registration.Report", `{"repo":"acme/widgets"}`).Code)
	for _, payload := range []string{`{}`, `{"repo":"  "}`, `[1]`} {
		require.Equal(t, http.StatusBadRequest, reportCall(api, 5, "Registration.Report", payload).Code, payload)
	}
	api.reports = nil
	require.Equal(t, http.StatusBadRequest, reportCall(api, 5, "Registration.Report", `{"repo":"acme/widgets"}`).Code)

	// The caller must still own a box on the named repository.
	deps.canWrite = false
	api.reports = store
	require.Equal(t, http.StatusNotFound, reportCall(api, 5, "Registration.Report", `{"repo":"acme/widgets"}`).Code)
}
