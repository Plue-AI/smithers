// Package buildcache holds the pure half of the smithers build cache
// protocol: the bounds every deployment enforces, the canonical JSON
// rendering that decides whether two publications are the same result, and
// the validation of one action-cache publication. Nothing here touches HTTP,
// Postgres, or the blob store, so the routes and the service can share it and
// tests can pin the protocol without either.
//
// The protocol is the one the smithers-build CLI and the Smithers engine
// speak against build.smithers.sh and the self-hosted Postgres service:
//
//	GET    /ac/{keyDigest}   -> 200 stored entry JSON | 404
//	PUT    /ac/{keyDigest}   -> 201 inserted | 200 already identical | 409 different
//	DELETE /ac/{keyDigest}   -> 200 deleted | 404, fenced by ?recordedRunId&recordedEventSeq
//	GET    /cas/{digest}     -> 200 octet-stream | 404
//	PUT    /cas/{digest}     -> 201 stored | 200 already present or repaired
//	HEAD   /cas/{digest}     -> 200 | 404
//	POST   /cas/findMissing  -> 200 {"missing":[...]}
//	GET    /healthz          -> 200
package buildcache

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	// MaxActionCacheBodyBytes bounds one PUT /ac body and one stored entry.
	MaxActionCacheBodyBytes = 1024 * 1024
	// MaxFindMissingBodyBytes bounds one POST /cas/findMissing body.
	MaxFindMissingBodyBytes = 256 * 1024
	// MaxFindMissingDigests bounds the digests one findMissing may probe.
	MaxFindMissingDigests = 1000
	// MaxKeyDigestLength bounds an action-cache key in UTF-8 bytes.
	MaxKeyDigestLength = 512
	// MaxReferencedDigests bounds the artifacts one publication references.
	MaxReferencedDigests = 1000
	// MaxArtifactBodyBytes is the absolute per-artifact ceiling a deployment
	// may configure; DefaultArtifactBodyBytes is what it gets by default.
	MaxArtifactBodyBytes     = 16 * 1024 * 1024
	DefaultArtifactBodyBytes = 16 * 1024 * 1024
	// Structural bounds applied to every JSON publication before storage.
	MaxJSONDepth          = 64
	MaxJSONMembers        = 100_000
	MaxCanonicalJSONBytes = 2 * 1024 * 1024
	// Admission caps. One process bounds all cache work and the large buffers
	// artifact transfers hold.
	MaxConcurrentCacheRequests                 = 64
	MaxConcurrentActionCachePublications       = 4
	MaxConcurrentFindMissingRequests           = 8
	MaxConcurrentArtifactTransfers             = 2
	maxSafeInteger                       int64 = 1<<53 - 1
)

// ReadTokenPrefix is the prefix of a public read token. Everything after it is
// 40 lowercase hex characters. The shape is deliberately distinct from every
// other Smithers token so the general token loader never accepts one.
const ReadTokenPrefix = "smithers_cachero_"

var (
	hexDigest       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	readTokenTail   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	namespacePrefix = regexp.MustCompile(`^[A-Za-z0-9_-]+/$`)
)

// ValidNamespacePrefix restricts a read credential to one action-cache namespace.
// The trailing slash prevents pr-1 from matching pr-10.
func ValidNamespacePrefix(prefix string) bool {
	return prefix == "" || (len(prefix) <= MaxKeyDigestLength && namespacePrefix.MatchString(prefix))
}

// IsHexDigest reports whether value is a lowercase SHA-256 hex digest.
func IsHexDigest(value string) bool { return hexDigest.MatchString(value) }

// IsReadToken reports whether value has the public read token shape.
func IsReadToken(value string) bool {
	return strings.HasPrefix(value, ReadTokenPrefix) && readTokenTail.MatchString(strings.TrimPrefix(value, ReadTokenPrefix))
}

// SHA256Hex returns the lowercase hex SHA-256 of data.
func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// TokenHash is the stored form of a bearer token.
func TokenHash(token string) string { return SHA256Hex([]byte(token)) }

