package workspace

import "testing"

func TestWorkspaceCodingBindingValidation(t *testing.T) {
	valid := WorkspaceCodingBinding{ActorID: 9, RepositoryID: 77, RepositorySlug: "acme/widgets", APIBaseURL: "https://backend.example/api", GitURL: "https://backend.example/acme/widgets.git"}
	for _, test := range []struct {
		name    string
		mutate  func(*WorkspaceCodingBinding)
		wantErr bool
	}{
		{name: "valid HTTPS"},
		{name: "valid HTTP", mutate: func(b *WorkspaceCodingBinding) {
			b.APIBaseURL = "http://127.0.0.1:4000/api"
			b.GitURL = "http://127.0.0.1:4000/acme/widgets.git"
		}},
		{name: "zero actor", mutate: func(b *WorkspaceCodingBinding) { b.ActorID = 0 }, wantErr: true},
		{name: "negative repository", mutate: func(b *WorkspaceCodingBinding) { b.RepositoryID = -1 }, wantErr: true},
		{name: "no owner", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = "/widgets" }, wantErr: true},
		{name: "no repository", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = "acme/" }, wantErr: true},
		{name: "no separator", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = "widgets" }, wantErr: true},
		{name: "extra path", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = "acme/widgets/other" }, wantErr: true},
		{name: "dot owner", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = "./widgets" }, wantErr: true},
		{name: "parent repository", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = "acme/.." }, wantErr: true},
		{name: "whitespace", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = " acme/widgets" }, wantErr: true},
		{name: "backslash", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = "acme/wid\\gets" }, wantErr: true},
		{name: "nul", mutate: func(b *WorkspaceCodingBinding) { b.RepositorySlug = "acme/wid\x00gets" }, wantErr: true},
		{name: "API missing", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL = "" }, wantErr: true},
		{name: "API invalid URL", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL = "://" }, wantErr: true},
		{name: "API port", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL = "http://backend.example:invalid/api" }, wantErr: true},
		{name: "API wrong scheme", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL = "file:///api" }, wantErr: true},
		{name: "API query", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL += "?x=1" }, wantErr: true},
		{name: "API empty query", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL += "?" }, wantErr: true},
		{name: "API fragment", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL += "#secret" }, wantErr: true},
		{name: "API credentials", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL = "https://secret@backend.example/api" }, wantErr: true},
		{name: "API wrong path", mutate: func(b *WorkspaceCodingBinding) { b.APIBaseURL += "/other" }, wantErr: true},
		{name: "Git parse error", mutate: func(b *WorkspaceCodingBinding) { b.GitURL = "://" }, wantErr: true},
		{name: "Git query", mutate: func(b *WorkspaceCodingBinding) { b.GitURL += "?secret=1" }, wantErr: true},
		{name: "Git origin", mutate: func(b *WorkspaceCodingBinding) { b.GitURL = "https://other.example/acme/widgets.git" }, wantErr: true},
		{name: "Git scheme", mutate: func(b *WorkspaceCodingBinding) { b.GitURL = "http://backend.example/acme/widgets.git" }, wantErr: true},
		{name: "Git repository", mutate: func(b *WorkspaceCodingBinding) { b.GitURL = "https://backend.example/acme/other.git" }, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			binding := valid
			if test.mutate != nil {
				test.mutate(&binding)
			}
			if err := binding.Validate(); (err != nil) != test.wantErr {
				t.Fatalf("validation error=%v, want error=%v", err, test.wantErr)
			}
		})
	}
}
