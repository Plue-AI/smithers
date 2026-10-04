package errors

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// APIError is every failure plue answers with. It serializes the machine-
// readable verdict FIRST — code, fault, retry_after — and the human sentence
// after it, because the Cloudflare Worker in front of plue classifies a
// refusal by reading only the first 240 bytes of the upstream body. Go's
// encoding/json emits struct fields in declaration order, so the order below
// IS the wire order: adding a field before Message, or moving Message up,
// silently breaks that classifier. TestErrorBodyPutsVerdictFirst pins it.
type APIError struct {
	// Status is the HTTP status. It comes from the registry via New; a call
	// site does not get to disagree with the code it raised.
	Status int `json:"-"`
	// Code is the machine-readable verdict. It is always present on the wire:
	// clients branch on Code, never on Message.
	Code Code `json:"code"`
	// Fault says whose problem this is, so an interface can choose its words
	// without a table of every code. It is derived from Code, never chosen at
	// the call site.
	Fault Fault `json:"fault"`
	// RetryAfter, when > 0, is the number of seconds the client should wait
	// before retrying. It is written both as the Retry-After header and as a
	// body field, because the Worker in front of plue does not forward
	// upstream headers.
	RetryAfter int `json:"retry_after,omitempty"`
	// Message is the human sentence. On a bug-class failure it is replaced
	// with the status text before it leaves the process.
	Message   string `json:"message"`
	Limit     *int   `json:"limit,omitempty"`
	Remaining *int   `json:"remaining,omitempty"`
	// ResetAt is the absolute RFC3339 reset time for rate-limit errors that
	// expose their tracked budget window.
	PlanKey        string       `json:"plan_key,omitempty"`
	LimitKind      string       `json:"limit_kind,omitempty"`
	UpgradePlanKey string       `json:"upgrade_plan_key,omitempty"`
	ResetAt        *time.Time   `json:"reset_at,omitempty"`
	Errors         []FieldError `json:"errors,omitempty"`
	// Details carries a structured, code-specific payload for clients that
	// branch on Code. Nil for most error flavors.
	Details any `json:"details,omitempty"`
	// cause is the underlying error, kept for the server log only. It is
	// unexported so encoding/json never serializes it and the wire body
	// above is unchanged. Set it with WithCause; read it with Cause.
	cause error
}

// FieldError describes a validation error on a specific field.
type FieldError struct {
	Resource string `json:"resource"`
	Field    string `json:"field"`
	Code     string `json:"code"` // missing, missing_field, invalid, already_exists
}

func (e *APIError) Error() string {
	return e.Message
}

// WithCause attaches the underlying error for the server log and returns e,
// so a return site reads Internal("failed to x").WithCause(err). Message
// stays the human sentence and Error() is unchanged. A nil err is ignored.
//
// There is deliberately no Unwrap: adding one would change what errors.Is
// reports for every service that inspects another service's error.
func (e *APIError) WithCause(err error) *APIError {
	if err != nil {
		e.cause = err
	}
	return e
}

// Cause returns the error attached with WithCause, or nil.
func (e *APIError) Cause() error {
	return e.cause
}

func NotFound(msg string) *APIError { return New(CodeNotFound, msg) }

func BadRequest(msg string) *APIError { return New(CodeBadRequest, msg) }

func Unauthorized(msg string) *APIError { return New(CodeUnauthorized, msg) }

func Forbidden(msg string) *APIError { return New(CodeForbidden, msg) }

func Conflict(msg string) *APIError { return New(CodeConflict, msg) }

func UnsupportedMediaType(msg string) *APIError { return New(CodeUnsupportedMediaType, msg) }

func GatewayTimeout(msg string) *APIError { return New(CodeGatewayTimeout, msg) }

func RequestEntityTooLarge(msg string) *APIError { return New(CodeRequestEntityTooLarge, msg) }

func ValidationFailed(errs ...FieldError) *APIError {
	err := New(CodeValidationFailed, "validation failed")
	err.Errors = errs
	return err
}

// UnprocessableEntity returns an HTTP 422 error with the given message.
// Use this for semantic validation failures where the request is syntactically
// valid but cannot be processed (e.g. integrity check failures).
func UnprocessableEntity(msg string) *APIError { return New(CodeUnprocessableEntity, msg) }

func Internal(msg string) *APIError { return New(CodeInternal, msg) }

// DesktopNotReady reports the bounded NixOS activation window during which a
// desktop VM can accept exec requests before its desktop helpers are linked.

// DesktopNotRunning reports that a desktop box is suspended, failed, or has no
// VM. The observe/input routes never auto-resume: the consumer shows a Resume
// button instead of paying a minute of VM start inside a 30 s request.

// DesktopBusy reports same-pod contention on one box's desktop: the API holds
// a per-workspace lock so two agents cannot interleave pointer actions. It
// fails at once rather than queueing, because the caller's 30 s budget is
// better spent observing the state the other action produced.

// DesktopToolsUnavailable reports a box booted from an image older than the
// one that ships the desktop observe/input helpers. It is terminal for that
// box: no retry helps, the user has to open a new one. The fault is infra —
// the helpers are missing because plue has not re-registered the image, not
// because the caller asked for anything wrong.

