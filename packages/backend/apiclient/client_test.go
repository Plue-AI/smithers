package apiclient_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/apiclient"
)

// seen is one request as the server received it.
type seen struct {
	Method, RawPath, Query, Accept, ContentType, Authorization, IdempotencyKey string
	Body                                                                       []byte
}

func server(t *testing.T, status int, contentType, reply string) (*apiclient.Client, *[]seen) {
	t.Helper()
	requests := &[]seen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		*requests = append(*requests, seen{
			Method: r.Method, RawPath: r.URL.EscapedPath(), Query: r.URL.RawQuery, Accept: r.Header.Get("Accept"),
			ContentType: r.Header.Get("Content-Type"), Authorization: r.Header.Get("Authorization"),
			IdempotencyKey: r.Header.Get("Idempotency-Key"), Body: body,
		})
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(srv.Close)
	return &apiclient.Client{BaseURL: srv.URL + "/", Header: http.Header{"Authorization": {"token smithers_test"}}}, requests
}

func TestTypedResponseDecodesAndSendsHeaders(t *testing.T) {
	client, requests := server(t, http.StatusOK, "application/json",
		`{"status":"degraded","checked_at":"2026-09-29T10:00:00Z","components":{"canary":{"status":"error","detail":"stale"}}}`)
	status, err := client.GetAPIStatus(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "degraded", status.Status)
	assert.Equal(t, time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC), status.CheckedAt.UTC())
	assert.Equal(t, "error", status.Components.Canary.Status)
	assert.Equal(t, "stale", status.Components.Canary.Detail)
	require.Len(t, *requests, 1)
	request := (*requests)[0]
	assert.Equal(t, "GET", request.Method)
	assert.Equal(t, "/api/status", request.RawPath, "a trailing slash on BaseURL is not doubled")
	assert.Equal(t, "application/json", request.Accept)
	assert.Equal(t, "token smithers_test", request.Authorization)
	assert.Empty(t, request.ContentType, "a request without a body declares no content type")
	assert.Empty(t, request.Body)
}

func TestPathParametersAreEscapedPerSegment(t *testing.T) {
	client, requests := server(t, http.StatusNoContent, "", "")
	require.NoError(t, client.DeleteAPIOrgsOrgSecretsName(context.Background(), "a/b", "c?#@x.test"))
	require.NoError(t, client.DeleteAPIUserKeysID(context.Background(), 42))
	require.Len(t, *requests, 2)
	assert.Equal(t, "/api/orgs/a%2Fb/secrets/c%3F%23@x.test", (*requests)[0].RawPath)
	assert.Equal(t, "DELETE", (*requests)[1].Method)
	assert.Equal(t, "/api/user/keys/42", (*requests)[1].RawPath)
}

func TestQueryParametersSkipUnsetValues(t *testing.T) {
	client, requests := server(t, http.StatusOK, "application/json", `{}`)
	from, to, whitespace := "abc", int64(25), "ignore"
	_, err := client.GetAPIReposOwnerRepoChangesChangeIDDiff(context.Background(), "o", "r", "c", apiclient.GetAPIReposOwnerRepoChangesChangeIDDiffParams{From: &from, To: &to, Whitespace: &whitespace})
	require.NoError(t, err)
	_, err = client.GetAPIReposOwnerRepoChangesChangeIDDiff(context.Background(), "o", "r", "c", apiclient.GetAPIReposOwnerRepoChangesChangeIDDiffParams{})
	require.NoError(t, err)
	since := time.Date(2026, 9, 1, 8, 30, 0, 500, time.UTC)
	_, err = client.GetAPIReposOwnerRepoChangesCount(context.Background(), "o", "r", apiclient.GetAPIReposOwnerRepoChangesCountParams{Rev: "main", Since: since})
	require.NoError(t, err)
	require.Len(t, *requests, 3)
	assert.Equal(t, "from=abc&to=25&whitespace=ignore", (*requests)[0].Query)
	assert.Empty(t, (*requests)[1].Query)
	assert.Equal(t, "rev=main&since=2026-09-01T08%3A30%3A00.0000005Z", (*requests)[2].Query)
}