func hasControlCharacters(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// ValidateKeyDigest refuses an action-cache key that cannot be stored or
// cannot have come from a client. A step key and a planner content key are
// both arbitrary bounded text, so the shape is deliberately wide.
func ValidateKeyDigest(keyDigest string) error {
	switch {
	case keyDigest == "":
		return errors.New("empty keyDigest")
	case !utf8.ValidString(keyDigest):
		return errors.New("keyDigest must be well-formed Unicode text")
	case len(keyDigest) > MaxKeyDigestLength:
		return fmt.Errorf("keyDigest must be at most %d UTF-8 bytes", MaxKeyDigestLength)
	case hasControlCharacters(keyDigest):
		return errors.New("keyDigest must not contain control characters")
	}
	return nil
}

// ParseJSON decodes text into the inert value tree CanonicalJSON accepts.
// Numbers stay json.Number so integer checks and JS-style rendering can see
// the literal.
func ParseJSON(text string) (any, error) {
	if !utf8.ValidString(text) {
		return nil, errors.New("body must be UTF-8 JSON")
	}
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("body must be valid JSON")
	}
	if decoder.More() {
		return nil, errors.New("body must be valid JSON")
	}
	// A trailing non-whitespace token that is not a second value.
	if _, err := decoder.Token(); err == nil {
		return nil, errors.New("body must be valid JSON")
	}
	return value, nil
}

type canonicalWriter struct {
	buffer  bytes.Buffer
	members int
}

func (w *canonicalWriter) append(fragment string) error {
	if w.buffer.Len()+len(fragment) > MaxCanonicalJSONBytes {
		return errors.New("canonical JSON exceeds its byte bound")
	}
	w.buffer.WriteString(fragment)
	return nil
}

// jsNumber renders a JSON number the way ECMAScript's Number#toString does,
// which is the rendering the other cache services produce, so a document
// canonicalized here compares equal to one canonicalized there.
func jsNumber(number json.Number) (string, error) {
	f, err := strconv.ParseFloat(string(number), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return "", errors.New("JSON number is outside the supported range")
	}
	if f == 0 && math.Signbit(f) {
		return "", errors.New("JSON number is outside the supported range")
	}
	if f == 0 {
		return "0", nil
	}
	abs := math.Abs(f)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64), nil
	}
	text := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, exponent, _ := strings.Cut(text, "e")
	sign := exponent[:1]
	digits := strings.TrimLeft(exponent[1:], "0")
	if digits == "" {
		digits = "0"
	}
	return mantissa + "e" + sign + digits, nil
}

func (w *canonicalWriter) render(value any, depth int) error {
	if depth > MaxJSONDepth {
		return errors.New("JSON is nested too deeply")
	}
	switch current := value.(type) {
	case nil:
		return w.append("null")
	case string:
		return w.append(jsonString(current))
	case bool:
		if current {
			return w.append("true")
		}
		return w.append("false")
	case json.Number:
		rendered, err := jsNumber(current)
		if err != nil {
			return err
		}
		return w.append(rendered)
	case float64:
		rendered, err := jsNumber(json.Number(strconv.FormatFloat(current, 'g', -1, 64)))
		if err != nil {
			return err
		}
		return w.append(rendered)
	case []any:
		if len(current) > MaxJSONMembers-w.members {
			return errors.New("JSON has too many members")
		}
		w.members += len(current)
		if err := w.append("["); err != nil {
			return err
		}
		for index, item := range current {
			if index > 0 {
				if err := w.append(","); err != nil {
					return err
				}
			}
			if err := w.render(item, depth+1); err != nil {
				return err
			}
		}
		return w.append("]")
	case map[string]any:
		if len(current) > MaxJSONMembers-w.members {
			return errors.New("JSON has too many members")
		}
		w.members += len(current)
		keys := make([]string, 0, len(current))
		for key := range current {
			keys = append(keys, key)
		}
		// UTF-16 code unit order, which is how the other services sort keys.
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		if err := w.append("{"); err != nil {
			return err
		}
		for index, key := range keys {
			if index > 0 {
				if err := w.append(","); err != nil {
					return err
				}
			}
			if err := w.append(jsonString(key) + ":"); err != nil {
				return err
			}
			if err := w.render(current[key], depth+1); err != nil {
				return err
			}
		}
		return w.append("}")
	default:
		return errors.New("unsupported JSON value")
	}
}

// jsonString renders a string the way JSON.stringify does: no HTML escaping,
// so a canonical rendering here equals one from the other cache services.
func jsonString(value string) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return unescapeJSONLineSeparators(strings.TrimSuffix(buffer.String(), "\n"))
}

// encoding/json always escapes U+2028 and U+2029, including when HTML
// escaping is disabled. JSON.stringify leaves both characters literal. Walk
// complete backslash runs so a literal `\u2028` string stays escaped while an
// actual line separator after any literal backslashes is restored.
func unescapeJSONLineSeparators(value string) string {
	var output strings.Builder
	output.Grow(len(value))
	for index := 0; index < len(value); {
		if value[index] != '\\' {
			output.WriteByte(value[index])
			index++
			continue
		}
		runEnd := index
		for runEnd < len(value) && value[runEnd] == '\\' {
			runEnd++
		}
		runLength := runEnd - index
		if runLength%2 == 1 && runEnd+5 <= len(value) && value[runEnd] == 'u' &&
			(value[runEnd+1:runEnd+5] == "2028" || value[runEnd+1:runEnd+5] == "2029") {
			output.WriteString(value[index : runEnd-1])
			if value[runEnd+4] == '8' {
				output.WriteString("\u2028")
			} else {
				output.WriteString("\u2029")
			}
			index = runEnd + 5
			continue
		}
		output.WriteString(value[index:runEnd])
		index = runEnd
	}
	return output.String()
}

