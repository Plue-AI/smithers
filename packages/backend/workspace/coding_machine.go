package workspace

// CodingMachineSpec selects the repository toolchain (including bubblewrap)
// and dependencies for every coding host. Source selects image inputs only;
// callers restore and authorize their own checkout separately.
func CodingMachineSpec(id, repository, revision string) WorkspaceSpec {
	return WorkspaceSpec{ID: id, Source: &WorkspaceSource{Repository: repository, Revision: revision}}
}