func TestTypedBodyIsSentAsJSON(t *testing.T) {
	client, requests := server(t, http.StatusCreated, "application/json",
		`{"id":3,"name":"laptop","fingerprint":"SHA256:x","key_type":"ssh-ed25519","created_at":"2026-09-29T10:00:00Z"}`)
	key, err := client.PostAPIUserKeys(context.Background(), apiclient.PostAPIUserKeysBody{Title: "laptop", Key: "ssh-ed25519 AAAA"})
	require.NoError(t, err)
	assert.Equal(t, int64(3), key.ID)
	assert.Equal(t, "ssh-ed25519", key.KeyType)
	request := (*requests)[0]
	assert.Equal(t, "POST", request.Method)
	assert.Equal(t, "application/json", request.ContentType)
	assert.JSONEq(t, `{"title":"laptop","key":"ssh-ed25519 AAAA"}`, string(request.Body))
}

func TestRequiredHeaderIsSentPerCall(t *testing.T) {
	client, requests := server(t, http.StatusAccepted, "application/json", `{"state":"accepted","n":4,"rev":1}`)
	place := apiclient.PostAPITodosBodyPlace{Mode: "append"}
	accepted, err := client.PostAPITodos(context.Background(), "draft-7", apiclient.PostAPITodosBody{Title: "One", Prompt: "Change README", Place: &place})
	require.NoError(t, err)
	assert.Equal(t, apiclient.PostAPITodosResponse{State: "accepted", N: 4, Rev: 1}, accepted)
	_, err = client.PostAPITodos(context.Background(), "draft-8", apiclient.PostAPITodosBody{Title: "Two", Prompt: "Change README"})
	require.NoError(t, err)
	assert.Equal(t, "draft-7", (*requests)[0].IdempotencyKey)
	assert.Equal(t, "draft-8", (*requests)[1].IdempotencyKey, "the key belongs to its call, not the client")
	assert.Equal(t, "token smithers_test", (*requests)[0].Authorization, "the client's own headers still go")
	assert.JSONEq(t, `{"title":"One","prompt":"Change README","place":{"mode":"append"}}`, string((*requests)[0].Body))
}

func TestTodoReadsDecodeTheCard(t *testing.T) {
	card := `{"n":1,"title":"One","state":"queued","owner":{"login":"o","name":"","avatar_url":"https://a/o.png"},"place":1,` +
		`"prompt_revisions":[{"text":"Change README","acceptance":[],"by":{"kind":"person","login":"o"},"at":"2026-10-04T19:00:00Z"}],` +
		`"steps":[],"waits":[],"steers":[],"evidence":[],"merge":{"state":"waiting","reason":"state","on_github":false},"present":[],"queue":{"position":1}}`
	client, _ := server(t, http.StatusOK, "application/json", "["+card+"]")
	cards, err := client.GetAPITodos(context.Background())
	require.NoError(t, err)
	require.Len(t, cards, 1)
	assert.Equal(t, int64(1), cards[0].N)
	assert.Equal(t, "Change README", cards[0].PromptRevisions[0].Text)
	assert.Equal(t, "waiting", cards[0].Merge.State)
	assert.JSONEq(t, `{"position":1}`, string(cards[0].AdditionalProperties["queue"]), "members the description does not list survive")
	client, _ = server(t, http.StatusOK, "application/json", card)
	one, err := client.GetAPITodosN(context.Background(), 1)
	require.NoError(t, err)
	assert.Equal(t, "One", one.Title)
}

func TestUntypedBodyIsOptional(t *testing.T) {
	client, requests := server(t, http.StatusOK, "application/json", `{"ok":true}`)
	out, err := client.PostAPIAgentTurnCancel(context.Background(), nil)
	require.NoError(t, err)
	assert.JSONEq(t, `{"ok":true}`, string(out))
	_, err = client.PostAPIAgentTurnCancel(context.Background(), map[string]string{"turn": "t1"})
	require.NoError(t, err)
	assert.Empty(t, (*requests)[0].Body)
	assert.Empty(t, (*requests)[0].ContentType)
	assert.JSONEq(t, `{"turn":"t1"}`, string((*requests)[1].Body))
}

func TestEmptySuccessBodyLeavesTheZeroValue(t *testing.T) {
	client, _ := server(t, http.StatusOK, "application/json", " \n")
	out, err := client.GetAPIUserKeys(context.Background())
	require.NoError(t, err)
	assert.Nil(t, out)
}