func lessUTF16(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		ua, ub := utf16Units(ra[i]), utf16Units(rb[i])
		for j := 0; j < len(ua) && j < len(ub); j++ {
			if ua[j] != ub[j] {
				return ua[j] < ub[j]
			}
		}
		if len(ua) != len(ub) {
			return len(ua) < len(ub)
		}
	}
	return len(ra) < len(rb)
}

func utf16Units(r rune) []uint16 {
	if r < 0x10000 {
		return []uint16{uint16(r)}
	}
	r -= 0x10000
	return []uint16{uint16(0xd800 + (r >> 10)), uint16(0xdc00 + (r & 0x3ff))}
}

// CanonicalJSON renders an inert JSON value with deterministic member order
// and hard bounds. It is the conflict discriminator: two publications are the
// same result when their canonical renderings match byte for byte.
func CanonicalJSON(value any) (string, error) {
	w := &canonicalWriter{}
	if err := w.render(value, 0); err != nil {
		return "", err
	}
	return w.buffer.String(), nil
}

// Publication is one validated action-cache publication in either shape a
// real client sends: the CacheEntry envelope with keyDigest, result, meta,
// and journal provenance, or the bare CachedResult document.
type Publication struct {
	// Body is the client's own bytes, stored and returned verbatim.
	Body string
	// ResultCanonical is the conflict discriminator.
	ResultCanonical  string
	CreatedAtMs      *int64
	RecordedRunID    *string
	RecordedEventSeq *int64
	// Digests are the artifacts the envelope's declared outputs reference.
	Digests []string
}

func safeInteger(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	n, err := number.Int64()
	if err != nil || n < 0 || n > maxSafeInteger {
		return 0, false
	}
	return n, true
}

func referencedDigests(record map[string]any) ([]string, error) {
	meta, _ := record["meta"].(map[string]any)
	boundary, _ := meta["boundary"].(map[string]any)
	declared, _ := boundary["declaredOutputs"].(map[string]any)
	outputs, present := declared["outputs"]
	if !present {
		return nil, nil
	}
	list, ok := outputs.([]any)
	if !ok {
		return nil, errors.New("declared outputs must be an array")
	}
	seen := map[string]struct{}{}
	digests := []string{}
	for _, output := range list {
		object, ok := output.(map[string]any)
		if !ok {
			return nil, errors.New("declared output must be an object")
		}
		digest, present := object["digest"]
		if !present || digest == nil {
			continue
		}
		if _, hasContent := object["content"]; hasContent {
			continue
		}
		text, ok := digest.(string)
		if !ok || !IsHexDigest(text) {
			return nil, errors.New("declared output digest is invalid")
		}
		if _, dup := seen[text]; dup {
			continue
		}
		seen[text] = struct{}{}
		digests = append(digests, text)
		if len(digests) > MaxReferencedDigests {
			return nil, errors.New("publication references too many artifacts")
		}
	}
	return digests, nil
}

// ParsePublication validates one PUT /ac body against the key in the path.
// Every refusal is a 400 in protocol terms; the error text is the body.
func ParsePublication(keyDigest, text string) (Publication, error) {
	value, err := ParseJSON(text)
	if err != nil {
		return Publication{}, err
	}
	record, isRecord := value.(map[string]any)
	if isRecord {
		if supplied, present := record["keyDigest"]; present && supplied != keyDigest {
			return Publication{}, errors.New("keyDigest must match the request path when supplied")
		}
	}
	// A bare CachedResult may itself have a member named `result`. Require
	// the path-matching cache key as well before reading envelope metadata.
	enveloped := false
	if isRecord {
		_, hasKey := record["keyDigest"]
		_, hasResult := record["result"]
		enveloped = hasKey && hasResult
	}
	if _, err := CanonicalJSON(value); err != nil {
		return Publication{}, errors.New("body contains invalid or unsupported cache metadata")
	}
	resultValue := value
	if enveloped {
		resultValue = record["result"]
	}
	resultCanonical, err := CanonicalJSON(resultValue)
	if err != nil {
		return Publication{}, errors.New("body contains invalid or unsupported cache metadata")
	}
	publication := Publication{Body: text, ResultCanonical: resultCanonical, Digests: []string{}}
	if !enveloped {
		return publication, nil
	}
	digests, err := referencedDigests(record)
	if err != nil {
		return Publication{}, errors.New("body contains invalid or unsupported cache metadata")
	}
	if digests != nil {
		publication.Digests = digests
	}
	if raw, present := record["createdAtMs"]; present {
		n, ok := safeInteger(raw)
		if !ok {
			return Publication{}, errors.New("createdAtMs must be a non-negative safe integer")
		}
		publication.CreatedAtMs = &n
	}
	rawRunID, hasRunID := record["recordedRunId"]
	rawEventSeq, hasEventSeq := record["recordedEventSeq"]
	if hasRunID != hasEventSeq {
		return Publication{}, errors.New("recordedRunId and recordedEventSeq must be supplied together")
	}
	if hasRunID {
		runID, ok := rawRunID.(string)
		seq, seqOK := safeInteger(rawEventSeq)
		if !ok || runID == "" || !utf8.ValidString(runID) || len(runID) > MaxKeyDigestLength || hasControlCharacters(runID) || !seqOK {
			return Publication{}, errors.New("publication provenance is invalid")
		}
		publication.RecordedRunID = &runID
		publication.RecordedEventSeq = &seq
	}
	return publication, nil
}

