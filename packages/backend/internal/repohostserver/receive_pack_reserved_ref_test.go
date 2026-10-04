package repohostserver

import (
	"bytes"
	"crypto/sha1"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const reservedWorkspaceRef = "refs/smithers/branches/11111111-1111-1111-1111-111111111111/head"

// reservedPushCommand returns one receive-pack command line creating ref at
// oid, padded until its pkt-line length contains a hex letter.
func reservedPushCommand(oid, ref string) string {
	for {
		line := fmt.Sprintf("%s %s %s\x00report-status\n", laneZeroOID, oid, ref)
		if strings.ContainsAny(fmt.Sprintf("%04x", len(line)+4), "abcdef") {
			return line
		}
		ref += "x"
	}
}

func postReceivePack(t *testing.T, f *laneHTTPFixture, body []byte, headers ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/git/receive-pack", bytes.NewReader(body))
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-receive-pack-request")
	req.Header.Set("Accept", "application/x-git-receive-pack-result")
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	return rec
}

func assertNoReservedRefs(t *testing.T, f *laneHTTPFixture) {
	t.Helper()
	for ref := range f.repo.refs() {
		assert.False(t, strings.HasPrefix(ref, "refs/smithers/"), "reserved ref written: %s", ref)
	}
	assert.Empty(t, f.importedRefs(), "jj must import nothing from a refused push")
}

// An upper-case pkt-line length is valid to git, so the reserved-ref guard
// must see the command instead of forwarding it unchecked.
func TestReceivePackRefusesUppercaseLengthReservedRef(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	line := reservedPushCommand(f.base, "refs/smithers/branches/11111111-1111-1111-1111-111111111111/headx")
	body := []byte(fmt.Sprintf("%04X%s0000", len(line)+4, line))
	body = append(body, emptyPack()...)

	rec := postReceivePack(t, f, body)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assertNoReservedRefs(t, f)
}

// A command section larger than the peek cap cannot be inspected, so it is
// refused rather than handed to git, which has no command-count limit.
func TestReceivePackRefusesOversizedCommandSection(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	var body bytes.Buffer
	filler := strings.Repeat("f", 60000)
	for i := 0; body.Len() <= 16*1024*1024; i++ {
		line := fmt.Sprintf("%s %s refs/heads/fill-%d-%s\n", laneZeroOID, f.base, i, filler)
		fmt.Fprintf(&body, "%04x%s", len(line)+4, line)
	}
	line := fmt.Sprintf("%s %s %s\n", laneZeroOID, f.base, reservedWorkspaceRef)
	fmt.Fprintf(&body, "%04x%s0000", len(line)+4, line)
	body.Write(emptyPack())

	rec := postReceivePack(t, f, body.Bytes())
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	assertNoReservedRefs(t, f)
	for ref := range f.repo.refs() {
		assert.False(t, strings.HasPrefix(ref, "refs/heads/fill-"), "filler ref written: %s", ref)
	}
}

// refs/smithers/users/<id>/ is writable only with the pusher id the API
// attributes; with none, or another user's, repo-host refuses it (#1964).
func TestReceivePackUserRefsFollowThePusherID(t *testing.T) {
	ref := "refs/smithers/users/42/head"
	body := func(f *laneHTTPFixture) []byte {
		line := reservedPushCommand(f.base, ref)
		return append([]byte(fmt.Sprintf("%04x%s0000", len(line)+4, line)), emptyPack()...)
	}
	for _, pusher := range []string{"", "43", "0"} {
		f := newLaneHTTPFixture(t, nil)
		rec := postReceivePack(t, f, body(f), "X-Smithers-Pusher-Id", pusher)
		require.Equal(t, http.StatusForbidden, rec.Code, "pusher %q: %s", pusher, rec.Body.String())
		assertNoReservedRefs(t, f)
	}
	f := newLaneHTTPFixture(t, nil)
	line := reservedPushCommand(f.base, ref)
	rec := postReceivePack(t, f, append([]byte(fmt.Sprintf("%04x%s0000", len(line)+4, line)), emptyPack()...), "X-Smithers-Pusher-Id", "42")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	written := false
	for name := range f.repo.refs() {
		written = written || strings.HasPrefix(name, "refs/smithers/users/42/head")
	}
	assert.True(t, written, "the owner's ref must be written")
}

// emptyPack is a valid version-2 pack holding zero objects.
func emptyPack() []byte {
	header := []byte{'P', 'A', 'C', 'K', 0, 0, 0, 2, 0, 0, 0, 0}
	sum := sha1.Sum(header)
	return append(header, sum[:]...)
}
