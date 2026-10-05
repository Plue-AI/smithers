package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type branchRouteFixture struct {
	branch string
	fork   services.BranchForkInput
	forkBy [2]int64
}

func (*branchRouteFixture) ListBranches(context.Context, int64, int64, int, int) ([]services.BranchMachineResponse, int64, error) {
	return nil, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "providers unavailable")
}
func (f *branchRouteFixture) GetBranch(_ context.Context, branch string, _ int64, _ int64) (services.BranchMachineResponse, error) {
	f.branch = branch
	return services.BranchMachineResponse{}, pkgerrors.Forbidden("removed member")
}
func (f *branchRouteFixture) ForkBranch(_ context.Context, repository, user int64, input services.BranchForkInput) (services.BranchMachineResponse, error) {
	f.fork, f.forkBy = input, [2]int64{repository, user}
	if input.From == "T9" {
		return services.BranchMachineResponse{}, &services.BranchError{Status: 409, Code: "no_verified_head", Class: "conflict", Message: "T9 has no verified head to fork yet"}
	}
	return services.BranchMachineResponse{Name: "scratch/owner/" + input.Name, Kind: "scratch", State: "provisioning", Head: strings.Repeat("a", 40),
		ForkedFrom: &services.BranchForkedFrom{Kind: "item", Ref: input.From, Commit: strings.Repeat("a", 40), Base: strings.Repeat("b", 40), Item: 2}}, nil
}

// branchSignedIn admits every command as person 7 on repository 101; branchSignedOut
// refuses as Authorize does without a session.
func branchSignedIn(*http.Request, string) (int64, int64, error) { return 101, 7, nil }
func branchSignedOut(*http.Request, string) (int64, int64, error) {
	return 0, 0, &services.AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in"}
}

func branchRouter(h *BranchHandler) *chi.Mux {
	router := chi.NewRouter()
	router.Route("/api", func(r chi.Router) { RegisterBranchRoutes(r, h) })
	return router
}

func TestBranchRoutesAnswerUnavailableWithoutTheirServices(t *testing.T) {
	w := httptest.NewRecorder()
	branchRouter(nil).ServeHTTP(w, httptest.NewRequest("GET", "/api/branches", nil))
	require.Equal(t, 404, w.Code, "a composition without the handler mounts nothing")
	for _, h := range []*BranchHandler{{}, {Authorize: branchSignedIn}, {Reads: &branchRouteFixture{}}, {Forks: &branchRouteFixture{}},
		{Authorize: branchSignedIn, Forks: &branchRouteFixture{}}} {
		router := branchRouter(h)
		for _, path := range []string{"/api/branches", "/api/branches/main"} {
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
			require.Equal(t, 503, w.Code)
			require.JSONEq(t, `{"code":"branch_machine_unavailable","class":"infra","message":"Branch unavailable"}`, w.Body.String())
		}
	}
	// Reads without the stack's Fork answer a fork 503.
	w = httptest.NewRecorder()
	branchRouter(&BranchHandler{Authorize: branchSignedIn, Reads: &branchRouteFixture{}}).ServeHTTP(w, httptest.NewRequest("POST", "/api/branches", strings.NewReader(`{"from":"T2"}`)))
	require.Equal(t, 503, w.Code)
}

