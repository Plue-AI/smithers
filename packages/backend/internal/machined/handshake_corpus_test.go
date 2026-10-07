package machined

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

const corpus = "../compose/testdata/cocontracts/"

type corpusStep struct{ Conn, Frame string }

type handshakeCorpus struct {
	Protocol uint16
	Frames   []struct{ Name, Direction string }
	Vectors  map[string]struct {
		Secret string
		BootID string `json:"boot_id"`
	} `json:"handshake_vectors"`
	Sequences        map[string][]corpusStep
	RefusalSequences map[string]struct {
		By, Expected string
		Steps        []corpusStep
	} `json:"refusal_sequences"`
}

func loadHandshakeCorpus(t *testing.T) handshakeCorpus {
	t.Helper()
	raw, err := os.ReadFile(corpus + "MANIFEST.json")
	require.NoError(t, err)
	var m handshakeCorpus
	require.NoError(t, json.Unmarshal(raw, &m))
	require.Equal(t, uint16(wire.Protocol), m.Protocol, "MANIFEST protocol")
	return m
}

func corpusFrame(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(corpus + name + ".bin")
	require.NoError(t, err)
	return b
}

// connectCorpus drives the production host handshake (Registry.Connect) with
// the committed daemon frames and compares every host frame byte for byte,
// so the Go proof is the committed HMAC vector, not a value Go computed.
func connectCorpus(t *testing.T, m handshakeCorpus, steps []corpusStep, refusal string) error {
	t.Helper()
	v := m.Vectors["a"]
	secret, err := hex.DecodeString(v.Secret)
	require.NoError(t, err)
	boot, err := hex.DecodeString(v.BootID)
	require.NoError(t, err)
	var id [16]byte
	copy(id[:], boot)
	r := new(Registry)
	require.NoError(t, r.BindBoot("a", "vm", id, []byte("boot-token")))
	r.mu.Lock()
	copy(r.boots[id].secret[:], secret)
	r.mu.Unlock()
	host, daemon := net.Pipe()
	defer daemon.Close()
	require.NoError(t, daemon.SetDeadline(time.Now().Add(5*time.Second)))
	done := make(chan error, 1)
	go func() {
		link, err := r.Connect(t.Context(), "a", host)
		if link != nil {
			_ = link.Close()
		}
		done <- err
	}()
	direction := map[string]string{}
	for _, f := range m.Frames {
		direction[f.Name] = f.Direction
	}
	for _, s := range steps {
		want := corpusFrame(t, s.Frame)
		if direction[s.Frame] == "daemon-to-host" {
			_, err := daemon.Write(want)
			require.NoError(t, err, s.Frame)
			continue
		}
		got := make([]byte, len(want))
		_, err := io.ReadFull(daemon, got)
		require.NoError(t, err, s.Frame)
		require.True(t, bytes.Equal(want, got), "%s: host wrote %x", s.Frame, got)
	}
	if refusal != "" {
		// The detecting side says why before it closes (ADR 0004 errors 13-16).
		want := corpusFrame(t, "goodbye_"+refusal)
		got := make([]byte, len(want))
		_, err := io.ReadFull(daemon, got)
		require.NoError(t, err, "goodbye_"+refusal)
		require.True(t, bytes.Equal(want, got), "host goodbye %x", got)
	}
	return <-done
}

func TestHostHandshakeMatchesCorpus(t *testing.T) {
	m := loadHandshakeCorpus(t)
	require.NoError(t, connectCorpus(t, m, m.Sequences["seq_handshake"], ""))
}

func TestHostHandshakeRefusalsMatchCorpus(t *testing.T) {
	m := loadHandshakeCorpus(t)
	ran := 0
	for name, seq := range m.RefusalSequences {
		if seq.By != "host" {
			continue
		}
		ran++
		t.Run(name, func(t *testing.T) {
			err := connectCorpus(t, m, seq.Steps, seq.Expected)
			require.Error(t, err)
			require.Equal(t, seq.Expected, err.Error())
		})
	}
	require.NotZero(t, ran, "no host-detected refusal sequences")
}
