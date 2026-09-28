package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// recordingDesktopService captures what the handler passed through and
// answers with whatever the test staged.
type recordingDesktopService struct {
	observeRequest services.DesktopObserveRequest
	inputRequest   services.DesktopInputRequest
	observeCalls   int
	inputCalls     int
	observation    services.DesktopObservation
	inputResponse  services.DesktopInputResponse
	err            error
}

func (s *recordingDesktopService) CheckWorkspaceDesktopAccess(context.Context, string, int64, int64) error {
	return nil
}

func (s *recordingDesktopService) CreateDesktopSession(context.Context, string, int64, int64) (services.WorkspaceDesktopSessionResponse, error) {
	return services.WorkspaceDesktopSessionResponse{}, pkgerrors.Internal("unused")
}

func (s *recordingDesktopService) AuthorizeDesktopRelay(context.Context, string, string) (services.WorkspaceDesktopRelayTarget, error) {
	return services.WorkspaceDesktopRelayTarget{}, pkgerrors.Internal("unused")
}

func (s *recordingDesktopService) ObserveDesktop(_ context.Context, workspaceID string, repositoryID, userID int64, request services.DesktopObserveRequest) (services.DesktopObservation, error) {
	s.observeCalls++
	s.observeRequest = request
	if s.err != nil {
		return services.DesktopObservation{}, s.err
	}
	observation := s.observation
	observation.WorkspaceID = workspaceID
	return observation, nil
}

func (s *recordingDesktopService) InputDesktop(_ context.Context, workspaceID string, repositoryID, userID int64, request services.DesktopInputRequest) (services.DesktopInputResponse, error) {
	s.inputCalls++
	s.inputRequest = request
	if s.err != nil {
		return services.DesktopInputResponse{}, s.err
	}
	response := s.inputResponse
	response.WorkspaceID = workspaceID
	return response, nil
}

func desktopControlRequest(t *testing.T, path, body string) *http.Request {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(http.MethodPost, path, reader)
	req.Header.Set("Content-Type", "application/json")
	req = withAuth(req, 7, "alice")
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	return req
}

func TestPostDesktopObserve_ReturnsTheObservation(t *testing.T) {
	text := "a page said this"
	source := "chrome-cdp"
	service := &recordingDesktopService{observation: services.DesktopObservation{
		CapturedAt: time.Unix(0, 0).UTC(),
		Frame:      services.DesktopFrame{Width: 1920, Height: 1080},
		Pointer:    services.DesktopPointer{X: 10, Y: 20},
		Windows:    []services.DesktopWindowEntry{},
		Text:       &text,
		TextSource: &source,
	}}
	handler := &WorkspaceDesktopHandler{Service: service}

	rec := httptest.NewRecorder()
	handler.PostDesktopObserve(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/observe", `{"image":{"max_width":640,"quality":50}}`))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	require.NotNil(t, service.observeRequest.Image)
	assert.Equal(t, 640, *service.observeRequest.Image.MaxWidth)
	assert.Equal(t, 50, *service.observeRequest.Image.Quality)

	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "ws-1", body["workspace_id"])
	assert.Equal(t, "a page said this", body["text"])
	assert.Equal(t, "chrome-cdp", body["text_source"])
	assert.Contains(t, body, "frame")
	assert.Contains(t, body, "pointer")
	// A nil focus and a nil image are explicit nulls, not absent keys: a
	// consumer branches on them.
	assert.Nil(t, body["focused"])
	assert.Nil(t, body["image"])
}

func TestPostDesktopObserve_AcceptsAnEmptyBody(t *testing.T) {
	// The cheapest read an agent takes between actions is a bodyless POST.
	service := &recordingDesktopService{}
	handler := &WorkspaceDesktopHandler{Service: service}

	rec := httptest.NewRecorder()
	handler.PostDesktopObserve(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/observe", ""))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, service.observeCalls)
	assert.Nil(t, service.observeRequest.Text, "an absent text field is the default, not false")
	assert.Nil(t, service.observeRequest.Image)
}

func TestPostDesktopControl_RejectsUnknownFields(t *testing.T) {
	// A typo must fail loudly: silently ignoring "buttton" would turn an
	// intended right click into a left one somewhere unintended.
	for _, test := range []struct {
		name string
		path string
		body string
		call func(*WorkspaceDesktopHandler, http.ResponseWriter, *http.Request)
	}{
		{"observe", "observe", `{"image":{"max_width":640},"screenshot":true}`,
			(*WorkspaceDesktopHandler).PostDesktopObserve},
		{"input", "input", `{"act_id":"11111111-2222-3333-4444-555555555555","actions":[{"action":"click","buttton":"right"}]}`,
			(*WorkspaceDesktopHandler).PostDesktopInput},
		{"trailing content", "input", `{"act_id":"11111111-2222-3333-4444-555555555555"} {"act_id":"x"}`,
			(*WorkspaceDesktopHandler).PostDesktopInput},
		{"not json", "input", `not json at all`,
			(*WorkspaceDesktopHandler).PostDesktopInput},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &recordingDesktopService{}
			rec := httptest.NewRecorder()
			test.call(&WorkspaceDesktopHandler{Service: service}, rec, desktopControlRequest(t,
				"/api/repos/alice/demo/workspaces/ws-1/desktop/"+test.path, test.body))

			require.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Contains(t, rec.Body.String(), "invalid request body")
			assert.Equal(t, 0, service.observeCalls+service.inputCalls, "a malformed body never reaches the service")
		})
	}
}

