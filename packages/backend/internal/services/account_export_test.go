package services

import (
	"bufio"
	"bytes"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func pktLines(lines ...string) []byte {
	var b bytes.Buffer
	for _, line := range lines {
		if line == "" {
			b.WriteString("0000")
			continue
		}
		writePktLine(&b, line)
	}
	return b.Bytes()
}

func TestParseUploadPackAdvertisement(t *testing.T) {
	oid, tag := strings.Repeat("a", 40), strings.Repeat("b", 40)
	refs, err := parseUploadPackAdvertisement(pktLines(
		oid+" HEAD\x00multi_ack ofs-delta symref=HEAD:refs/heads/main\n",
		oid+" refs/heads/main\n",
		tag+" refs/tags/v1\n",
		oid+" refs/tags/v1^{}\n",
		"",
	))
	require.NoError(t, err)
	require.Equal(t, []advertisedRef{{oid, "HEAD"}, {oid, "refs/heads/main"}, {tag, "refs/tags/v1"}}, refs, "peeled tags are skipped")

	refs, err = parseUploadPackAdvertisement(pktLines(strings.Repeat("0", 40)+" capabilities^{}\x00ofs-delta\n", ""))
	require.NoError(t, err)
	require.Empty(t, refs, "an empty repository advertises no refs")

	for name, raw := range map[string][]byte{
		"bad length":   []byte("zzzz"),
		"short":        []byte("00"),
		"overrun":      []byte("00ffabc"),
		"no ref name":  pktLines(oid + "\n"),
		"short oid":    pktLines("abc refs/heads/main\n"),
		"length under": []byte("0002"),
	} {
		_, err := parseUploadPackAdvertisement(raw)
		require.Error(t, err, name)
	}
}

func TestSkipUploadPackAcks(t *testing.T) {
	r := bufio.NewReader(bytes.NewReader(append(pktLines("NAK\n"), []byte("PACKdata")...)))
	require.NoError(t, skipUploadPackAcks(r))
	rest, _ := r.Peek(4)
	require.Equal(t, "PACK", string(rest))

	err := skipUploadPackAcks(bufio.NewReader(bytes.NewReader(pktLines("ERR access denied\n"))))
	require.ErrorContains(t, err, "upload-pack: access denied")

	err = skipUploadPackAcks(bufio.NewReader(bytes.NewReader(pktLines("NAK\n"))))
	require.ErrorContains(t, err, "sent no pack")

	err = skipUploadPackAcks(bufio.NewReader(strings.NewReader("junk")))
	require.ErrorContains(t, err, "malformed")
}
