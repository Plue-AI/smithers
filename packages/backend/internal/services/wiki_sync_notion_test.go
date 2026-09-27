package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type notionSyncTransport func(*http.Request) (*http.Response, error)

func (f notionSyncTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestNotionSyncCredentialsAndConversion(t *testing.T) {
	_, err := NewNotionSync("", "parent", nil)
	require.Error(t, err)
	calls := 0
	client := &http.Client{Transport: notionSyncTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, "Bearer supplied", r.Header.Get("Authorization"))
		require.Equal(t, "api.notion.com", r.URL.Host)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"markdown":"text","truncated":true}`)), Header: http.Header{}}, nil
	})}
	a, err := NewNotionSync("supplied", "11111111-1111-1111-1111-111111111111", client)
	require.NoError(t, err)
	_, err = a.Read(context.Background(), SyncDocument{ID: "22222222-2222-2222-2222-222222222222"})
	require.ErrorContains(t, err, "unsupported")
	require.Equal(t, 1, calls)
	body := []byte("---\ntags: [x]\n---\n[[Wiki]]")
	_, err = a.Apply(context.Background(), "key", nil, &SyncDocument{Path: "Page.md", Digest: wikiDigest(body)}, body)
	require.ErrorContains(t, err, "unsupported")
	require.Equal(t, 1, calls)
}

func TestNotionSyncAmbiguousWriteIsNotRetried(t *testing.T) {
	writes := 0
	client := &http.Client{Transport: notionSyncTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method == "POST" {
			writes++
			return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader(`{}`)), Header: http.Header{}}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"results":[],"has_more":false}`)), Header: http.Header{}}, nil
	})}
	a, err := NewNotionSync("supplied", "11111111-1111-1111-1111-111111111111", client)
	require.NoError(t, err)
	data := []byte("hello")
	_, err = a.Apply(context.Background(), "key", nil, &SyncDocument{Path: "Page.md", Digest: wikiDigest(data)}, data)
	require.ErrorIs(t, err, ErrSyncOutcomeUnknown)
	require.Equal(t, 1, writes)
}

func TestNotionSyncMarkdownRoundTrip(t *testing.T) {
	const parent = "11111111-1111-1111-1111-111111111111"
	const page = "22222222-2222-2222-2222-222222222222"
	title, body, exists, version := "", "", false, 0
	client := &http.Client{Transport: notionSyncTransport(func(r *http.Request) (*http.Response, error) {
		require.Equal(t, "2026-03-11", r.Header.Get("Notion-Version"))
		var input map[string]any
		if r.Method != "GET" {
			require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
		}
		result := map[string]any{}
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/blocks/"):
			results := []any{}
			if exists {
				results = append(results, map[string]any{"id": page, "type": "child_page", "last_edited_time": fmt.Sprint(version), "child_page": map[string]any{"title": title}})
			}
			result = map[string]any{"results": results, "has_more": false}
		case r.Method == "GET":
			result = map[string]any{"markdown": body, "truncated": false, "unknown_block_ids": []string{}}
		case r.Method == "POST":
			require.Equal(t, parent, input["parent"].(map[string]any)["page_id"])
			exists = true
			body = input["markdown"].(string)
			version++
			fallthrough
		default:
			if props, ok := input["properties"]; ok {
				title = props.(map[string]any)["title"].(map[string]any)["title"].([]any)[0].(map[string]any)["text"].(map[string]any)["content"].(string)
				version++
			}
			if input["type"] == "replace_content" {
				body = input["replace_content"].(map[string]any)["new_str"].(string)
				version++
			}
			if input["in_trash"] == true {
				exists = false
			}
			result = map[string]any{"id": page}
		}
		encoded, err := json.Marshal(result)
		require.NoError(t, err)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(encoded)), Header: http.Header{}}, nil
	})}
	a, err := NewNotionSync("supplied", parent, client)
	require.NoError(t, err)
	ctx := context.Background()
	desired := &SyncDocument{Path: "Page.md", Digest: wikiDigest([]byte("hello"))}
	first, err := a.Apply(ctx, "create", nil, desired, []byte("hello"))
	require.NoError(t, err)
	require.Equal(t, page, first.ID)
	data, err := a.Read(ctx, *first)
	require.NoError(t, err)
	require.Equal(t, "hello", string(data))
	next := &SyncDocument{Path: "Renamed.md", Digest: wikiDigest([]byte("edited"))}
	second, err := a.Apply(ctx, "edit", first, next, []byte("edited"))
	require.NoError(t, err)
	require.Equal(t, page, second.ID)
	require.Equal(t, "Renamed.md", title)
	version++ // external edit after the scan, including a same-content edit
	_, err = a.Apply(ctx, "stale", second, nil, nil)
	require.ErrorContains(t, err, "conflict")
	docs, err := a.Scan(ctx)
	require.NoError(t, err)
	require.Len(t, docs, 1)
	_, err = a.Apply(ctx, "delete", &docs[0], nil, nil)
	require.NoError(t, err)
	require.False(t, exists)
}
