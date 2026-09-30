package errors

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// declaredCodeConstants parses this package's own source for `X Code = "y"`
// declarations. Parsing beats reflection here: a constant is erased at run
// time, so the only way to prove that every constant a human wrote has a
// registry row is to read what they wrote.
func declaredCodeConstants(t *testing.T) map[string]Code {
	t.Helper()
	fset := token.NewFileSet()
	// SA1019: ParseDir is enough here; the package has no build-tagged files.
	pkgs, err := parser.ParseDir(fset, ".", func(info os.FileInfo) bool { //nolint:staticcheck
		return !strings.HasSuffix(info.Name(), "_test.go")
	}, 0)
	require.NoError(t, err)

	found := map[string]Code{}
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			for _, decl := range file.Decls {
				gen, ok := decl.(*ast.GenDecl)
				if !ok || gen.Tok != token.CONST {
					continue
				}
				for _, spec := range gen.Specs {
					value, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					ident, ok := value.Type.(*ast.Ident)
					if !ok || ident.Name != "Code" {
						continue
					}
					for i, name := range value.Names {
						lit, ok := value.Values[i].(*ast.BasicLit)
						require.True(t, ok, "%s must be declared as a string literal", name.Name)
						found[name.Name] = Code(strings.Trim(lit.Value, `"`))
					}
				}
			}
		}
	}
	require.NotEmpty(t, found, "no Code constants parsed; did the package layout move?")
	return found
}

func TestEveryCodeConstantIsRegistered(t *testing.T) {
	declared := declaredCodeConstants(t)

	byCode := map[Code]string{}
	for name, code := range declared {
		if previous, clash := byCode[code]; clash {
			t.Errorf("%s and %s both declare %q; one code, one constant", previous, name, code)
		}
		byCode[code] = name
		if _, ok := registry[code]; !ok {
			t.Errorf("constant %s declares code %q with no registry row: a code with no "+
				"status and no fault cannot be answered", name, code)
		}
	}

	for code := range registry {
		if _, ok := byCode[code]; !ok {
			t.Errorf("registry row %q has no Code constant: it can be registered but never raised", code)
		}
	}
}

func TestRegistryEntriesAreComplete(t *testing.T) {
	// Codes are snake_case. One legacy SCREAMING_CASE spelling predates the
	// rule and is matched verbatim by clients, so renaming it is a breaking
	// change, not a cleanup.
	shape := regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	legacy := map[Code]bool{CodeGitHubForbiddenAction: true}

	for code, entry := range registry {
		if !legacy[code] {
			assert.Regexp(t, shape, string(code), "code %q is not snake_case", code)
		}
		assert.NotZero(t, entry.Status, "code %q has no HTTP status", code)
		assert.GreaterOrEqual(t, entry.Status, 400, "code %q is a failure and must be 4xx or 5xx", code)
		assert.Less(t, entry.Status, 600, "code %q has an impossible status", code)
		assert.Contains(t, Faults, entry.Fault, "code %q has no fault", code)
		assert.NotEmpty(t, entry.Doc, "code %q has no doc sentence; another repo renders it", code)
		assert.True(t, strings.HasSuffix(entry.Doc, "."), "code %q doc is not a sentence", code)
		assert.GreaterOrEqual(t, entry.RetryAfter, 0, "code %q has a negative retry", code)
	}
}

