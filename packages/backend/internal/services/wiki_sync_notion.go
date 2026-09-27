package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// NotionSync is explicitly connected to one parent page. Credentials live in
// the supplied client configuration only, never in cursors or delivery payloads.
type NotionSync struct {
	token, parent string
	client        *http.Client
}

func NewNotionSync(token, parent string, client *http.Client) (*NotionSync, error) {
	if strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("Notion credentials are required")
	}
	id, err := uuid.Parse(parent)
	if err != nil {
		return nil, fmt.Errorf("Notion parent page identity is required")
	}
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	copy := *client
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if copy.Timeout == 0 {
		copy.Timeout = 30 * time.Second
	}
	return &NotionSync{token: token, parent: id.String(), client: &copy}, nil
}
func (a *NotionSync) Provider() string { return "notion" }
func (a *NotionSync) Scope() string    { return a.parent }
func (a *NotionSync) request(ctx context.Context, method, endpoint string, body any, out any) error {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.notion.com/v1/"+endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("Notion-Version", "2026-03-11")
	req.Header.Set("Content-Type", "application/json")
	response, err := a.client.Do(req)
	if err != nil {
		if method != "GET" {
			return ErrSyncOutcomeUnknown
		}
		return fmt.Errorf("Notion read failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if method != "GET" && (response.StatusCode >= 500 || response.StatusCode == 408) {
			return ErrSyncOutcomeUnknown
		}
		return fmt.Errorf("Notion request refused: HTTP %d", response.StatusCode)
	}
	if response.StatusCode == 202 {
		return ErrSyncOutcomeUnknown
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, 2*maxWikiBodyBytes+1))
	if err != nil || len(data) > 2*maxWikiBodyBytes {
		if method != "GET" {
			return ErrSyncOutcomeUnknown
		}
		return fmt.Errorf("Notion response exceeds content limit")
	}
	if err = json.Unmarshal(data, out); err != nil {
		if method != "GET" {
			return ErrSyncOutcomeUnknown
		}
		return fmt.Errorf("invalid Notion response")
	}
	return nil
}
func (a *NotionSync) markdown(ctx context.Context, id string) ([]byte, error) {
	if _, err := uuid.Parse(id); err != nil {
		return nil, fmt.Errorf("invalid Notion page identity")
	}
	var response struct {
		Markdown  string   `json:"markdown"`
		Truncated bool     `json:"truncated"`
		Unknown   []string `json:"unknown_block_ids"`
	}
	if err := a.request(ctx, "GET", "pages/"+id+"/markdown", nil, &response); err != nil {
		return nil, err
	}
	if response.Truncated || len(response.Unknown) > 0 {
		return nil, fmt.Errorf("unsupported Notion formatting or truncated content")
	}
	if err := notionMarkdownSupported(response.Markdown); err != nil {
		return nil, err
	}
	return []byte(response.Markdown), nil
}
func notionMarkdownSupported(body string) error {
	if len(body) > maxWikiBodyBytes {
		return fmt.Errorf("unsupported Notion content size")
	}
	if err := validWikiBody(body); err != nil {
		return err
	}
	if strings.HasPrefix(body, "---") || strings.Contains(body, "[[") || strings.Contains(body, "<") || strings.Contains(body, "![") || strings.Contains(body, "|") {
		return fmt.Errorf("unsupported Notion formatting: frontmatter, wiki links, embeds, tables or enhanced blocks")
	}
	return nil
}
func (a *NotionSync) Scan(ctx context.Context) ([]SyncDocument, error) {
	docs := []SyncDocument{}
	cursor := ""
	seen := map[string]bool{}
	for {
		endpoint := "blocks/" + a.parent + "/children?page_size=100"
		if cursor != "" {
			endpoint += "&start_cursor=" + url.QueryEscape(cursor)
		}
		var response struct {
			Results []struct {
				ID       string `json:"id"`
				Type     string `json:"type"`
				Edited   string `json:"last_edited_time"`
				Archived bool   `json:"archived"`
				Child    struct {
					Title string `json:"title"`
				} `json:"child_page"`
			} `json:"results"`
			More bool   `json:"has_more"`
			Next string `json:"next_cursor"`
		}
		if err := a.request(ctx, "GET", endpoint, nil, &response); err != nil {
			return nil, err
		}
		for _, page := range response.Results {
			if page.Type != "child_page" || page.Archived {
				continue
			}
			if _, err := uuid.Parse(page.ID); err != nil {
				return nil, fmt.Errorf("invalid Notion page identity")
			}
			name := page.Child.Title
			if !strings.HasSuffix(name, ".md") {
				name += ".md"
			}
			if err := validSyncPath(name); err != nil {
				return nil, err
			}
			body, err := a.markdown(ctx, page.ID)
			if err != nil {
				return nil, err
			}
			docs = append(docs, SyncDocument{ID: page.ID, Path: name, Digest: wikiDigest(body), Version: page.Edited, MediaType: "text/markdown"})
		}
		if !response.More {
			return docs, nil
		}
		if response.Next == "" || seen[response.Next] {
			return nil, fmt.Errorf("Notion cursor did not advance")
		}
		cursor = response.Next
		seen[cursor] = true
	}
}
func (a *NotionSync) Read(ctx context.Context, d SyncDocument) ([]byte, error) {
	body, err := a.markdown(ctx, d.ID)
	if err != nil {
		return nil, err
	}
	if wikiDigest(body) != d.Digest {
		return nil, api.Conflict("Notion content changed")
	}
	return body, nil
}
func (a *NotionSync) Apply(ctx context.Context, key string, expected, desired *SyncDocument, data []byte) (*SyncDocument, error) {
	if desired != nil {
		if !strings.HasSuffix(desired.Path, ".md") {
			return nil, fmt.Errorf("unsupported Notion attachment")
		}
		if err := validSyncPath(desired.Path); err != nil {
			return nil, err
		}
		if err := notionMarkdownSupported(string(data)); err != nil {
			return nil, err
		}
		if wikiDigest(data) != desired.Digest {
			return nil, fmt.Errorf("sync content digest mismatch")
		}
	}
	docs, err := a.Scan(ctx)
	if err != nil {
		return nil, err
	}
	var current *SyncDocument
	for _, d := range docs {
		if expected != nil && d.ID == expected.ID {
			copy := d
			current = &copy
		}
		if desired != nil && d.Path == desired.Path {
			if sameSyncContent(&d, desired) && (expected == nil || d.ID == expected.ID) {
				return &d, nil
			}
			if expected == nil || d.ID != expected.ID {
				return nil, api.Conflict("Notion destination exists")
			}
		}
	}
	if expected != nil {
		if current == nil && desired == nil {
			return nil, nil
		}
		if !sameSyncContent(current, expected) || current.Version != expected.Version {
			return nil, api.Conflict("Notion sync conflict")
		}
	}
	var response map[string]any
	if desired == nil {
		if current == nil {
			return nil, nil
		}
		err = a.request(ctx, "PATCH", "pages/"+current.ID, map[string]any{"in_trash": true}, &response)
		return nil, err
	}
	title := map[string]any{"title": map[string]any{"type": "title", "title": []any{map[string]any{"type": "text", "text": map[string]any{"content": desired.Path}}}}}
	if expected == nil {
		err = a.request(ctx, "POST", "pages", map[string]any{"parent": map[string]any{"type": "page_id", "page_id": a.parent}, "properties": title, "markdown": string(data)}, &response)
	} else {
		if current.Digest != desired.Digest {
			err = a.request(ctx, "PATCH", "pages/"+current.ID+"/markdown", map[string]any{"type": "replace_content", "replace_content": map[string]any{"new_str": string(data)}}, &response)
		}
		if err == nil && current.Path != desired.Path {
			err = a.request(ctx, "PATCH", "pages/"+current.ID, map[string]any{"properties": title}, &response)
			if err != nil {
				return nil, ErrSyncOutcomeUnknown
			}
		}
	}
	if err != nil {
		return nil, err
	}
	docs, err = a.Scan(ctx)
	if err != nil {
		return nil, ErrSyncOutcomeUnknown
	}
	for _, d := range docs {
		if sameSyncContent(&d, desired) {
			return &d, nil
		}
	}
	return nil, fmt.Errorf("%w: unsupported Notion formatting conversion", ErrSyncOutcomeUnknown)
}
