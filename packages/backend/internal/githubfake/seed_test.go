package githubfake

import (
	"regexp"
	"strings"
	"testing"
)

func TestLocalSeedForNamesTheOwnerAndTheirRepository(t *testing.T) {
	maya, err := LocalSeedFor("maya")
	if err != nil {
		t.Fatal(err)
	}
	if maya.OwnerLogin != "maya" || len(maya.Installations) != 1 || len(maya.Installations[0].Repositories) != 1 ||
		maya.Installations[0].Repositories[0].FullName != "maya/demo" {
		t.Fatalf("seed for maya: owner %q, installations %+v", maya.OwnerLogin, maya.Installations)
	}
	// LocalSeed keeps the walk's existing names.
	local, err := LocalSeed()
	if err != nil {
		t.Fatal(err)
	}
	if local.OwnerLogin != "local-owner" || local.Installations[0].Repositories[0].FullName != "local-owner/demo" {
		t.Fatalf("LocalSeed: owner %q, repository %q", local.OwnerLogin, local.Installations[0].Repositories[0].FullName)
	}
	// Every seed has its own credentials.
	if maya.ClientID == local.ClientID || maya.ClientSecret == local.ClientSecret || maya.WebhookSecret == local.WebhookSecret ||
		maya.ConversionCode == local.ConversionCode || maya.PrivateKeyPEM == local.PrivateKeyPEM {
		t.Fatal("two seeds share a credential")
	}
	for _, login := range []string{"a", "Maya", "maya-2", "m-a-y-a", strings.Repeat("a", 39)} {
		if _, err := LocalSeedFor(login); err != nil {
			t.Errorf("LocalSeedFor(%q): %v", login, err)
		}
	}
	for _, login := range []string{"", "-maya", "maya-", "ma--ya", "maya/demo", "maya demo", "maya.x", "../maya", strings.Repeat("a", 40), "mayá"} {
		if _, err := LocalSeedFor(login); err == nil {
			t.Errorf("LocalSeedFor(%q) accepted a name GitHub refuses", login)
		}
	}
}

// FuzzLocalSeedForLogin: a seed exists exactly for GitHub logins, and its one
// repository is always <login>/demo, so the owner never names a path.
func FuzzLocalSeedForLogin(f *testing.F) {
	for _, seed := range []string{"maya", "local-owner", "", "-", "a-", "a--b", strings.Repeat("z", 39), strings.Repeat("z", 40), "x/y", "ü"} {
		f.Add(seed)
	}
	rule := regexp.MustCompile(`^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$`)
	f.Fuzz(func(t *testing.T, login string) {
		valid := len(login) <= 39 && rule.MatchString(login)
		if !valid {
			if _, err := LocalSeedFor(login); err == nil {
				t.Fatalf("accepted %q", login)
			}
			return
		}
		// Key generation is the slow half: check the names with a cheap seed only when valid.
		cfg, err := LocalSeedFor(login)
		if err != nil {
			t.Fatalf("refused %q: %v", login, err)
		}
		if cfg.OwnerLogin != login || cfg.Installations[0].Repositories[0].FullName != login+"/demo" {
			t.Fatalf("seed for %q: %q %q", login, cfg.OwnerLogin, cfg.Installations[0].Repositories[0].FullName)
		}
	})
}
