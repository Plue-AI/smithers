package wire

import (
	"encoding/hex"
	"testing"
)

func TestMovedOffReturnedLiteralEvent(t *testing.T) {
	payload, err := hex.DecodeString("040000002b0102000000050100000007020000000000000002031234567890abcdef1234567890abcdef123456780401")
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeMovedOff(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Returned || got.Item != 2 || got.PreMoveCommit != "1234567890abcdef1234567890abcdef12345678" {
		t.Fatalf("%+v", got)
	}
	payload[len(payload)-1] = 2
	if _, err = DecodeMovedOff(payload); err == nil {
		t.Fatal("accepted noncanonical returned flag")
	}
}

func TestMovedOffLiteralEvent(t *testing.T) {
	// Committed literal bytes: session 7 moved T2 off the recorded commit.
	payload, err := hex.DecodeString("04000000290102000000050100000007020000000000000002031234567890abcdef1234567890abcdef12345678")
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeMovedOff(payload)
	if err != nil {
		t.Fatal(err)
	}
	if got.Actor.Kind != 2 || got.Actor.Session != 7 || got.Item != 2 || got.PreMoveCommit != "1234567890abcdef1234567890abcdef12345678" {
		t.Fatalf("%+v", got)
	}
	for n := 0; n < len(payload); n++ {
		if _, err := DecodeMovedOff(payload[:n]); err == nil {
			t.Fatalf("accepted truncation %d", n)
		}
	}
	for name, bad := range map[string][]byte{
		"empty reserved payload": {4, 0, 0, 0, 0},
		"trailing bytes":         append(append([]byte(nil), payload...), 0),
		"wrong event":            Union(5),
		"zero item":              Union(4, Field(1, Union(4)), Field(2, U64(0)), Field(3, make([]byte, 20))),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeMovedOff(bad); err == nil {
				t.Fatal("accepted invalid moved-off event")
			}
		})
	}
}

func TestMovedOffAttribution(t *testing.T) {
	for _, tc := range []struct {
		actor     []byte
		kind      byte
		principal string
		session   uint32
		run       string
	}{
		{Union(1, Field(1, Bytes([]byte("member-7")))), 1, "member-7", 0, ""},
		{Union(2, Field(1, U32(8))), 2, "", 8, ""},
		{Union(3, Field(1, String("run-9"))), 3, "", 0, "run-9"},
		{Union(4), 4, "", 0, ""},
	} {
		got, err := DecodeMovedOff(Union(4, Field(1, tc.actor), Field(2, U64(2)), Field(3, make([]byte, 20))))
		if err != nil {
			t.Fatal(err)
		}
		if got.Actor.Kind != tc.kind || string(got.Actor.Principal) != tc.principal || got.Actor.Session != tc.session || got.Actor.Run != tc.run {
			t.Fatalf("%+v", got.Actor)
		}
	}
}