func TestPostDesktopInput_RequiresABody(t *testing.T) {
	service := &recordingDesktopService{}
	rec := httptest.NewRecorder()
	(&WorkspaceDesktopHandler{Service: service}).PostDesktopInput(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/input", ""))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, 0, service.inputCalls)
}

func TestPostDesktopInput_RejectsAnOversizedPlan(t *testing.T) {
	body := `{"act_id":"11111111-2222-3333-4444-555555555555","actions":[{"action":"type","text":"` +
		strings.Repeat("x", maxDesktopInputBody) + `"}]}`
	service := &recordingDesktopService{}
	rec := httptest.NewRecorder()
	(&WorkspaceDesktopHandler{Service: service}).PostDesktopInput(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/input", body))

	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	assert.Contains(t, rec.Body.String(), "request body too large")
	assert.Equal(t, 0, service.inputCalls)
}

func TestPostDesktopInput_PassesThePlanThrough(t *testing.T) {
	service := &recordingDesktopService{inputResponse: services.DesktopInputResponse{
		ActID:       "11111111-2222-3333-4444-555555555555",
		Completed:   2,
		Frame:       services.DesktopFrame{Width: 1920, Height: 1080},
		CompletedAt: time.Unix(0, 0).UTC(),
	}}
	body := `{"act_id":"11111111-2222-3333-4444-555555555555",` +
		`"actions":[{"action":"click","x":10,"y":20,"button":"right","count":2},{"action":"type","text":"hi"}],` +
		`"frame":{"width":1920,"height":1080},"allow_terminal":true,"settle_ms":500,"observe":{"text":false}}`

	rec := httptest.NewRecorder()
	(&WorkspaceDesktopHandler{Service: service}).PostDesktopInput(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/input", body))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	request := service.inputRequest
	assert.Equal(t, "11111111-2222-3333-4444-555555555555", request.ActID)
	require.Len(t, request.Actions, 2)
	assert.Equal(t, "right", request.Actions[0].Button)
	assert.Equal(t, 2, *request.Actions[0].Count)
	assert.Equal(t, "hi", request.Actions[1].Text)
	assert.Equal(t, &services.DesktopFrame{Width: 1920, Height: 1080}, request.Frame)
	assert.True(t, request.AllowTerminal)
	assert.Equal(t, 500, *request.SettleMS)
	require.NotNil(t, request.Observe)
	require.NotNil(t, request.Observe.Text)
	assert.False(t, *request.Observe.Text)

	var response map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.Equal(t, float64(2), response["completed"])
	assert.Nil(t, response["observation"])
	assert.Nil(t, response["observe_error"])
}

func TestPostDesktopInput_AcceptsASingleActionBody(t *testing.T) {
	service := &recordingDesktopService{}
	rec := httptest.NewRecorder()
	(&WorkspaceDesktopHandler{Service: service}).PostDesktopInput(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/input",
		`{"act_id":"11111111-2222-3333-4444-555555555555","action":"key","combo":"Return"}`))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "key", service.inputRequest.Action)
	assert.Equal(t, "Return", service.inputRequest.Combo)
}

// TestPostDesktopControl_RendersEveryContractError is the client contract: the
// status, the machine-readable code and the Retry-After a consumer branches on.
func TestPostDesktopControl_RendersEveryContractError(t *testing.T) {
	for _, test := range []struct {
		name       string
		err        error
		status     int
		code       pkgerrors.Code
		retryAfter string
	}{
		{"not running", pkgerrors.DesktopNotRunning("this box is not running; resume it first"),
			http.StatusConflict, pkgerrors.CodeDesktopNotRunning, ""},
		{"busy", pkgerrors.DesktopBusy("this box is busy with another desktop action"),
			http.StatusConflict, pkgerrors.CodeDesktopBusy, "1"},
		{"tools unavailable", pkgerrors.DesktopToolsUnavailable("this box's image has no desktop tools; open a new box to get them"),
			http.StatusConflict, pkgerrors.CodeDesktopToolsUnavailable, ""},
		{"frame changed", pkgerrors.DesktopFrameChanged("the desktop changed size", map[string]any{"frame": 1}),
			http.StatusConflict, pkgerrors.CodeDesktopFrameChanged, ""},
		{"focus terminal", pkgerrors.DesktopFocusTerminal("a terminal window has focus", map[string]any{"focused": 1}),
			http.StatusConflict, pkgerrors.CodeDesktopFocusTerminal, ""},
		{"act repeated", pkgerrors.DesktopActRepeated("that act_id already ran on this box"),
			http.StatusConflict, pkgerrors.CodeDesktopActRepeated, ""},
		{"out of bounds", pkgerrors.DesktopInputOutOfBounds("action 3 at 1700,200 is outside the 1600x900 desktop", map[string]any{"index": 3}),
			http.StatusUnprocessableEntity, pkgerrors.CodeDesktopInputOutOfBounds, ""},
		{"not ready", pkgerrors.DesktopNotReady("this box's desktop is still starting; retry shortly"),
			http.StatusServiceUnavailable, pkgerrors.CodeDesktopNotReady, "2"},
		{"not found", pkgerrors.NotFound("workspace not found"), http.StatusNotFound, pkgerrors.CodeNotFound, ""},
		{"no desktop", pkgerrors.BadRequest("this box has no desktop"), http.StatusBadRequest, pkgerrors.CodeBadRequest, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := &WorkspaceDesktopHandler{Service: &recordingDesktopService{err: test.err}}
			rec := httptest.NewRecorder()
			handler.PostDesktopInput(rec, desktopControlRequest(t,
				"/api/repos/alice/demo/workspaces/ws-1/desktop/input",
				`{"act_id":"11111111-2222-3333-4444-555555555555","action":"key","combo":"Return"}`))

			require.Equal(t, test.status, rec.Code)
			var body map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			// Every refusal names a code and a fault, including the ones that
			// used to answer with a bare message.
			assert.Equal(t, string(test.code), body["code"])
			entry, ok := pkgerrors.Lookup(test.code)
			require.True(t, ok)
			assert.Equal(t, string(entry.Fault), body["fault"])
			if test.retryAfter != "" {
				assert.Equal(t, test.retryAfter, rec.Header().Get("Retry-After"))
			}
		})
	}
}

