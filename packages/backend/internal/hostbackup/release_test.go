package hostbackup

import (
	"path/filepath"
	"testing"
)

func TestReleaseOrderingLiteralFixtures(t *testing.T) {
	for _, fixture := range []struct {
		left, right string
		order       int
	}{
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		{"1.0.0-alpha.beta", "1.0.0-beta", -1},
		{"1.0.0-beta", "1.0.0-beta.2", -1},
		{"1.0.0-beta.2", "1.0.0-beta.11", -1},
		{"1.0.0-beta.11", "1.0.0-rc.1", -1},
		{"1.0.0-rc.1", "1.0.0", -1},
		{"1.2.3", "1.10.0", -1},
		{"10.0.0", "2.0.0", 1},
		{"1.0.0-99999999999999999999", "1.0.0-100000000000000000000", -1},
		{"1.0.0-18446744073709551616", "1.0.0-alpha", -1},
	} {
		t.Run(fixture.left+"/"+fixture.right, func(t *testing.T) {
			for _, pair := range []struct {
				a, b  string
				order int
			}{{fixture.left, fixture.right, fixture.order}, {fixture.right, fixture.left, -fixture.order}, {fixture.left, fixture.left, 0}} {
				order, err := CompareRelease(pair.a, pair.b)
				must(t, err)
				if order != pair.order {
					t.Fatalf("%s vs %s: want %d, got %d", pair.a, pair.b, pair.order, order)
				}
			}
		})
	}
	for _, release := range []string{"dev", "01.2.3", "1.0.0-01", "1.0.0-", "1.0.0-rc/foo", "1.0.0+build", "18446744073709551616.0.0"} {
		_, err := CompareRelease(release, "1.0.0")
		requireCode(t, err, Code("wrong_version"))
	}
}

func TestReleaseCandidateManifestRestoresForward(t *testing.T) {
	stage, m := fixture(t)
	m.Version = "1.2.3-rc.1"
	must(t, WriteManifest(stage, m))
	dir := filepath.Join(filepath.Dir(stage), "1.2.3-rc.1-20261003T220000.000000000Z")
	for _, release := range []string{"1.2.3-rc.2", "1.2.3", "1.3.0-alpha"} {
		must(t, VerifyManifest(dir, Version{Release: release, Schema: 2, PostgresMajor: 18}))
	}
	for _, release := range []string{"1.2.3-beta", "1.2.3-rc.0", "1.2.2"} {
		requireCode(t, VerifyManifest(dir, Version{Release: release, Schema: 2, PostgresMajor: 18}), Code("older_version"))
	}
}
