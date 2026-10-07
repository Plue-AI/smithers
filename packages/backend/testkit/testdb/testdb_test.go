package testdb

import (
	"strings"
	"testing"
	"time"
)

func TestDatabaseNamesIncludeOnlySafeBoundedLaneNames(t *testing.T) {
	t.Setenv(NamespaceEnv, "")
	for _, lane := range []string{"", "fr-t-ins-06", "lane/hostile;DROP DATABASE postgres", strings.Repeat("z", 100)} {
		t.Run(lane, func(t *testing.T) {
			t.Setenv("LANE", lane)
			name, err := databaseName(time.Unix(1_800_000_000, 0))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(name, "smithers_test_1800000000_") {
				t.Fatalf("creation time missing: %s", name)
			}
			if len(name) > 63 {
				t.Fatalf("database name too long: %s", name)
			}
			for _, r := range name {
				if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
					t.Fatalf("unsafe database name: %s", name)
				}
			}
			if lane == "fr-t-ins-06" && !strings.Contains(name, "_fr_t_ins_06_") {
				t.Fatalf("lane missing: %s", name)
			}
		})
	}
}

func TestDatabaseNamespaceFencesOtherLanes(t *testing.T) {
	t.Setenv(NamespaceEnv, "fr_t_flw_08")
	now := time.Unix(1_800_000_000, 0)
	name, err := databaseName(now)
	if err != nil {
		t.Fatal(err)
	}
	if len(name) > 63 {
		t.Fatal("PostgreSQL name would truncate")
	}
	if !strings.HasPrefix(name, "smithers_test_fr_t_flw_08_") {
		t.Fatal("namespace missing")
	}
	for _, invalid := range []string{"fr-t-flw-08", "OTHER", "a_very_long_lane_name", "bad/name"} {
		t.Setenv(NamespaceEnv, invalid)
		if _, err := databaseName(now); err == nil {
			t.Fatalf("accepted invalid namespace %s", invalid)
		}
	}
}
