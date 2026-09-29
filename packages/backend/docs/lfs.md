# Git LFS repository visibility

Git LFS batch requests for a private repository return `404` when the caller cannot read it. The response is the same as for a repository that does not exist, for both uploads and downloads. A caller who can read the repository still needs write permission to upload.
