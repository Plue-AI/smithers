// Package subscriptiontoken is the one detector for a Claude or ChatGPT
// subscription login (#2178). Every path that refuses one on save or on use,
// and the one-time stored-token scan (#2206), asks Holds. HoldsClaude is the
// Claude half, refused on every deployment (#2777).
package subscriptiontoken

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

// claudeTokenName only ever holds a Claude subscription login.
const claudeTokenName = "CLAUDE_CODE_OAUTH_TOKEN"

// subscriptionTokenNames only ever hold a subscription login.
var subscriptionTokenNames = map[string]struct{}{
	claudeTokenName:             {},
	"OPENAI_CODEX_ACCESS_TOKEN": {},
	"CODEX_AUTH_JSON":           {},
}

// redactedToken replaces a subscription token in a redacted setup script.
// The detectors below never treat it as a token, so saving a redacted script
// back is accepted and clears the stored value.
const redactedToken = "[redacted]"

// removedClaudeToken replaces a Claude subscription token removed from a
// stored setup script (#2777). Like redactedToken it is never a token.
const removedClaudeToken = "[removed:#2777]"

// tokenAssignments returns the patterns for a literal assigned to one of
// names: in shell (NAME=value, NAME="value"; a reference ($NAME, ${NAME:-x},
// NAME="$OTHER", NAME=`cmd`) or an empty assignment is not a literal), and
// in the quoted-key document form, "NAME": "value".
func tokenAssignments(names string) (shell, document *regexp.Regexp) {
	shell = regexp.MustCompile(`(?:^|[^{\w$])(?:` + names + `)=["']?([^\s"'$` + "`" + `\\;&|<>()][^\s"'` + "`" + `;&|<>()]*)`)
	document = regexp.MustCompile(`"(?:` + names + `)"\s*:\s*"([^"$` + "`" + `][^"]*)"`)
	return shell, document
}

var (
	shellTokenAssignment, jsonTokenAssignment   = tokenAssignments(claudeTokenName + "|OPENAI_CODEX_ACCESS_TOKEN|CODEX_AUTH_JSON")
	shellClaudeAssignment, jsonClaudeAssignment = tokenAssignments(claudeTokenName)
	// claudeOAuthToken is a Claude OAuth access or refresh token, or a
	// Claude.ai session key (group 1), never the tail of a longer word such
	// as flask-ant-sidecar: a match deletes stored rows.
	claudeOAuthToken = regexp.MustCompile(`(?:^|[^A-Za-z0-9])(sk-ant-(?:o[ar]t|sid)[A-Za-z0-9_\-]*)`)
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
// material in value, only Claude's when claudeOnly. Detection and redaction
// share it, so whatever makes a value refused is exactly what redaction
// removes.
func subscriptionTokenSpans(value string, claudeOnly bool) [][2]int {
	shell, document := shellTokenAssignment, jsonTokenAssignment
	if claudeOnly {
		shell, document = shellClaudeAssignment, jsonClaudeAssignment
	}
	var spans [][2]int
	add := func(start, end int) {
		if start < end && value[start:end] != redactedToken && value[start:end] != removedClaudeToken {
			spans = append(spans, [2]int{start, end})
		}
	}
	for _, m := range claudeOAuthToken.FindAllStringSubmatchIndex(value, -1) {
		add(m[2], m[3])
	}
	for _, m := range shell.FindAllStringSubmatchIndex(value, -1) {
		switch value[m[2]:m[3]] {
		case "null", "true", "false", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_CODEX_ACCESS_TOKEN", "CODEX_AUTH_JSON":
			continue
		}
		add(m[2], m[3])
	}
	for _, m := range document.FindAllStringSubmatchIndex(value, -1) {
		if _, placeholder := subscriptionTokenNames[value[m[2]:m[3]]]; !placeholder {
			add(m[2], m[3])
		}
	}
	if claudeOnly {
		return spans
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

// Holds reports whether a name/value pair is a Claude or
// ChatGPT subscription credential: a Claude OAuth access or refresh token
// (sk-ant-oat / sk-ant-ort) or Claude.ai session key (sk-ant-sid), whatever
// the name, a ChatGPT access token (a JWT
// carrying the chatgpt_account_id claim), a Codex auth.json, a literal
// assigned to a subscription-only name, or a name that only ever holds one.
// API keys (sk-ant-api, sk-proj) are not.
func Holds(name, value string) bool {
	if _, ok := subscriptionTokenNames[strings.ToUpper(strings.TrimSpace(name))]; ok {
		return true
	}
	if len(subscriptionTokenSpans(value, false)) > 0 {
		return true
	}
	var auth struct {
		AuthMode string `json:"auth_mode"`
		Tokens   *struct {
			RefreshToken string `json:"refresh_token"`
		} `json:"tokens"`
	}
	return json.Unmarshal([]byte(strings.TrimSpace(value)), &auth) == nil &&
		(auth.AuthMode == "chatgpt" || (auth.Tokens != nil && auth.Tokens.RefreshToken != "" && auth.Tokens.RefreshToken != redactedToken))
}

// HoldsClaude reports whether a name/value pair is a Claude subscription
// credential: a Claude OAuth access or refresh token (sk-ant-oat /
// sk-ant-ort) or Claude.ai session key (sk-ant-sid), whatever the name, a
// literal assigned to
// CLAUDE_CODE_OAUTH_TOKEN, or that name itself. Every deployment refuses one,
// whatever feature_flags.subscription_connections says (#2777).
func HoldsClaude(name, value string) bool {
	return strings.EqualFold(strings.TrimSpace(name), claudeTokenName) || len(subscriptionTokenSpans(value, true)) > 0
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

// Redact replaces every subscription token in a setup script with
// "[redacted]". When something still looks like a token afterwards, the
// whole script is withheld.
func Redact(script string) string {
	redacted := replaceSpans(script, false, redactedToken)
	if Holds("", redacted) {
		return ""
	}
	return redacted
}

// RemoveClaude replaces every Claude subscription token in a setup script
// with "[removed:#2777]" and leaves a ChatGPT one as it is. When something
// still looks like a Claude token afterwards, only the marker is left.
func RemoveClaude(script string) string {
	removed := replaceSpans(script, true, removedClaudeToken)
	if HoldsClaude("", removed) {
		return removedClaudeToken
	}
	return removed
}

func replaceSpans(script string, claudeOnly bool, marker string) string {
	spans := subscriptionTokenSpans(script, claudeOnly)
	sort.Slice(spans, func(i, j int) bool { return spans[i][0] < spans[j][0] })
	var out strings.Builder
	cursor := 0
	for _, span := range spans {
		if span[0] >= cursor {
			out.WriteString(script[cursor:span[0]])
			out.WriteString(marker)
		}
		cursor = max(cursor, span[1])
	}
	out.WriteString(script[cursor:])
	return out.String()
}
