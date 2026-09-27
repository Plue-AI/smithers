package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	stdErrors "errors"
	"regexp"
	"sort"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// A hosted deployment never stores a user's Claude.ai or ChatGPT subscription login,
// whether as a provider connection or pasted into a secret or variable. The
// secret, variable and agent-environment writers refuse one unless the
// deployment sets feature_flags.subscription_connections (self-host only).

// subscriptionTokenNames only ever hold a subscription login.
var subscriptionTokenNames = map[string]struct{}{
	"CLAUDE_CODE_OAUTH_TOKEN":   {},
	"OPENAI_CODEX_ACCESS_TOKEN": {},
	"CODEX_AUTH_JSON":           {},
}

// redactedSubscriptionToken replaces a subscription token in a redacted
// setup script. The detectors below never treat it as a token, so saving a
// redacted script back is accepted and clears the stored value.
const redactedSubscriptionToken = "[redacted]"

var (
	// shellTokenAssignment is a literal assigned to a subscription-only name
	// in shell (NAME=value, NAME="value"). A reference ($NAME, ${NAME:-x},
	// NAME="$OTHER", NAME=`cmd`) or an empty assignment is not a literal.
	shellTokenAssignment = regexp.MustCompile(`(?:^|[^{\w$])(?:CLAUDE_CODE_OAUTH_TOKEN|OPENAI_CODEX_ACCESS_TOKEN|CODEX_AUTH_JSON)=["']?([^\s"'$` + "`" + `\\;&|<>()][^\s"'` + "`" + `;&|<>()]*)`)
	// jsonTokenAssignment is the quoted-key document form, "NAME": "value".
	jsonTokenAssignment = regexp.MustCompile(`"(?:CLAUDE_CODE_OAUTH_TOKEN|OPENAI_CODEX_ACCESS_TOKEN|CODEX_AUTH_JSON)"\s*:\s*"([^"$` + "`" + `][^"]*)"`)
	// claudeOAuthToken is a Claude OAuth access or refresh token.
	claudeOAuthToken = regexp.MustCompile(`sk-ant-o[ar]t[A-Za-z0-9_\-]*`)
	// chatGPTAuthMode is the marker of a Codex auth.json, whole or inline.
	chatGPTAuthMode = regexp.MustCompile(`"auth_mode"\s*:\s*"(chatgpt)"`)
	// codexTokens is the flat "tokens" object of a Codex auth.json (older
	// files carry no auth_mode) and codexTokenField one token inside it.
	codexTokens      = regexp.MustCompile(`"tokens"\s*:\s*\{[^{}]*\}`)
	codexTokenMarker = regexp.MustCompile(`"(?:refresh_token|id_token)"\s*:\s*"[^"]`)
	codexTokenField  = regexp.MustCompile(`"(?:access_token|refresh_token|id_token)"\s*:\s*"([^"]+)"`)
	// jwtRun is a run of JWT alphabet and dots; every three consecutive
	// dot-separated parts in it is a candidate isChatGPTAccessToken decides.
	jwtRun = regexp.MustCompile(`[A-Za-z0-9_.\-]+`)
)