func TestNon2xxIsAResponseError(t *testing.T) {
	client, _ := server(t, http.StatusNotFound, "application/json", `{"message":"not found"}`+"\n")
	_, err := client.GetAPIUserKeysID(context.Background(), 9)
	var failure *apiclient.ResponseError
	require.True(t, errors.As(err, &failure), "%v", err)
	assert.Equal(t, http.StatusNotFound, failure.StatusCode)
	assert.Equal(t, "GET", failure.Method)
	assert.Equal(t, "/api/user/keys/9", failure.Path)
	assert.JSONEq(t, `{"message":"not found"}`, string(failure.Body))
	assert.Equal(t, `GET /api/user/keys/9 -> 404: {"message":"not found"}`, failure.Error())
}

func TestUndecodableResponseIsAnError(t *testing.T) {
	client, _ := server(t, http.StatusOK, "application/json", `{"id":"three"}`)
	_, err := client.GetAPIUserKeysID(context.Background(), 3)
	require.ErrorContains(t, err, "GET /api/user/keys/3: decode response")
}

func TestStreamingOperationReturnsTheRawResponse(t *testing.T) {
	client, requests := server(t, http.StatusOK, "text/event-stream", "data: {}\n\n")
	response, err := client.GetAPIAdminAuditLogs(context.Background())
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	assert.Equal(t, "data: {}\n\n", string(body))
	assert.Equal(t, "text/event-stream", (*requests)[0].Accept)
}

type failingDoer struct{ err error }

func (d failingDoer) Do(*http.Request) (*http.Response, error) { return nil, d.err }

func TestTransportAndEncodingFailures(t *testing.T) {
	refused := errors.New("connection refused")
	client := &apiclient.Client{BaseURL: "http://smithers.test", HTTPClient: failingDoer{err: refused}}
	_, err := client.GetAPIStatus(context.Background())
	require.ErrorIs(t, err, refused)
	_, err = client.PostAPIAgentTurnCancel(context.Background(), make(chan int))
	require.ErrorContains(t, err, "POST /api/agent/turn/cancel: encode body")
	_, err = (&apiclient.Client{BaseURL: "://bad"}).GetAPIStatus(context.Background())
	require.Error(t, err)
}

func TestCancelledContextStopsTheRequest(t *testing.T) {
	client, requests := server(t, http.StatusOK, "application/json", `{}`)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.GetAPIHealth(ctx)
	require.ErrorIs(t, err, context.Canceled)
	assert.Empty(t, *requests)
}

func TestRawJSONRoundTrips(t *testing.T) {
	client, _ := server(t, http.StatusOK, "application/json", `[1,"two",{"three":3}]`)
	out, err := client.GetAPIHealth(context.Background())
	require.NoError(t, err)
	var decoded []any
	require.NoError(t, json.Unmarshal(out, &decoded))
	assert.Len(t, decoded, 3)
}

func TestUndeclaredMembersSurviveARoundTrip(t *testing.T) {
	client, _ := server(t, http.StatusOK, "application/json",
		`{"id":5,"issue_id":2,"user_id":3,"commenter":"alice","body":"hi","type":"comment","origin":"app",`+
			`"created_at":"2026-09-29T10:00:00Z","updated_at":"2026-09-29T10:00:00Z","reactions":[{"emoji":"+1"}],"edited":true}`)
	comment, err := client.PatchAPIReposOwnerRepoIssuesCommentsID(context.Background(), "o", "r", "5")
	require.NoError(t, err)
	assert.Equal(t, int64(5), comment.ID)
	assert.Equal(t, "alice", comment.Commenter)
	assert.Equal(t, map[string]json.RawMessage{"reactions": json.RawMessage(`[{"emoji":"+1"}]`), "edited": json.RawMessage(`true`)}, comment.AdditionalProperties)

	encoded, err := json.Marshal(comment)
	require.NoError(t, err)
	var members map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &members))
	assert.JSONEq(t, `[{"emoji":"+1"}]`, string(members["reactions"]))
	assert.JSONEq(t, `"alice"`, string(members["commenter"]))

	// A declared member wins over an extra of the same name, and no extras
	// leaves the field nil.
	comment.AdditionalProperties = map[string]json.RawMessage{"commenter": json.RawMessage(`"mallory"`)}
	encoded, err = json.Marshal(comment)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(encoded, &members))
	assert.JSONEq(t, `"alice"`, string(members["commenter"]))
	var plain apiclient.IssueComment
	require.NoError(t, json.Unmarshal([]byte(`{"id":1,"origin":"app"}`), &plain))
	assert.Nil(t, plain.AdditionalProperties)
	require.Error(t, json.Unmarshal([]byte(`{"id":"one"}`), &plain))
}