// EnvironmentImageUnavailable reports that this deployment has no registered
// NixOS image for the workspace kind being booted. Like
// DesktopToolsUnavailable it is plue's rollout, not the caller's request.
func EnvironmentImageUnavailable(msg string) *APIError {
	return New(CodeEnvironmentImageUnavailable, msg)
}

// DesktopFrameChanged reports that the framebuffer geometry moved between the
// observation the plan was aimed at and the injection. Nothing was injected;
// details carry the current frame and a fresh observation.

// DesktopFocusTerminal reports a refused keystroke: the focused window is a
// terminal and the caller did not set allow_terminal. Typing into a shell that
// carries the repository's git credential is the one input the API will not
// perform by default.

// DesktopActRepeated reports a replayed act_id. The guest keeps the last 64
// under its lock, so the ledger is cross-pod safe without a schema.

// DesktopInputOutOfBounds reports a positioned action outside the live
// framebuffer. The guest re-checks geometry immediately before each action, so
// this can fire after earlier actions of the same plan already ran; details
// carry the index and how many completed.

// GuestNotReady reports the bounded boot window during which a VM guest is
// reachable but NixOS activation has not finished exposing its login shell.
func GuestNotReady(msg string) *APIError {
	return New(CodeGuestNotReady, msg)
}

// NoCapacity reports that the compute pool has no room for this workspace
// right now. It is a TRANSIENT refusal, not a failure: the controller declines
// the reservation before it touches the guest, so the workspace and its disk
// are untouched and still suspended. Callers must retry rather than replace
// anything.
//
// The message is user-facing. writeRouteError lists no_capacity in the closed
// set of 5xx codes whose messages are passed through uncensored (they are
// written for humans), and apps/app renders that string verbatim — so it must
// read as a sentence, never as the provider's "no healthy Microsandbox worker
// has sufficient capacity".
func NoCapacity(msg string) *APIError {
	return New(CodeNoCapacity, msg)
}

// A full pool's retry pacing lives in the registry row for no_capacity: a
// pool fills for as long as it takes another box to go idle, so a 2-3 second
// boot-window retry (desktop_not_ready, guest_not_ready) would only hammer
// the controller. 30s is one idle-sweep tick.

// QuotaExceeded signals that the caller has hit a per-resource cap (ticket
// 0105: 100 active sandboxes per user). Returns HTTP 429 with a
// machine-readable code = "quota_exceeded" so clients can branch on it
// without substring-matching the message.
func QuotaExceeded(msg string) *APIError {
	return New(CodeQuotaExceeded, msg)
}

// GitHubReconnectRequired signals that the user's GitHub credential is dead in a
// way NO automatic refresh can fix — the refresh token was revoked, consumed, or
// was never stored — so the only remedy is for the human to re-authorize the
// GitHub App. It is still HTTP 401 (clients that only branch on status keep
// working unchanged), but carries a machine-readable code so a client can render
// an honest "Reconnect GitHub" call to action instead of retrying a credential
// that will never succeed. Do NOT use it for an ordinary expired access token:
// that is refreshable server-side and must not surface a reconnect prompt.
func GitHubReconnectRequired(msg string) *APIError {
	return New(CodeGitHubReconnectRequired, msg)
}

// The Code constants that used to live here are in registry.go, beside the
// status, fault and retry pacing each one implies.

// normalized returns the copy of e that goes on the wire. It fills in the two
// fields a hand-built composite may have left empty, so `code` and `fault` are
// present on EVERY response while the code-less call sites are swept:
//
//   - an empty Code becomes the generic code for the status;
//   - an empty Fault is looked up from the Code, defaulting to bug.
//
// It never overwrites a value the caller set, and it never touches the
// caller's struct.
func (e *APIError) normalized() APIError {
	out := *e
	if out.Code == "" {
		out.Code = statusFallbackCode(out.Status)
	}
	if out.Fault == "" {
		entry, ok := Lookup(out.Code)
		if !ok {
			entry.Fault = FaultBug
		}
		out.Fault = entry.Fault
	}
	return out
}

// WriteError writes an APIError as JSON to the response, and sets the
// Retry-After header the APIError asked for.
//
// The header guard is the one internal/routes/auth.go's writeRouteError has
// always used, moved down here so the direct callers behave like the routed
// ones: set Retry-After only when nothing upstream already set it, and only
// when there is a number to write or the status is 429 (a 429 with no number
// still writes 0, which is what the routed path does today). Middleware and
// handlers that compute their own window set the header first and keep it.
func WriteError(w http.ResponseWriter, err *APIError) {
	if w.Header().Get("Retry-After") == "" &&
		(err.RetryAfter > 0 || err.Status == http.StatusTooManyRequests) {
		w.Header().Set("Retry-After", strconv.Itoa(err.RetryAfter))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(err.Status)
	body := err.normalized()
	_ = json.NewEncoder(w).Encode(&body)
}

// WriteJSON writes a value as JSON with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