// subscriptionTokenSpans returns the byte ranges of the subscription token
// material in value. Detection and redaction share it, so whatever makes a
// value refused is exactly what redaction removes.
func subscriptionTokenSpans(value string) [][2]int {
	var spans [][2]int
	add := func(start, end int) {
		if start < end && value[start:end] != redactedSubscriptionToken {
			spans = append(spans, [2]int{start, end})
		}
	}
	for _, m := range claudeOAuthToken.FindAllStringIndex(value, -1) {
		add(m[0], m[1])
	}
	for _, m := range shellTokenAssignment.FindAllStringSubmatchIndex(value, -1) {
		switch value[m[2]:m[3]] {
		case "null", "true", "false", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_CODEX_ACCESS_TOKEN", "CODEX_AUTH_JSON":
			continue
		}
		add(m[2], m[3])
	}
	for _, m := range jsonTokenAssignment.FindAllStringSubmatchIndex(value, -1) {
		if _, placeholder := subscriptionTokenNames[value[m[2]:m[3]]]; !placeholder {
			add(m[2], m[3])
		}
	}
	for _, m := range chatGPTAuthMode.FindAllStringSubmatchIndex(value, -1) {
		add(m[2], m[3])
	}
	for _, object := range codexTokens.FindAllStringIndex(value, -1) {
		// A Codex tokens object carries an id or refresh token; an
		// access_token alone is some other service's.
		if !codexTokenMarker.MatchString(value[object[0]:object[1]]) {
			continue
		}
		for _, m := range codexTokenField.FindAllStringSubmatchIndex(value[object[0]:object[1]], -1) {
			add(object[0]+m[2], object[0]+m[3])
		}
	}
	for _, run := range jwtRun.FindAllStringIndex(value, -1) {
		parts := strings.Split(value[run[0]:run[1]], ".")
		offset := run[0]
		for i := 0; i+3 <= len(parts); i++ {
			candidate := strings.Join(parts[i:i+3], ".")
			if isChatGPTAccessToken(candidate) {
				add(offset, offset+len(candidate))
			}
			offset += len(parts[i]) + 1
		}
	}
	return spans
}

// isSubscriptionToken reports whether a name/value pair is a Claude or
// ChatGPT subscription credential: a Claude OAuth access or refresh token
// (sk-ant-oat / sk-ant-ort, whatever the name), a ChatGPT access token (a JWT
// carrying the chatgpt_account_id claim), a Codex auth.json, a literal
// assigned to a subscription-only name, or a name that only ever holds one.
// API keys (sk-ant-api, sk-proj) are not.
func isSubscriptionToken(name, value string) bool {
	if _, ok := subscriptionTokenNames[strings.ToUpper(strings.TrimSpace(name))]; ok {
		return true
	}
	if len(subscriptionTokenSpans(value)) > 0 {
		return true
	}
	var auth struct {
		AuthMode string `json:"auth_mode"`
		Tokens   *struct {
			RefreshToken string `json:"refresh_token"`
		} `json:"tokens"`
	}
	return json.Unmarshal([]byte(strings.TrimSpace(value)), &auth) == nil &&
		(auth.AuthMode == "chatgpt" || (auth.Tokens != nil && auth.Tokens.RefreshToken != "" && auth.Tokens.RefreshToken != redactedSubscriptionToken))
}

func isChatGPTAccessToken(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return false
	}
	var claims struct {
		Auth struct {
			AccountID string `json:"chatgpt_account_id"`
		} `json:"https://api.openai.com/auth"`
	}
	return json.Unmarshal(raw, &claims) == nil && claims.Auth.AccountID != ""
}

// refuseSubscriptionToken is the write-path guard. The message starts with
// the feature gate's text so clients treat both refusals the same way.
func refuseSubscriptionToken(allowed bool, name, value string) error {
	if allowed || !isSubscriptionToken(name, value) {
		return nil
	}
	return pkgerrors.Forbidden("feature not available: this deployment does not store Claude or ChatGPT subscription tokens; use an API key")
}

// redactSubscriptionTokens replaces every subscription token in a setup
// script with redactedSubscriptionToken. When something still looks like a
// token afterwards, the whole script is withheld.
func redactSubscriptionTokens(script string) string {
	spans := subscriptionTokenSpans(script)
	sort.Slice(spans, func(i, j int) bool { return spans[i][0] < spans[j][0] })
	var out strings.Builder
	cursor := 0
	for _, span := range spans {
		if span[0] >= cursor {
			out.WriteString(script[cursor:span[0]])
			out.WriteString(redactedSubscriptionToken)
		}
		cursor = max(cursor, span[1])
	}
	out.WriteString(script[cursor:])
	redacted := out.String()
	if isSubscriptionToken("", redacted) {
		return ""
	}
	return redacted
}

