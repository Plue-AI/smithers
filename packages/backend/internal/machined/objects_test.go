package machined

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestHostObjectStreamCommitBeforeClose(t *testing.T) {
	r := new(Registry)
	input := bytes.Repeat([]byte("bundle"), 70000)
	entered, release := make(chan struct{}), make(chan struct{})
	var temporary string
	r.BindObjectImporter(func(ctx context.Context, branch string, file *os.File) error {
		if branch != "branch-a" {
			return ErrUnauthorized
		}
		temporary = file.Name()
		data, err := io.ReadAll(file)
		if err != nil {
			return err
		}
		if !bytes.Equal(data, input) {
			return errors.New("changed bundle bytes")
		}
		info, err := file.Stat()
		if err != nil {
			return err
		}
		if info.Mode().Perm() != 0600 {
			return errors.New("exposed bundle")
		}
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	a, err := r.MintBoot("branch-a", "machine")
	require.NoError(t, err)
	link, peer := connectTest(t, r, "branch-a", a)
	for offset := 0; offset < len(input); {
		n := min(65536, len(input)-offset)
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 9, Payload: append([]byte{1, 0}, input[offset:offset+n]...)}))
		window, err := wire.Read(peer)
		require.NoError(t, err)
		require.Equal(t, wire.Frame{Kind: wire.Objects, Stream: 9, Payload: append([]byte{6}, wire.U32(uint32(n))...)}, window)
		offset += n
	}
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 9, Payload: []byte{2, 0}}))
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("import not called")
	}
	// Bulk verification has not sent close. The reader still routes replies.
	link.mu.Lock()
	reply := make(chan wire.Frame, 1)
	link.pending[50] = reply
	link.mu.Unlock()
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(50)), wire.Field(2, wire.Union(16)))}))
	select {
	case <-reply:
	case <-time.After(time.Second):
		t.Fatal("object import blocked control reader")
	}
	close(release)
	closed, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, wire.Frame{Kind: wire.Objects, Stream: 9, Payload: []byte{7}}, closed)
	_, err = os.Stat(temporary)
	require.True(t, os.IsNotExist(err))
	// A stream id cannot be recycled into another bundle in the same boot link.
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 9, Payload: []byte{1, 0, 1}}))
	select {
	case <-link.done:
	case <-time.After(time.Second):
		t.Fatal("reused stream accepted")
	}
}

func TestHostObjectStreamRefusals(t *testing.T) {
	for _, name := range []string{"missing importer", "verification failed", "cancel import", "data after eof", "foreign stream", "over credit"} {
		t.Run(name, func(t *testing.T) {
			r := new(Registry)
			entered := make(chan struct{})
			if name != "missing importer" {
				r.BindObjectImporter(func(ctx context.Context, _ string, _ *os.File) error {
					close(entered)
					if name == "verification failed" {
						return errors.New("invalid bundle")
					}
					<-ctx.Done()
					return ctx.Err()
				})
			}
			a, err := r.MintBoot("a", "vm")
			require.NoError(t, err)
			link, peer := connectTest(t, r, "a", a)
			if name == "over credit" {
				// Account independently of worker scheduling.
				link.mu.Lock()
				link.objectPending = wire.InitialCredit
				link.mu.Unlock()
			}
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 1, Payload: []byte{1, 0, 42}}))
			if name == "missing importer" || name == "over credit" {
				select {
				case <-link.done:
				case <-time.After(time.Second):
					t.Fatal("invalid stream remained open")
				}
				return
			}
			window, err := wire.Read(peer)
			require.NoError(t, err)
			require.Equal(t, []byte{6, 0, 0, 0, 1}, window.Payload)
			if name == "foreign stream" {
				require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 2, Payload: []byte{1, 0, 1}}))
			} else {
				require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 1, Payload: []byte{2, 0}}))
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("no import")
				}
				if name == "data after eof" {
					require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 1, Payload: []byte{1, 0, 1}}))
				} else if name == "cancel import" {
					require.NoError(t, link.Close())
				}
			}
			select {
			case <-link.done:
			case <-time.After(time.Second):
				t.Fatal("refused bundle remained open")
			}
			_, err = wire.Read(peer)
			require.Error(t, err, "refusal must not certify imported objects")
		})
	}
}