func TestBranchRoutesRefuseUnavailableAuthority(t *testing.T) {
	for _, tc := range []struct {
		authorize func(*http.Request, string) (int64, int64, error)
		path      string
		status    int
		body      string
	}{
		{branchSignedOut, "/api/branches", 401, `{"code":"unauthenticated","class":"permission","message":"Sign in"}`},
		{branchSignedIn, "/api/branches", 503, `{"code":"branch_machine_unavailable","class":"infra","message":"Branch unavailable"}`},
		{branchSignedIn, "/api/branches/main", 403, `{"code":"permission","class":"permission","message":"Access denied"}`},
	} {
		w := httptest.NewRecorder()
		branchRouter(&BranchHandler{Authorize: tc.authorize, Reads: &branchRouteFixture{}}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		require.Equal(t, tc.status, w.Code)
		require.JSONEq(t, tc.body, w.Body.String())
	}
}

func TestBranchReadDecodesBranchNameOnce(t *testing.T) {
	fixture := &branchRouteFixture{}
	response := httptest.NewRecorder()
	branchRouter(&BranchHandler{Authorize: branchSignedIn, Reads: fixture}).ServeHTTP(response, httptest.NewRequest("GET", "/api/branches/scratch%2Falice%2Fshared", nil))
	require.Equal(t, 403, response.Code)
	require.Equal(t, "scratch/alice/shared", fixture.branch)
}

// branchDiffFixture reads one TODO branch and answers its diff.
type branchDiffFixture struct {
	read   string
	diffed services.BranchMachineResponse
	err    error
	result services.BranchDiff
}

func (*branchDiffFixture) ListBranches(context.Context, int64, int64, int, int) ([]services.BranchMachineResponse, int64, error) {
	return nil, 0, nil
}
func (f *branchDiffFixture) GetBranch(_ context.Context, branch string, _ int64, _ int64) (services.BranchMachineResponse, error) {
	f.read = branch
	if branch != "smithers/add-greeting" {
		return services.BranchMachineResponse{}, pkgerrors.NotFound("branch not found")
	}
	return services.BranchMachineResponse{Name: branch, Kind: "item", Item: &services.BranchItem{N: 1, Title: "Add greeting", State: "in_review", Place: 1}}, nil
}
func (f *branchDiffFixture) BranchDiff(_ context.Context, repository int64, branch services.BranchMachineResponse) (services.BranchDiff, error) {
	f.diffed = branch
	return f.result, f.err
}

// The branch's diff is read for the branch the name resolves to, by any
// member who reads branches; the stack's refusals keep their envelope.
func TestBranchDiffReadsTheResolvedBranch(t *testing.T) {
	file := services.BranchDiffModel{Path: "greet.mjs", Branch: "smithers/add-greeting", Against: services.BranchDiffAgainst{Kind: "item_base", Rev: "base"}, Change: "added",
		Hunks: []services.BranchDiffHunk{{OldStart: 0, NewStart: 1, Lines: []services.BranchDiffLine{{Op: "+", Text: "export const greet = () => 'hi'"}}}}}
	for _, tc := range []struct {
		name, path string
		fixture    *branchDiffFixture
		status     int
		body       string
	}{
		{"change", "/api/branches/smithers%2Fadd-greeting/diff", &branchDiffFixture{result: services.BranchDiff{Files: []services.BranchDiffModel{file},
			Commits: []services.BranchCommit{{SHA: strings.Repeat("c", 40), Subject: "feat: add greet", Author: "Smithers", At: "2026-10-05T09:00:00-07:00"}}}}, 200,
			`{"files":[{"path":"greet.mjs","branch":"smithers/add-greeting","against":{"kind":"item_base","rev":"base"},"change":"added","hunks":[{"old_start":0,"new_start":1,"lines":[{"op":"+","text":"export const greet = () => 'hi'"}]}]}],
			"commits":[{"sha":"` + strings.Repeat("c", 40) + `","subject":"feat: add greet","author":"Smithers","at":"2026-10-05T09:00:00-07:00"}]}`},
		{"nothing yet", "/api/branches/smithers%2Fadd-greeting/diff", &branchDiffFixture{}, 200, `{"files":[]}`},
		{"no such branch", "/api/branches/smithers%2Fgone/diff", &branchDiffFixture{}, 404, `{"code":"not_found","class":"user","message":"branch not found"}`},
		{"too large", "/api/branches/smithers%2Fadd-greeting/diff", &branchDiffFixture{err: fmt.Errorf("diff: %w", &services.TODOPrUnavailable{})}, 503,
			`{"code":"diff_unavailable","class":"infra","message":"This change is too large to show"}`},
		{"unreadable", "/api/branches/smithers%2Fadd-greeting/diff", &branchDiffFixture{err: &services.BranchError{Status: 503, Code: "branch_unavailable", Class: "infra", Message: "the branch's revisions could not be read"}}, 503,
			`{"code":"branch_unavailable","class":"infra","message":"the branch's revisions could not be read"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var commands []string
			authorize := func(r *http.Request, command string) (int64, int64, error) {
				commands = append(commands, command)
				return branchSignedIn(r, command)
			}
			w := httptest.NewRecorder()
			branchRouter(&BranchHandler{Authorize: authorize, Reads: tc.fixture, Diffs: tc.fixture}).ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
			require.Equal(t, tc.status, w.Code)
			require.JSONEq(t, tc.body, w.Body.String())
			require.Equal(t, []string{"branches.read"}, commands)
			if tc.status != 404 {
				require.Equal(t, "smithers/add-greeting", tc.fixture.read)
				require.Equal(t, int64(1), tc.fixture.diffed.Item.N, "the diff is the resolved branch's")
			}
		})
	}
	// Without the stack's diff, or signed out, nothing is read.
	fixture := &branchDiffFixture{}
	for _, h := range []*BranchHandler{{Authorize: branchSignedIn, Reads: fixture}, {Authorize: branchSignedOut, Reads: fixture, Diffs: fixture}} {
		w := httptest.NewRecorder()
		branchRouter(h).ServeHTTP(w, httptest.NewRequest("GET", "/api/branches/smithers%2Fadd-greeting/diff", nil))
		require.Contains(t, []int{401, 503}, w.Code)
		require.Empty(t, fixture.read)
	}
}

func TestBranchForkAnswersTheNewBranch(t *testing.T) {
	fixture := &branchRouteFixture{}
	var commands []string
	authorize := func(r *http.Request, command string) (int64, int64, error) {
		commands = append(commands, command)
		return branchSignedIn(r, command)
	}
	router := branchRouter(&BranchHandler{Authorize: authorize, Reads: fixture, Forks: fixture})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("POST", "/api/branches", strings.NewReader(`{"from":"T2","name":"try-retry"}`)))
	require.Equal(t, 201, w.Code)
	var created struct {
		Name       string                    `json:"name"`
		Kind       string                    `json:"kind"`
		Head       string                    `json:"head"`
		ForkedFrom services.BranchForkedFrom `json:"forked_from"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	require.Equal(t, "scratch/owner/try-retry", created.Name)
	require.Equal(t, "scratch", created.Kind)
	require.Equal(t, strings.Repeat("a", 40), created.Head)
	require.Equal(t, services.BranchForkedFrom{Kind: "item", Ref: "T2", Commit: strings.Repeat("a", 40), Base: strings.Repeat("b", 40), Item: 2}, created.ForkedFrom)
	require.Equal(t, services.BranchForkInput{From: "T2", Name: "try-retry"}, fixture.fork)
	require.Equal(t, [2]int64{101, 7}, fixture.forkBy)
	require.Equal(t, []string{"branch.fork"}, commands)

	for _, tc := range []struct {
		body, want string
		status     int
	}{
		{`{"from":"T9"}`, `{"code":"no_verified_head","class":"conflict","message":"T9 has no verified head to fork yet"}`, 409},
		{`{"from":"T2","mode":"replace"}`, `{"code":"bad_request","class":"user","message":"invalid fork request"}`, 400},
		{`not json`, `{"code":"bad_request","class":"user","message":"invalid fork request"}`, 400},
	} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("POST", "/api/branches", strings.NewReader(tc.body)))
		require.Equal(t, tc.status, w.Code, tc.body)
		require.JSONEq(t, tc.want, w.Body.String())
	}

	w = httptest.NewRecorder()
	branchRouter(&BranchHandler{Authorize: branchSignedOut, Reads: fixture, Forks: fixture}).ServeHTTP(w, httptest.NewRequest("POST", "/api/branches", strings.NewReader(`{"from":"T2"}`)))
	require.Equal(t, 401, w.Code)
}