func TestFaultStatusAgreement(t *testing.T) {
	for code, entry := range registry {
		switch entry.Fault {
		case FaultUser:
			assert.Less(t, entry.Status, 500,
				"%q blames the caller but answers a server status", code)
		case FaultWait:
			// 429 joined 409/425/503 for one reason: a protocol whose own
			// admission queue answers 429 (the build cache — its sibling
			// implementations and their clients fix that status) still has to
			// be able to say "nobody did anything wrong, come back in a
			// second". RFC 9110 makes 429 + Retry-After exactly that
			// statement, and the positive-RetryAfter assertion below still
			// binds, so a wait code cannot use 429 to mean "slow down".
			assert.Contains(t, []int{http.StatusConflict, http.StatusTooEarly, http.StatusTooManyRequests, http.StatusServiceUnavailable},
				entry.Status, "%q means 'not ready yet' and must say so with 409, 425, 429 or 503", code)
			assert.Positive(t, entry.RetryAfter,
				"%q tells the caller to wait without saying how long", code)
		case FaultBug:
			assert.GreaterOrEqual(t, entry.Status, 500,
				"%q is a defect in plue and must answer a server status", code)
		case FaultInfra:
			// infra means "we, not you, have to change something before the
			// identical request can succeed". Usually that something is a
			// component that is down, draining or full, and the honest status
			// is a 5xx: plue failed while answering.
			//
			// One shape is not a 5xx. Sometimes nothing failed at all — the
			// request conflicts with durable state WE provisioned and the
			// caller cannot alter, such as a box booted from a base image that
			// predates a helper we have not finished rolling out. The box is
			// healthy, the request is well-formed, and 409 is the accurate
			// status because the box's state is the conflict. Answering 5xx
			// there would claim an outage that is not happening; answering
			// user would blame the caller for our rollout.
			//
			// So the exception is exactly 409, and exactly terminal: a 409
			// infra code may not pace a retry, because the identical request
			// does not start working on its own — something on our side ships
			// first. That keeps 409 from becoming a second spelling of wait,
			// and it leaves infra unable to borrow any status that blames the
			// caller (400, 403, 404, 422).
			if entry.Status == http.StatusConflict {
				assert.Zero(t, entry.RetryAfter,
					"%q is ours to fix and cannot come true on its own, so it must not promise a retry window", code)
				continue
			}
			assert.GreaterOrEqual(t, entry.Status, 500,
				"%q is plue's failure and must answer a server status, or 409 when our own durable state is the conflict", code)
		case FaultDependency:
			assert.True(t, entry.Status == http.StatusTooManyRequests || entry.Status >= 500,
				"%q blames an upstream and must answer 429 or 5xx, got %d", code, entry.Status)
		default:
			t.Errorf("%q carries unknown fault %q", code, entry.Fault)
		}
	}
}

func TestNoCapacityIsRetryableInfra(t *testing.T) {
	entry, ok := Lookup(CodeNoCapacity)
	require.True(t, ok)
	assert.Equal(t, http.StatusServiceUnavailable, entry.Status,
		"a full pool is the pool's problem, not the caller's request")
	assert.Equal(t, FaultInfra, entry.Fault)
	assert.Positive(t, entry.RetryAfter,
		"a full pool clears itself, so the client is told when to come back")
}

// TestOurRolloutIsNeverTheCallersFault pins the two codes that refuse a
// perfectly good request because plue has not finished shipping something.
//
// A box booted before the desktop helpers existed, and a deployment with no
// NixOS image registered for a kind, are both OUR lag. The caller sent a
// valid request against a healthy resource; the identical request starts
// working when we rebuild an image or register one, and never before. Both
// keep 409 — the conflict is state, not an outage, and clients (including the
// app's Resume/Retry gating) already branch on that status — and both carry
// the infra fault, so every consumer renders "not your fault" without having
// to special-case an English sentence.
func TestOurRolloutIsNeverTheCallersFault(t *testing.T) {
	for _, code := range []Code{CodeDesktopToolsUnavailable, CodeEnvironmentImageUnavailable, CodeCodingHostUnavailable} {
		entry, ok := Lookup(code)
		require.True(t, ok)
		assert.Equal(t, FaultInfra, entry.Fault,
			"%q refuses because plue has not rolled something out, which is not the caller's fault", code)
		assert.Equal(t, http.StatusConflict, entry.Status,
			"%q is a conflict with state plue provisioned, not an outage", code)
		assert.Zero(t, entry.RetryAfter,
			"%q is terminal until plue ships; it must not hand the caller a retry window", code)
	}
}

// TestUnconfiguredDeploymentIsNotAStaleBox pins the split that
// coding_host_unavailable used to hide.
//
// Two very different failures shared that one code. A box whose staged coding
// host is older than the one plue requires is a box problem: re-provisioning
// it, or opening another, fixes it, and every other box on the deployment
// works. An API pod with no SMITHERS_GATEWAY_HEALTH_PROBE_BASE_URL is a
// deployment problem: NO box can ever open a coding gateway there, for anyone,
// until an operator sets the variable. Answering both with "update its
// provisioned runtime" sent the second audience after a box that was fine.
func TestUnconfiguredDeploymentIsNotAStaleBox(t *testing.T) {
	entry, ok := Lookup(CodeCodingGatewayNotConfigured)
	require.True(t, ok)
	assert.Equal(t, FaultInfra, entry.Fault,
		"an unset environment variable on our own pod is never the caller's fault")
	assert.Equal(t, http.StatusServiceUnavailable, entry.Status,
		"nothing about the caller's state conflicts; the deployment simply cannot serve this")
	assert.Zero(t, entry.RetryAfter,
		"no wait helps until an operator configures the probe")
	assert.NotEqual(t, CodeCodingHostUnavailable, CodeCodingGatewayNotConfigured)
}

