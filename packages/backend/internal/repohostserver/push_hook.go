package repohostserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// pushHookDeliveryTimeout bounds each individual push-hook callback. Every
// payload gets its own budget so a large stacked push cannot exhaust a shared
// deadline partway through and silently drop the remaining refs.
const pushHookDeliveryTimeout = 10 * time.Second

// PushHookPayload is one ref update sent to the API. DeliveryID is stable
// across retries of the same event so the API can drop redeliveries.
type PushHookPayload struct {
	RepositoryID int64  `json:"repository_id,omitempty"`
	DeliveryID   string `json:"delivery_id"`
	Owner        string `json:"owner"`
	Repo         string `json:"repo"`
	RefName      string `json:"ref_name"`
	BeforeSHA    string `json:"before_sha"`
	CommitSHA    string `json:"commit_sha"`
	PusherID     int64  `json:"pusher_id"`
	PusherLogin  string `json:"pusher_login"`
	// PusherCredential is the kind of credential the API authenticated for
	// the push; empty when unattributed.
	PusherCredential middleware.CredentialKind `json:"pusher_credential,omitempty"`
}

type PushHookSender struct {
	RepositoryID     int64
	PusherID         int64
	PusherLogin      string
	PusherCredential middleware.CredentialKind
}

func sendPushHook(ctx context.Context, client *http.Client, cfg Config, payload PushHookPayload) error {
	_, err := sendPushHookResult(ctx, client, cfg, payload)
	return err
}

// sendPushHookResult posts one payload and reports whether the API accepted
// it (ok) or no longer knows the repository (not_found). Any other outcome is
// an error the caller must retry.
func sendPushHookResult(ctx context.Context, client *http.Client, cfg Config, payload PushHookPayload) (string, error) {
	if cfg.PushHookCallbackURL == "" {
		return pushHookResultOK, nil
	}
	if cfg.PushHookCallbackToken == "" {
		return "", fmt.Errorf("push hook callback token is not configured")
	}

	body := mustMarshalJSON(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.PushHookCallbackURL, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create push hook request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.PushHookCallbackToken)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("send push hook callback request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound && repositoryNotFound(resp) {
		// The repository was deleted after the push; nothing to dispatch.
		return pushHookResultNotFound, nil
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("push hook callback returned status %d", resp.StatusCode)
	}

	return pushHookResultOK, nil
}

// repositoryNotFound reports whether a 404 carries the API's typed not_found
// code. Any other 404 (a wrong callback path, or an API that did not register
// the push-hook route) is a failed delivery, not a deleted repository.
func repositoryNotFound(resp *http.Response) bool {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body); err != nil {
		return false
	}
	return body.Code == "not_found"
}

func mustMarshalJSON(v any) []byte {
	body, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("marshal json: %v", err))
	}
	return body
}

func pushHookClient() *http.Client {
	return observability.NewHTTPClient(10 * time.Second)
}

func pushHookSenderFromHeaders(headers http.Header) PushHookSender {
	var pusherID int64
	if value := headers.Get("X-Smithers-Pusher-Id"); value != "" {
		_, _ = fmt.Sscan(value, &pusherID)
	}
	repositoryID, err := strconv.ParseInt(headers.Get(repohost.RepositoryIDHeader), 10, 64)
	if err != nil {
		repositoryID = 0
	}
	return PushHookSender{
		RepositoryID:     repositoryID,
		PusherID:         pusherID,
		PusherLogin:      headers.Get("X-Smithers-Pusher-Login"),
		PusherCredential: middleware.ParseCredentialKind(headers.Get(repohost.PusherCredentialHeader)),
	}
}

func pushHookPayloadsFromRefDiff(beforeRefs, afterRefs map[string]string, owner, repo string, sender PushHookSender) []PushHookPayload {
	refSet := make(map[string]struct{}, len(beforeRefs)+len(afterRefs))
	for refName := range beforeRefs {
		refSet[refName] = struct{}{}
	}
	for refName := range afterRefs {
		refSet[refName] = struct{}{}
	}

	refNames := make([]string, 0, len(refSet))
	for refName := range refSet {
		refNames = append(refNames, refName)
	}
	sort.Strings(refNames)

	payloads := make([]PushHookPayload, 0, len(refNames))
	for _, refName := range refNames {
		// refs/jj/* (especially refs/jj/keep/*) are implementation details that
		// can change in bulk during one push. They are not user push events and
		// must not trigger webhooks or workflows. Match Git hosting semantics by
		// publishing only branch and tag updates.
		if !strings.HasPrefix(refName, "refs/heads/") && !strings.HasPrefix(refName, "refs/tags/") {
			continue
		}
		// The mythical stack is the stack service's own bookkeeping, rewritten
		// on every fold; it is not a user push and starts no workflow.
		if repohost.IsMythicalRef(refName) {
			continue
		}
		beforeSHA, hadBefore := beforeRefs[refName]
		afterSHA, hadAfter := afterRefs[refName]
		if hadBefore == hadAfter && beforeSHA == afterSHA {
			continue
		}
		payloads = append(payloads, PushHookPayload{
			RepositoryID:     sender.RepositoryID,
			Owner:            owner,
			Repo:             repo,
			RefName:          refName,
			BeforeSHA:        beforeSHA,
			CommitSHA:        afterSHA,
			PusherID:         sender.PusherID,
			PusherLogin:      sender.PusherLogin,
			PusherCredential: sender.PusherCredential,
		})
	}

	return payloads
}