// Fence is the optional provenance a DELETE /ac must match.
type Fence struct {
	RunID    string
	EventSeq int64
}

// ParseFence validates the deletion fence query parameters. Both absent is an
// unfenced delete; a malformed fence is refused rather than widened.
func ParseFence(runIDs, eventSeqs []string) (*Fence, error) {
	if len(runIDs) > 1 || len(eventSeqs) > 1 {
		return nil, errors.New("deletion fence parameters must not be repeated")
	}
	if len(runIDs) != len(eventSeqs) {
		return nil, errors.New("recordedRunId and recordedEventSeq must be supplied together")
	}
	if len(runIDs) == 0 {
		return nil, nil
	}
	runID, eventSeq := runIDs[0], eventSeqs[0]
	if runID == "" || !utf8.ValidString(runID) || len(runID) > MaxKeyDigestLength || hasControlCharacters(runID) {
		return nil, errors.New("recordedRunId must be a non-empty bounded string")
	}
	for _, ch := range eventSeq {
		if ch < '0' || ch > '9' {
			return nil, errors.New("recordedEventSeq must be a non-negative safe integer")
		}
	}
	seq, err := strconv.ParseInt(eventSeq, 10, 64)
	if eventSeq == "" || err != nil || seq > maxSafeInteger {
		return nil, errors.New("recordedEventSeq must be a non-negative safe integer")
	}
	return &Fence{RunID: runID, EventSeq: seq}, nil
}

// ParseFindMissing validates a POST /cas/findMissing body and returns the
// unique digests in first-occurrence order.
func ParseFindMissing(text string) ([]string, error) {
	value, err := ParseJSON(text)
	if err != nil {
		return nil, err
	}
	record, ok := value.(map[string]any)
	if !ok || len(record) != 1 {
		return nil, errors.New(`body must be exactly {"digests":[...]}`)
	}
	raw, present := record["digests"]
	if !present {
		return nil, errors.New(`body must be exactly {"digests":[...]}`)
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, errors.New(`body must be {"digests":[...]}`)
	}
	if len(list) > MaxFindMissingDigests {
		return nil, ErrTooManyDigests
	}
	seen := map[string]struct{}{}
	unique := []string{}
	for _, item := range list {
		digest, ok := item.(string)
		if !ok || !IsHexDigest(digest) {
			return nil, errors.New("every digest must be 64 lowercase hex characters")
		}
		if _, dup := seen[digest]; dup {
			continue
		}
		seen[digest] = struct{}{}
		unique = append(unique, digest)
	}
	return unique, nil
}

// ErrTooManyDigests is the one findMissing refusal that answers 413.
var ErrTooManyDigests = fmt.Errorf("at most %d digests may be probed at once", MaxFindMissingDigests)

// ValidateStoredBody re-checks an entry read back from storage before it is
// served, so a corrupted row is a failure rather than a poisoned hit.
func ValidateStoredBody(keyDigest, body string) error {
	if len(body) > MaxActionCacheBodyBytes {
		return errors.New("action cache returned an invalid stored body")
	}
	value, err := ParseJSON(body)
	if err != nil {
		return errors.New("action cache returned invalid stored JSON")
	}
	if _, err := CanonicalJSON(value); err != nil {
		return errors.New("action cache returned invalid stored JSON")
	}
	if record, ok := value.(map[string]any); ok {
		if supplied, present := record["keyDigest"]; present && supplied != keyDigest {
			return errors.New("action cache returned a row for a different key")
		}
	}
	return nil
}