func TestParseCodeRoundTripsAndRejects(t *testing.T) {
	for _, code := range Codes() {
		parsed, ok := ParseCode(string(code))
		assert.True(t, ok, "registered code %q did not parse", code)
		assert.Equal(t, code, parsed)
	}

	parsed, ok := ParseCode("  no_capacity  ")
	assert.True(t, ok, "a code off the wire may carry whitespace")
	assert.Equal(t, CodeNoCapacity, parsed)

	for _, unknown := range []string{"", "pool_exhausted", "NO_CAPACITY", "no capacity"} {
		parsed, ok := ParseCode(unknown)
		assert.False(t, ok, "%q must not be accepted as a code", unknown)
		assert.Equal(t, CodeInternal, parsed,
			"a rejected code still has to leave the caller with a registered one")
		_, registered := Lookup(parsed)
		assert.True(t, registered)
	}
}

func TestNewTakesStatusAndFaultFromTheRegistry(t *testing.T) {
	err := New(CodeNoCapacity, "The workspace pool is full right now.")
	entry, _ := Lookup(CodeNoCapacity)
	assert.Equal(t, entry.Status, err.Status)
	assert.Equal(t, entry.Fault, err.Fault)
	assert.Equal(t, entry.RetryAfter, err.RetryAfter)
	assert.Equal(t, CodeNoCapacity, err.Code)

	// A code that reached New by conversion rather than by constant is a
	// defect, and it answers like one instead of writing a zero status.
	unregistered := New(Code("pool_exhausted"), "invented")
	assert.Equal(t, http.StatusInternalServerError, unregistered.Status)
	assert.Equal(t, FaultBug, unregistered.Fault)
}

func TestFailureCodesJSONIsFresh(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "..", "docs", "api", "failure-codes.json")
	onDisk, err := os.ReadFile(path)
	require.NoError(t, err, "docs/api/failure-codes.json is missing; run go run ./packages/backend/cmd/failurecodes > docs/api/failure-codes.json")

	rendered, err := MarshalDocument()
	require.NoError(t, err)

	assert.Equal(t, string(rendered), string(onDisk),
		"docs/failure-codes.json is stale. Other repositories generate their "+
			"failure vocabulary from this file, so regenerate it in the same "+
			"change that touched the registry:\n\n"+
			"    go run ./packages/backend/cmd/failurecodes > docs/api/failure-codes.json\n")
}

func TestExportIsSortedAndDigested(t *testing.T) {
	doc := Export()
	assert.Equal(t, DocumentSchemaVersion, doc.SchemaVersion)
	assert.Equal(t, Faults, doc.Faults)
	require.Len(t, doc.Codes, len(registry))
	for i := 1; i < len(doc.Codes); i++ {
		assert.Less(t, string(doc.Codes[i-1].Code), string(doc.Codes[i].Code), "codes must be sorted")
	}
	assert.True(t, strings.HasPrefix(doc.Digest, "sha256:"))
	assert.Equal(t, doc.Digest, Export().Digest, "the digest must be stable across calls")
}