// TestPostDesktopControl_FrameChangedCarriesTheNewObservation proves the
// consumer never has to re-observe after a frame_changed: the fresh screen
// rides on the 409.
func TestPostDesktopControl_FrameChangedCarriesTheNewObservation(t *testing.T) {
	handler := &WorkspaceDesktopHandler{Service: &recordingDesktopService{
		err: pkgerrors.DesktopFrameChanged("the desktop changed size since that observation; nothing was done", map[string]any{
			"frame":       map[string]any{"width": 1600, "height": 900},
			"observation": map[string]any{"workspace_id": "ws-1"},
		}),
	}}
	rec := httptest.NewRecorder()
	handler.PostDesktopInput(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/input",
		`{"act_id":"11111111-2222-3333-4444-555555555555","action":"key","combo":"Return"}`))

	require.Equal(t, http.StatusConflict, rec.Code)
	var body struct {
		Code    pkgerrors.Code `json:"code"`
		Details struct {
			Frame       map[string]int `json:"frame"`
			Observation map[string]any `json:"observation"`
		} `json:"details"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, pkgerrors.CodeDesktopFrameChanged, body.Code)
	assert.Equal(t, 1600, body.Details.Frame["width"])
	assert.Equal(t, "ws-1", body.Details.Observation["workspace_id"])
}

func TestPostDesktopControl_RequiresAuthAndRepoContext(t *testing.T) {
	service := &recordingDesktopService{}
	handler := &WorkspaceDesktopHandler{Service: service}

	anonymous := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/desktop/observe", nil)
	anonymous = withRepoContext(anonymous, "alice", "demo")
	anonymous = withRouteParams(anonymous, map[string]string{"id": "ws-1"})
	rec := httptest.NewRecorder()
	handler.PostDesktopObserve(rec, anonymous)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	noRepo := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/desktop/observe", nil)
	noRepo = withAuth(noRepo, 7, "alice")
	noRepo = withRouteParams(noRepo, map[string]string{"id": "ws-1"})
	rec = httptest.NewRecorder()
	handler.PostDesktopObserve(rec, noRepo)
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	noWorkspace := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces//desktop/observe", nil)
	noWorkspace = withAuth(noWorkspace, 7, "alice")
	noWorkspace = withRepoContext(noWorkspace, "alice", "demo")
	noWorkspace = withRouteParams(noWorkspace, map[string]string{"id": ""})
	rec = httptest.NewRecorder()
	handler.PostDesktopObserve(rec, noWorkspace)
	assert.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	(&WorkspaceDesktopHandler{}).PostDesktopObserve(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/observe", ""))
	assert.Equal(t, http.StatusInternalServerError, rec.Code)

	assert.Equal(t, 0, service.observeCalls)
}

// TestPostDesktopControl_SanitizesInternalErrors keeps guest stderr out of the
// response: it can quote page titles and paths.
func TestPostDesktopControl_SanitizesInternalErrors(t *testing.T) {
	handler := &WorkspaceDesktopHandler{Service: &recordingDesktopService{
		err: pkgerrors.Internal("desktop helper failed: xdotool: /home/developer/secret-notes.txt"),
	}}
	rec := httptest.NewRecorder()
	handler.PostDesktopObserve(rec, desktopControlRequest(t,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/observe", ""))

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.JSONEq(t, `{"code":"internal","fault":"bug","message":"internal server error"}`, rec.Body.String())
}