// storedSubscriptionTokenRefused is the read-path refusal for an agent
// environment saved before its setup script was checked. Callers pass a 403
// through unwrapped (agentEnvironmentLoadError) so the user sees why.
func storedSubscriptionTokenRefused() error {
	return pkgerrors.Forbidden("feature not available: this repository's agent environment holds a Claude or ChatGPT subscription token; remove it and use an API key")
}

// refuseStoredSubscriptionToken is the read-path guard for a secret or
// variable saved before the write-path refusal: a path that would deliver one
// holding a subscription token refuses with the feature gate's 403 instead.
// The message names the entry, never its value.
func refuseStoredSubscriptionToken(allowed bool, kind, name, value string) error {
	if allowed || value == "" || !isSubscriptionToken(name, value) {
		return nil
	}
	return pkgerrors.Forbidden("feature not available: " + kind + " " + name + " holds a Claude or ChatGPT subscription token; remove it and use an API key")
}

// rebuildRequiredMarker is the store surface that marks a repository's live
// workspaces and its snapshots as built with a subscription token.
type rebuildRequiredMarker interface {
	MarkRepositoryWorkspacesRebuildRequired(ctx context.Context, repositoryID int64) (int64, error)
	MarkRepositorySnapshotsRebuildRequired(ctx context.Context, repositoryID int64) (int64, error)
}

// markRepositoryRebuildRequired marks every live workspace and snapshot of
// the repository rebuild-required and returns how many were newly marked.
func markRepositoryRebuildRequired(ctx context.Context, q rebuildRequiredMarker, repositoryID int64) error {
	_, _, err := markRepositoryRebuildRequiredCount(ctx, q, repositoryID)
	return err
}

func markRepositoryRebuildRequiredCount(ctx context.Context, q rebuildRequiredMarker, repositoryID int64) (workspaces, snapshots int64, err error) {
	if workspaces, err = q.MarkRepositoryWorkspacesRebuildRequired(ctx, repositoryID); err != nil {
		return 0, 0, pkgerrors.Internal("mark workspaces for rebuild").WithCause(err)
	}
	if snapshots, err = q.MarkRepositorySnapshotsRebuildRequired(ctx, repositoryID); err != nil {
		return 0, 0, pkgerrors.Internal("mark workspace snapshots for rebuild").WithCause(err)
	}
	return workspaces, snapshots, nil
}

// refuseRebuildRequired keeps a workspace built while its repository stored
// a subscription token from being reused: resumed, entered, forked or
// snapshotted. Deleting it and creating a new workspace is the rebuild.
func refuseRebuildRequired(workspace db.Workspace) error {
	if !workspace.RebuildRequiredAt.Valid {
		return nil
	}
	return pkgerrors.New(pkgerrors.CodeWorkspaceRebuildRequired, "this workspace was built with a Claude or ChatGPT subscription token; delete it and create a new workspace")
}

// refuseRebuildRequiredSnapshot keeps a snapshot of such a workspace from
// being restored.
func refuseRebuildRequiredSnapshot(snapshot db.WorkspaceSnapshot) error {
	if !snapshot.RebuildRequiredAt.Valid {
		return nil
	}
	return pkgerrors.New(pkgerrors.CodeWorkspaceRebuildRequired, "this snapshot was taken while its repository stored a Claude or ChatGPT subscription token; delete it and create a new workspace")
}

// agentEnvironmentLoadError keeps a refusal as it is and wraps any other load
// failure as internal.
func agentEnvironmentLoadError(err error) error {
	var apiErr *pkgerrors.APIError
	if stdErrors.As(err, &apiErr) && apiErr.Status == 403 {
		return err
	}
	return pkgerrors.Internal("load agent environment for workspace setup").WithCause(err)
}