func TestWriteErrorRetryAfterGuard(t *testing.T) {
	t.Run("a preset header is never clobbered", func(t *testing.T) {
		rec := httptest.NewRecorder()
		rec.Header().Set("Retry-After", "47")
		WriteError(rec, New(CodeDesktopNotReady, "still starting"))
		assert.Equal(t, "47", rec.Header().Get("Retry-After"),
			"middleware that computed its own window keeps it")
	})

	t.Run("a registered wait writes its own pacing", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteError(rec, New(CodeDesktopNotReady, "still starting"))
		assert.Equal(t, "2", rec.Header().Get("Retry-After"))

		var body APIError
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, 2, body.RetryAfter,
			"the header does not survive every hop in front of plue, so the body carries it too")
	})

	t.Run("a 429 with no pacing still writes the header", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteError(rec, New(CodeQuotaExceeded, "at the cap"))
		assert.Equal(t, "0", rec.Header().Get("Retry-After"),
			"this is what the routed path has always done for a 429")
	})

	t.Run("a failure with no pacing writes no header", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteError(rec, New(CodeNotFound, "gone"))
		assert.Empty(t, rec.Header().Get("Retry-After"))
	})

	t.Run("WriteError does not mutate the caller's error", func(t *testing.T) {
		err := &APIError{Status: http.StatusConflict, Message: "clash"}
		WriteError(httptest.NewRecorder(), err)
		assert.Empty(t, err.Code, "normalization happens on the wire copy only")
		assert.Empty(t, err.Fault)
	})
}

func TestWriteErrorAlwaysCarriesCodeAndFault(t *testing.T) {
	for _, err := range []*APIError{
		NotFound("missing"),
		BadRequest("bad"),
		Internal("boom"),
		ValidationFailed(FieldError{Resource: "workspace", Field: "bookmark", Code: "missing"}),
		// A hand-built composite from one of the call sites not yet swept.
		{Status: http.StatusServiceUnavailable, Message: "down"},
		// A code nothing registered: still total on the wire.
		{Status: http.StatusConflict, Code: Code("invented"), Message: "clash"},
	} {
		rec := httptest.NewRecorder()
		WriteError(rec, err)

		var body APIError
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.NotEmpty(t, body.Code, "every response names a code")
		assert.Contains(t, Faults, body.Fault, "every response names a fault")
	}
}

// TestErrorBodyPutsVerdictFirst pins the wire ORDER, not just the content.
//
// The Cloudflare Worker in front of plue classifies a refusal by reading only
// the start of the upstream body (apps/server/src/Http.ts,
// readRefusalDetail). A body whose `code` sits behind a long `message` arrives
// truncated and unparseable, and the Worker falls back to sniffing the status
// and the English text — exactly the guessing this registry exists to end.
//
// Go emits struct fields in declaration order, so this holds as long as Code,
// Fault and RetryAfter are declared before Message in APIError.
func TestErrorBodyPutsVerdictFirst(t *testing.T) {
	const workerReadCeiling = 240

	err := New(CodeNoCapacity, strings.Repeat("a very long human sentence. ", 40))
	err.Details = map[string]string{"padding": strings.Repeat("x", 4096)}
	err.Errors = []FieldError{{Resource: "workspace", Field: "bookmark", Code: "missing"}}

	rec := httptest.NewRecorder()
	WriteError(rec, err)
	body := rec.Body.String()
	require.Greater(t, len(body), workerReadCeiling, "the fixture must be long enough to truncate")

	head := body[:workerReadCeiling]
	assert.True(t, strings.HasPrefix(strings.TrimSpace(head), `{"code":"no_capacity"`),
		"code must be the first field on the wire, got %q", head)
	assert.Contains(t, head, `"fault":"infra"`)
	assert.Contains(t, head, `"retry_after":`)
	assert.NotContains(t, head, `"details"`)
}

func TestPlanLimitExceededRegistryAndEnvelope(t *testing.T) {
	e := New(CodePlanLimitExceeded, "plan limit")
	e.PlanKey = "free"
	e.LimitKind = "concurrent_sandboxes"
	e.UpgradePlanKey = "pro"
	limit, remaining := 1, 0
	e.Limit = &limit
	e.Remaining = &remaining
	rec := httptest.NewRecorder()
	WriteError(rec, e)
	assert.Equal(t, http.StatusPaymentRequired, rec.Code)
	assert.True(t, strings.HasPrefix(rec.Body.String(), `{"code":"plan_limit_exceeded","fault":"user","message":`))
	assert.Contains(t, rec.Body.String(), `"plan_key":"free"`)
	assert.Contains(t, rec.Body.String(), `"limit_kind":"concurrent_sandboxes"`)
	assert.Contains(t, rec.Body.String(), `"upgrade_plan_key":"pro"`)
	e = BadRequest("bad input")
	payload, err := json.Marshal(e)
	require.NoError(t, err)
	assert.NotContains(t, string(payload), "plan_key")
	assert.NotContains(t, string(payload), "limit_kind")
}
