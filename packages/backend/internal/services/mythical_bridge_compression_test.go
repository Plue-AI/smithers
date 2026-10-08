package services

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

type compressedBridgeHost struct {
	*fakeMainPullHost
	upload []byte
}

func (h *compressedBridgeHost) ProxyUploadPack(_ context.Context, _, _ string, input io.Reader, output io.Writer) error {
	body, err := io.ReadAll(input)
	if err != nil {
		return err
	}
	h.upload = body
	_, err = io.WriteString(output, "0000")
	return err
}

func TestMythicalBridgeCompressedRequests(t *testing.T) {
	for _, operation := range []string{"git-upload-pack", "git-receive-pack"} {
		t.Run(operation, func(t *testing.T) {
			host := &compressedBridgeHost{fakeMainPullHost: &fakeMainPullHost{bookmarks: map[string]string{"main": pullOld}}}
			bridge, err := startMythicalBridge(t.Context(), host, "owner", "repo", nil)
			require.NoError(t, err)
			defer bridge.Close()
			bridge.permit([]mythicalRefUpdate{{Ref: "refs/heads/main", Old: pullOld, New: pullNew}}, repohost.ReceivePackMetadata{})
			send := func(body []byte) int {
				req, err := http.NewRequestWithContext(t.Context(), "POST", bridge.URL()+"/"+operation, bytes.NewReader(body))
				require.NoError(t, err)
				req.Header.Set("Content-Encoding", "gzip")
				res, err := http.DefaultClient.Do(req)
				require.NoError(t, err)
				defer res.Body.Close()
				_, err = io.Copy(io.Discard, res.Body)
				require.NoError(t, err)
				return res.StatusCode
			}
			require.Equal(t, 400, send([]byte("not gzip")))
			require.Empty(t, host.upload)
			require.Empty(t, host.received)
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			_, err = writer.Write([]byte("0000"))
			require.NoError(t, err)
			require.NoError(t, writer.Close())
			require.Equal(t, 200, send(compressed.Bytes()))
			if operation == "git-upload-pack" {
				require.Equal(t, "0000", string(host.upload))
			}
			require.Empty(t, host.received, "a compressed probe never consumes the prepared write")
			status, _, err := postReceivePack(t.Context(), bridge.URL(), "", []repohost.ReceivePackCommand{{OldOID: pullOld, NewOID: pullNew, RefName: "refs/heads/main"}})
			require.NoError(t, err)
			require.Equal(t, 200, status)
			require.Equal(t, pullNew, host.bookmarks["main"])
			// The decoder must not grant a second write or weaken the exact ref fence.
			status, _, err = postReceivePack(t.Context(), bridge.URL(), "", []repohost.ReceivePackCommand{{OldOID: pullOld, NewOID: pullNew, RefName: "refs/heads/main"}})
			require.NoError(t, err)
			require.Equal(t, 403, status)
		})
	}
}
