package buildcache

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCanonicalJSON_SortsKeysAndRendersNumbersLikeJavaScript(t *testing.T) {
	t.Parallel()
	value, err := ParseJSON(`{"b":[1,2.50,1e21,0.000001,1e-7,100000000000000000000],"a":{"y":"<&>","x":true,"z":null}}`)
	require.NoError(t, err)
	canonical, err := CanonicalJSON(value)
	require.NoError(t, err)
	assert.Equal(t, `{"a":{"x":true,"y":"<&>","z":null},"b":[1,2.5,1e+21,0.000001,1e-7,100000000000000000000]}`, canonical)
}

func TestCanonicalJSON_RendersLineSeparatorsLikeJSONStringify(t *testing.T) {
	t.Parallel()
	value, err := ParseJSON("{\"actual\":\"a\\u2028b\\u2029c\",\"literal\":\"\\\\u2028/\\\\u2029\",\"mixed\":\"\\\\\\u2028\"}")
	require.NoError(t, err)
	canonical, err := CanonicalJSON(value)
	require.NoError(t, err)
	assert.Equal(t, "{\"actual\":\"a\u2028b\u2029c\",\"literal\":\"\\\\u2028/\\\\u2029\",\"mixed\":\"\\\\\u2028\"}", canonical)
}

func TestCanonicalJSON_RefusesNegativeZeroAndDepth(t *testing.T) {
	t.Parallel()
	value, err := ParseJSON(`{"n":-0}`)
	require.NoError(t, err)
	_, err = CanonicalJSON(value)
	require.Error(t, err)

	deep := strings.Repeat("[", MaxJSONDepth+2) + strings.Repeat("]", MaxJSONDepth+2)
	value, err = ParseJSON(deep)
	require.NoError(t, err)
	_, err = CanonicalJSON(value)
	assert.EqualError(t, err, "JSON is nested too deeply")
}

func TestParsePublication_BareAndEnvelope(t *testing.T) {
	t.Parallel()
	bare, err := ParsePublication("k1", `{"result":{"exitOk":true},"key":"k1"}`)
	require.NoError(t, err)
	assert.Equal(t, `{"key":"k1","result":{"exitOk":true}}`, bare.ResultCanonical)
	assert.Nil(t, bare.RecordedRunID)
	assert.Empty(t, bare.Digests)

	digest := strings.Repeat("a", 64)
	body := `{"keyDigest":"k1","result":{"z":1,"a":2},"createdAtMs":5,"recordedRunId":"run-1","recordedEventSeq":9,` +
		`"meta":{"boundary":{"declaredOutputs":{"outputs":[{"digest":"` + digest + `"},{"digest":null},{"digest":"` + digest + `","content":"x"},{"digest":"` + digest + `"}]}}}}`
	envelope, err := ParsePublication("k1", body)
	require.NoError(t, err)
	assert.Equal(t, body, envelope.Body)
	assert.Equal(t, `{"a":2,"z":1}`, envelope.ResultCanonical)
	require.NotNil(t, envelope.CreatedAtMs)
	assert.Equal(t, int64(5), *envelope.CreatedAtMs)
	assert.Equal(t, "run-1", *envelope.RecordedRunID)
	assert.Equal(t, int64(9), *envelope.RecordedEventSeq)
	assert.Equal(t, []string{digest}, envelope.Digests)
}

func TestParsePublication_Refusals(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"key mismatch":         `{"keyDigest":"other","result":1}`,
		"orphan provenance":    `{"keyDigest":"k1","result":1,"recordedRunId":"r"}`,
		"bad createdAtMs":      `{"keyDigest":"k1","result":1,"createdAtMs":-1}`,
		"bad digest":           `{"keyDigest":"k1","result":1,"meta":{"boundary":{"declaredOutputs":{"outputs":[{"digest":"nope"}]}}}}`,
		"invalid json":         `{`,
		"trailing garbage":     `{} x`,
		"trailing array close": `{"keyDigest":"k1","result":{"exitOk":true}}]`,
		"trailing map close":   `{"keyDigest":"k1","result":{"exitOk":true}}}`,
		"second value":         `{"keyDigest":"k1","result":1} {}`,
		"provenance not a str": `{"keyDigest":"k1","result":1,"recordedRunId":1,"recordedEventSeq":1}`,
	}
	for name, body := range cases {
		_, err := ParsePublication("k1", body)
		assert.Error(t, err, name)
	}
}

func TestValidateStoredBody_RefusesTrailingClosers(t *testing.T) {
	t.Parallel()
	valid := `{"keyDigest":"k1","result":{"exitOk":true}}`
	require.NoError(t, ValidateStoredBody("k1", valid))
	require.NoError(t, ValidateStoredBody("k1", valid+" \n\t"))
	for _, suffix := range []string{"]", "}", " x", " {}"} {
		assert.Error(t, ValidateStoredBody("k1", valid+suffix), suffix)
	}
}

func TestParseFence(t *testing.T) {
	t.Parallel()
	fence, err := ParseFence(nil, nil)
	require.NoError(t, err)
	assert.Nil(t, fence)
	fence, err = ParseFence([]string{"run"}, []string{"12"})
	require.NoError(t, err)
	assert.Equal(t, &Fence{RunID: "run", EventSeq: 12}, fence)
	_, err = ParseFence([]string{"run"}, nil)
	assert.Error(t, err)
	_, err = ParseFence([]string{"run"}, []string{"-1"})
	assert.Error(t, err)
	_, err = ParseFence([]string{"a", "b"}, []string{"1"})
	assert.Error(t, err)
}

func TestParseFindMissing(t *testing.T) {
	t.Parallel()
	d := strings.Repeat("b", 64)
	unique, err := ParseFindMissing(`{"digests":["` + d + `","` + d + `"]}`)
	require.NoError(t, err)
	assert.Equal(t, []string{d}, unique)
	_, err = ParseFindMissing(`{"digests":["short"]}`)
	assert.Error(t, err)
	_, err = ParseFindMissing(`{"digests":[],"extra":1}`)
	assert.Error(t, err)
	many := make([]string, 0, MaxFindMissingDigests+1)
	for i := 0; i <= MaxFindMissingDigests; i++ {
		many = append(many, `"`+d+`"`)
	}
	_, err = ParseFindMissing(`{"digests":[` + strings.Join(many, ",") + `]}`)
	assert.ErrorIs(t, err, ErrTooManyDigests)
}

func TestReadTokenShape(t *testing.T) {
	t.Parallel()
	assert.True(t, IsReadToken(ReadTokenPrefix+strings.Repeat("0", 40)))
	assert.False(t, IsReadToken("smithers_"+strings.Repeat("0", 40)))
	assert.False(t, IsReadToken(ReadTokenPrefix+strings.Repeat("0", 39)))
	assert.False(t, IsReadToken(ReadTokenPrefix+strings.Repeat("G", 40)))
}

func TestValidateKeyDigest(t *testing.T) {
	t.Parallel()
	assert.NoError(t, ValidateKeyDigest("planner/sha256:abc"))
	assert.Error(t, ValidateKeyDigest(""))
	assert.Error(t, ValidateKeyDigest("bad\x00key"))
	assert.Error(t, ValidateKeyDigest(strings.Repeat("k", MaxKeyDigestLength+1)))
}
