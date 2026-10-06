package wire

import (
	"os"
	"strings"
	"testing"
)

func TestBurstGoldenProjection(t *testing.T) {
	for _, name := range []string{"ev_burst", "ev_burst_rename_delete", "ev_burst_part"} {
		t.Run(name, func(t *testing.T) {
			bytes, err := os.ReadFile("../../compose/testdata/cocontracts/" + name + ".bin")
			if err != nil {
				t.Fatal(err)
			}
			frame, err := Decode(bytes)
			if err != nil {
				t.Fatal(err)
			}
			event, err := DecodeDurableEvent(frame)
			if err != nil {
				t.Fatal(err)
			}
			b, err := DecodeBurst(event.Payload)
			if err != nil {
				t.Fatal(err)
			}
			if b.ID != [16]byte{0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44} || b.Versions != strings.Repeat("11", 20) {
				t.Fatalf("burst identity: %+v", b)
			}
			switch name {
			case "ev_burst":
				if event.Seq != 7 || string(b.Actor.Principal) != "principal" || len(b.Files) != 1 || b.Files[0] != (BurstFile{Path: "src/a.ts", Change: "modified", BeforeBlob: strings.Repeat("11", 20), AfterBlob: strings.Repeat("22", 20), PostDigest: strings.Repeat("33", 32)}) {
					t.Fatalf("projection: %+v", b)
				}
			case "ev_burst_rename_delete":
				if event.Seq != 8 || b.Actor.Session != 1 || len(b.Files) != 2 || b.Files[0].RenamedTo != "new" || b.Files[1].Change != "deleted" || b.Files[1].AfterBlob != "" || b.Files[1].PostDigest != "" {
					t.Fatalf("projection: %+v", b)
				}
			case "ev_burst_part":
				if event.Seq != 9 || b.Actor.Kind != 4 || b.Part != 1 || b.Parts != 2 {
					t.Fatalf("projection: %+v", b)
				}
			}
			for n := 0; n < len(event.Payload); n++ {
				if _, err := DecodeBurst(event.Payload[:n]); err == nil {
					t.Fatalf("accepted truncation %d", n)
				}
			}
			if _, err := DecodeBurst(append(event.Payload, 0)); err != TrailingBytes {
				t.Fatalf("trailing: %v", err)
			}
		})
	}
}
