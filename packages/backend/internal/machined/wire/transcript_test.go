package wire

import (
	"bytes"
	"os"
	"testing"
)

func TestTranscriptLiteralAndRefusals(t *testing.T) {
	b, err := os.ReadFile("../../compose/testdata/cocontracts/ev_transcript.bin")
	if err != nil {
		t.Fatal(err)
	}
	f, err := Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	d, err := DecodeDurableEvent(f)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeTranscript(d.Payload)
	if err != nil {
		t.Fatal(err)
	}
	want := Transcript{Version: 1, Session: 1, Profile: "claude-code/2.1.0", Generation: 1, End: 16, Record: `{"type":"user"}`}
	for i := 0; i < 16; i++ {
		want.Participant[i] = 0x44
		want.Source[i] = 0x33
	}
	if got != want {
		t.Fatalf("%+v", got)
	}
	p, err := EncodeTranscript(want)
	if err != nil || !bytes.Equal(p, d.Payload) {
		t.Fatalf("roundtrip: %v", err)
	}
	for _, change := range []func(*Transcript){func(t *Transcript) { t.Version = 2 }, func(t *Transcript) { t.Session = 0 }, func(t *Transcript) { t.Participant = [16]byte{} }, func(t *Transcript) { t.Source = [16]byte{} }, func(t *Transcript) { t.Generation = 0 }, func(t *Transcript) { t.End = 0 }, func(t *Transcript) { t.Start = 1 }, func(t *Transcript) { t.Profile = "" }, func(t *Transcript) { t.Record = "one\ntwo"; t.End = 8 }} {
		bad := want
		change(&bad)
		if _, err := EncodeTranscript(bad); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	// Unsupported profiles are transported as data; host normalization stops
	// visibly rather than the codec silently dropping a registered source.
	want.Profile = "codex/future"
	p, err = EncodeTranscript(want)
	if err != nil {
		t.Fatal(err)
	}
	if t2, err := DecodeTranscript(p); err != nil || t2.Profile != "codex/future" {
		t.Fatal(t2, err)
	}
}
