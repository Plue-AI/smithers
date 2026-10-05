//! Import immutable retained Git refs into the native JJ store.
//! Transport uses only the root-owned workspace binding, never repo Git config.
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use jj_lib::object_id::ObjectId;
use serde::Deserialize;
use serde_json::{json, Value};
use smithers_ffi::jj_core::{create_settings, load_repo_at_head, UserConfig};

use super::source_create;
use super::workspace_engine::{field, invalid, jj, Failure};
use super::workspace_local::{jj_at, revision};

type Result<T> = std::result::Result<T, Failure>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    version: u32,
    workspace_id: String,
    repository_id: i64,
    actor_id: i64,
    repository_path: String,
    repository_slug: String,
    api_base_url: String,
    git_url: String,
    credential_socket: String,
}

fn binding(repo: &Path) -> Result<Binding> {
    let config: Binding = source_create::read_provisioned_config().map_err(|_| {
        Failure::new(
            "source_import_unavailable",
            "protected source binding is unavailable",
        )
    })?;
    if config.version != 1
        || Path::new(&config.repository_path) != repo
        || config.repository_id <= 0
        || config.actor_id <= 0
        || !config
            .workspace_id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() || c == b'-')
        || !config.repository_slug.split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        })
        || config.repository_slug.matches('/').count() != 1
        || !(config.api_base_url.starts_with("https://")
            || config.api_base_url.starts_with("http://127.0.0.1:")
            || config.api_base_url.starts_with("http://localhost:"))
        || !config.api_base_url.ends_with("/api")
        || config
            .api_base_url
            .bytes()
            .any(|c| c.is_ascii_whitespace() || b"\"\\?#@".contains(&c))
        || config.git_url
            != format!(
                "{}/{}.git",
                config.api_base_url.trim_end_matches("/api"),
                config.repository_slug
            )
        || !config.credential_socket.starts_with('/')
        || config
            .credential_socket
            .bytes()
            .any(|c| !(c.is_ascii_alphanumeric() || b"/_.-".contains(&c)))
    {
        return Err(Failure::new(
            "source_import_unavailable",
            "source binding is invalid",
        ));
    }
    Ok(config)
}

pub(super) fn available(repo: &Path) -> bool {
    binding(repo).is_ok()
}

fn hex_commit(id: &str) -> bool {
    id.len() == 40
        && id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn git(
    git_dir: &Path,
    args: &[&str],
    transport: Option<(&Binding, &Path)>,
    missing: bool,
) -> Result<Option<String>> {
    let mut command = Command::new("git");
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "false")
        .env("HOME", "/nonexistent")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.http.allow=always",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "http.followRedirects=false",
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "pack.threads=1",
        ]);
    #[cfg(test)]
    command.args(["-c", "protocol.file.allow=always"]);
    if let Some((binding, objects)) = transport {
        command
            .env("GIT_OBJECT_DIRECTORY", objects)
            .arg("-c")
            .arg(format!(
                "credential.helper=cache --socket {}",
                binding.credential_socket
            ))
            .args(["-c", "credential.useHttpPath=true"]);
        for (key, value) in managed_transport()? {
            command.arg("-c").arg(format!("{key}={value}"));
        }
    }
    let output = command
        .arg("--git-dir")
        .arg(git_dir)
        .args(args)
        .output()
        .map_err(|_| {
            Failure::new(
                "source_import_unavailable",
                "Git source transport is unavailable",
            )
        })?;
    if !output.status.success() {
        if missing {
            return Ok(None);
        }
        return Err(Failure::new(
            "source_import_unavailable",
            "Git source operation could not complete",
        ));
    }
    let text = String::from_utf8(output.stdout).map_err(|_| {
        Failure::new(
            "source_import_unavailable",
            "Git source response is invalid",
        )
    })?;
    if text.len() > 4 << 20 {
        return Err(Failure::new(
            "source_import_unavailable",
            "Git source response exceeds its budget",
        ));
    }
    Ok(Some(text))
}

#[cfg(windows)]
fn managed_transport() -> Result<Vec<(&'static str, String)>> {
    Err(Failure::new(
        "source_import_unavailable",
        "Managed guest transport requires protected Unix provisioning",
    ))
}

#[cfg(unix)]
fn managed_transport() -> Result<Vec<(&'static str, String)>> {
    let path = Path::new("/etc/smithers/egress.env");
    if !path.exists() {
        return Ok(vec![]);
    }
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path).map_err(|_| {
        Failure::new(
            "source_import_unavailable",
            "managed transport is unavailable",
        )
    })?;
    if !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o022 != 0 || meta.len() > 16_384 {
        return Err(Failure::new(
            "source_import_unavailable",
            "managed transport is unprotected",
        ));
    }
    let raw = std::fs::read_to_string(path).map_err(|_| {
        Failure::new(
            "source_import_unavailable",
            "managed transport is unavailable",
        )
    })?;
    let mut values = BTreeMap::new();
    for line in raw
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
    {
        let line = line.trim().strip_prefix("export ").ok_or_else(|| {
            Failure::new("source_import_unavailable", "managed transport is invalid")
        })?;
        let (key, value) = line.split_once('=').ok_or_else(|| {
            Failure::new("source_import_unavailable", "managed transport is invalid")
        })?;
        if ![
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "GIT_SSL_CAINFO",
            "SSL_CERT_FILE",
            "CURL_CA_BUNDLE",
            "NO_PROXY",
            "no_proxy",
            "REQUESTS_CA_BUNDLE",
            "NODE_EXTRA_CA_CERTS",
        ]
        .contains(&key)
            || values.contains_key(key)
            || value.len() < 2
            || !value.starts_with('\'')
            || !value.ends_with('\'')
        {
            return Err(Failure::new(
                "source_import_unavailable",
                "managed transport is invalid",
            ));
        }
        let value = &value[1..value.len() - 1];
        if value.bytes().any(|c| c < 32 || c == 127 || c == b'\'') {
            return Err(Failure::new(
                "source_import_unavailable",
                "managed transport is invalid",
            ));
        }
        values.insert(key, value.to_owned());
    }
    let proxy = values.get("HTTPS_PROXY").ok_or_else(|| {
        Failure::new(
            "source_import_unavailable",
            "managed transport has no route",
        )
    })?;
    if ["https_proxy", "HTTP_PROXY", "http_proxy"]
        .iter()
        .any(|key| values.get(key) != Some(proxy))
        || ["GIT_SSL_CAINFO", "SSL_CERT_FILE", "CURL_CA_BUNDLE"]
            .iter()
            .any(|key| values.get(key).map(String::as_str) != Some("/etc/smithers/egress-ca.pem"))
    {
        return Err(Failure::new(
            "source_import_unavailable",
            "managed transport route or trust is invalid",
        ));
    }
    let authority = proxy
        .strip_prefix("http://host.microsandbox.internal:")
        .ok_or_else(|| {
            Failure::new(
                "source_import_unavailable",
                "managed transport route is invalid",
            )
        })?;
    if authority.is_empty() || !authority.bytes().all(|c| c.is_ascii_digit()) {
        return Err(Failure::new(
            "source_import_unavailable",
            "managed transport route is invalid",
        ));
    }
    let ca = Path::new("/etc/smithers/egress-ca.pem");
    let ca_meta = std::fs::symlink_metadata(ca).map_err(|_| {
        Failure::new(
            "source_import_unavailable",
            "managed transport trust is unavailable",
        )
    })?;
    if !ca_meta.is_file() || ca_meta.uid() != 0 || ca_meta.mode() & 0o022 != 0 {
        return Err(Failure::new(
            "source_import_unavailable",
            "managed transport trust is unprotected",
        ));
    }
    Ok(vec![
        ("http.proxy", proxy.clone()),
        ("http.sslCAInfo", ca.display().to_string()),
        ("http.sslVerify", "true".into()),
    ])
}

fn refs(git_dir: &Path) -> Result<BTreeMap<String, String>> {
    let raw = git(
        git_dir,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/",
            "refs/tags/",
            "refs/remotes/",
        ],
        None,
        false,
    )?
    .unwrap();
    raw.lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(name, id)| {
            let commit = if name.starts_with("refs/tags/") {
                git(
                    git_dir,
                    &["rev-parse", "--verify", &format!("{name}^{{commit}}")],
                    None,
                    true,
                )?
                .map(|v| v.trim().to_owned())
                .unwrap_or_else(|| id.to_owned())
            } else {
                id.to_owned()
            };
            Ok((name.to_owned(), commit))
        })
        .collect()
}

fn native_refs(repo: &Path) -> Result<(BTreeMap<String, String>, Option<String>)> {
    let settings = create_settings(&UserConfig::default());
    let (_, loaded) = load_repo_at_head(repo, &settings)
        .map_err(|_| Failure::new("unsupported_jj", "native repository is unavailable"))?;
    let refs = loaded
        .view()
        .git_refs()
        .iter()
        .map(|(name, target)| {
            let id = target.as_resolved().ok_or_else(|| {
                Failure::new("source_changed", "native Git reference is conflicted")
            })?;
            Ok(id.as_ref().map(|id| (name.as_str().to_owned(), id.hex())))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    let head = loaded
        .view()
        .git_head()
        .as_resolved()
        .ok_or_else(|| Failure::new("source_changed", "native Git HEAD is conflicted"))?
        .as_ref()
        .map(ObjectId::hex);
    Ok((refs, head))
}

fn preflight(repo: &Path, git_dir: &Path, seeds: &BTreeMap<String, String>) -> Result<()> {
    let mut actual = refs(git_dir)?;
    let (mut tracked, expected_head) = native_refs(repo)?;
    for name in seeds.keys() {
        actual.remove(name);
        tracked.remove(name);
    }
    actual.retain(|name, _| !name.ends_with("/HEAD"));
    let git_head = git(
        git_dir,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        None,
        true,
    )?
    .map(|value| value.trim().to_owned());
    if actual != tracked || git_head != expected_head {
        return Err(Failure::new(
            "source_changed",
            "pending Git references must be reconciled before source import",
        ));
    }
    Ok(())
}

fn run_with_binding(repo: &Path, input: &Value, config: &Binding) -> Result<Value> {
    let request = field(input, "requestId")?;
    let commits = input
        .get("commits")
        .and_then(Value::as_array)
        .filter(|values| (1..=2).contains(&values.len()))
        .ok_or_else(|| invalid("source import needs one or two retained commits"))?;
    let mut unique = HashSet::new();
    let mut seeds = BTreeMap::new();
    for item in commits {
        let sha = field(item, "commitId")?;
        if !hex_commit(sha)
            || sha.bytes().all(|c| c == b'0')
            || !unique.insert(sha)
            || field(item, "ref")?
                != format!(
                    "refs/smithers/workspaces/{}/sources/{sha}",
                    config.workspace_id
                )
        {
            return Err(invalid(
                "source import requires exact distinct owned references",
            ));
        }
        seeds.insert(
            format!(
                "refs/tags/smithers-source-import/{}/{request}/{sha}",
                config.workspace_id
            ),
            sha.to_owned(),
        );
    }
    let before = field(&super::workspace_local::operation(repo)?, "id")?.to_owned();
    let head_before = super::workspace_local::revision(
        repo,
        &super::workspace_engine::commit(repo, "@")?,
        &before,
    )?;
    let git_dir = PathBuf::from(jj(repo, &["git", "root"], false)?.trim());
    let (tracked_refs, _) = native_refs(repo)?;
    let unfinished = seeds.keys().any(|reference| {
        tracked_refs.contains_key(reference)
            || git(
                &git_dir,
                &["show-ref", "--hash", "--verify", reference],
                None,
                true,
            )
            .ok()
            .flatten()
            .is_some()
    });
    let retained = !unfinished
        && commits.iter().all(|item| {
            let Ok(sha) = field(item, "commitId") else {
                return false;
            };
            let Ok(reference) = field(item, "ref") else {
                return false;
            };
            git(
                &git_dir,
                &["show-ref", "--hash", "--verify", reference],
                None,
                true,
            )
            .ok()
            .flatten()
            .is_some_and(|value| value.trim() == sha)
                && super::workspace_engine::commit(repo, &format!("commit_id(\"{sha}\")")).is_ok()
        });
    if retained {
        let revisions = commits
            .iter()
            .map(|item| {
                let sha = field(item, "commitId")?;
                let selected =
                    super::workspace_engine::commit(repo, &format!("commit_id(\"{sha}\")"))?;
                revision(repo, &selected, &before)
            })
            .collect::<Result<Vec<_>>>()?;
        return Ok(
            json!({"status":"imported", "requestId":request, "workspaceId":config.workspace_id,
            "repositoryId":config.repository_id, "operationId":before, "head":head_before, "revisions":revisions}),
        );
    }
    preflight(repo, &git_dir, &seeds)?;
    let mut expected_refs = refs(&git_dir)?;
    for reference in seeds.keys() {
        expected_refs.remove(reference);
    }
    let bookmarks = jj_at(
        repo,
        &before,
        &[
            "bookmark",
            "list",
            "--all-remotes",
            "-T",
            "json(self) ++ \"\\n\"",
        ],
    )?;
    let scratch = tempfile::tempdir().map_err(|_| {
        Failure::new(
            "source_import_unavailable",
            "source scratch directory is unavailable",
        )
    })?;
    let scratch_git = scratch.path().join("import.git");
    let status = Command::new("git")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args(["init", "--bare", "--template="])
        .arg(&scratch_git)
        // Git reports the new repository on stdout, where the caller reads
        // only this helper's JSON receipt.
        .stdout(Stdio::null())
        .status()
        .map_err(|_| {
            Failure::new(
                "source_import_unavailable",
                "Git source transport is unavailable",
            )
        })?;
    if !status.success() {
        return Err(Failure::new(
            "source_import_unavailable",
            "source scratch repository failed",
        ));
    }
    let objects = git_dir.join("objects");
    let mut advertised = BTreeMap::new();
    let mut remote_args = vec!["ls-remote", "--refs", config.git_url.as_str()];
    remote_args.extend(commits.iter().map(|item| item["ref"].as_str().unwrap()));
    for line in git(&scratch_git, &remote_args, Some((config, &objects)), false)?
        .unwrap()
        .lines()
    {
        if let Some((sha, name)) = line.split_once('\t') {
            advertised.insert(name.to_owned(), sha.to_owned());
        }
    }
    for item in commits {
        let reference = field(item, "ref")?;
        if !advertised.contains_key(reference) {
            return Err(Failure::new(
                "source_missing",
                "retained source reference is missing",
            ));
        }
        if advertised[reference] != field(item, "commitId")? {
            return Err(Failure::new(
                "source_changed",
                "retained source reference changed",
            ));
        }
    }
    let fetch_refs: Vec<String> = commits
        .iter()
        .map(|item| {
            format!(
                "{}:refs/smithers-import/{}",
                item["ref"].as_str().unwrap(),
                item["commitId"].as_str().unwrap()
            )
        })
        .collect();
    let mut fetch_args = vec![
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        config.git_url.as_str(),
    ];
    fetch_args.extend(fetch_refs.iter().map(String::as_str));
    git(&scratch_git, &fetch_args, Some((config, &objects)), false)?;
    for item in commits {
        let sha = field(item, "commitId")?;
        let fetched = git(
            &scratch_git,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/smithers-import/{sha}^{{commit}}"),
            ],
            Some((config, &objects)),
            false,
        )?
        .unwrap();
        if fetched.trim() != sha {
            return Err(Failure::new(
                "source_changed",
                "fetched source identity changed",
            ));
        }
    }
    if field(&super::workspace_local::operation(repo)?, "id")? != before {
        return Err(Failure::new(
            "source_changed",
            "native repository changed during source fetch",
        ));
    }
    preflight(repo, &git_dir, &seeds)?;
    for item in commits {
        let sha = field(item, "commitId")?;
        let reference = field(item, "ref")?;
        let existing = git(
            &git_dir,
            &["show-ref", "--hash", "--verify", reference],
            None,
            true,
        )?;
        if existing.as_deref().is_some_and(|value| value.trim() != sha) {
            return Err(Failure::new(
                "source_changed",
                "retained source reference changed",
            ));
        }
        if existing.is_none() {
            git(
                &git_dir,
                &["update-ref", reference, sha, &"0".repeat(40)],
                None,
                false,
            )?;
        }
    }
    for (reference, sha) in &seeds {
        let existing = git(
            &git_dir,
            &["show-ref", "--hash", "--verify", reference],
            None,
            true,
        )?;
        if existing.as_deref().is_some_and(|value| value.trim() != sha) {
            return Err(Failure::new(
                "source_changed",
                "source recovery reference changed",
            ));
        }
        if existing.is_none() {
            git(
                &git_dir,
                &["update-ref", reference, sha, &"0".repeat(40)],
                None,
                false,
            )?;
        }
    }
    jj(
        repo,
        &[
            "--config",
            "git.abandon-unreachable-commits=false",
            "git",
            "import",
        ],
        false,
    )?;
    for (reference, sha) in &seeds {
        git(&git_dir, &["update-ref", "-d", reference, sha], None, false)?;
    }
    jj(
        repo,
        &[
            "--config",
            "git.abandon-unreachable-commits=false",
            "git",
            "import",
        ],
        false,
    )?;
    let at = field(&super::workspace_local::operation(repo)?, "id")?.to_owned();
    let head = revision(repo, &super::workspace_engine::commit(repo, "@")?, &at)?;
    if [
        "kind",
        "commitId",
        "changeId",
        "treeId",
        "treeTerms",
        "parentCommitIds",
    ]
    .iter()
    .any(|key| head[key] != head_before[*key])
    {
        return Err(Failure::new(
            "source_changed",
            "editor head changed during source import",
        ));
    }
    if refs(&git_dir)? != expected_refs {
        return Err(Failure::new(
            "source_changed",
            "Git references changed during source import",
        ));
    }
    if jj_at(
        repo,
        &at,
        &[
            "bookmark",
            "list",
            "--all-remotes",
            "-T",
            "json(self) ++ \"\\n\"",
        ],
    )? != bookmarks
    {
        return Err(Failure::new(
            "source_changed",
            "native bookmarks changed during source import",
        ));
    }
    let revisions = commits
        .iter()
        .map(|item| {
            let sha = field(item, "commitId")?;
            let selected = super::workspace_engine::commit(repo, &format!("commit_id(\"{sha}\")"))?;
            revision(repo, &selected, &at)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"status":"imported", "requestId":request, "workspaceId":config.workspace_id,
        "repositoryId":config.repository_id, "operationId":at, "head":head, "revisions":revisions}),
    )
}

pub fn run(repo: &Path, input: &Value) -> Result<Value> {
    let config = binding(repo)?;
    run_with_binding(repo, input, &config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn command(program: &str, args: &[&str]) -> String {
        let output = Command::new(program).args(args).output().unwrap();
        assert!(
            output.status.success(),
            "{program} {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    #[test]
    fn imports_retained_ancestry_without_moving_the_editor_or_dirty_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let owned = temp.path().join("owned");
        let foreign = temp.path().join("foreign");
        let bare = temp.path().join("source.git");
        let owned_path = owned.to_str().unwrap();
        let foreign_path = foreign.to_str().unwrap();
        let bare_path = bare.to_str().unwrap();
        for repo in [owned_path, foreign_path] {
            command("jj", &["git", "init", repo]);
            command(
                "jj",
                &[
                    "-R",
                    repo,
                    "config",
                    "set",
                    "--repo",
                    "user.name",
                    "Source Test",
                ],
            );
            command(
                "jj",
                &[
                    "-R",
                    repo,
                    "config",
                    "set",
                    "--repo",
                    "user.email",
                    "source@example.invalid",
                ],
            );
        }
        fs::write(foreign.join("code.txt"), "before\n").unwrap();
        command(
            "jj",
            &["-R", foreign_path, "describe", "-m", "foreign base"],
        );
        let base = command(
            "jj",
            &[
                "-R",
                foreign_path,
                "log",
                "-r",
                "@",
                "--no-graph",
                "-T",
                "commit_id",
            ],
        )
        .trim()
        .to_owned();
        command("jj", &["-R", foreign_path, "new"]);
        fs::write(foreign.join("code.txt"), "after\n").unwrap();
        command(
            "jj",
            &["-R", foreign_path, "describe", "-m", "foreign head"],
        );
        let head = command(
            "jj",
            &[
                "-R",
                foreign_path,
                "log",
                "-r",
                "@",
                "--no-graph",
                "-T",
                "commit_id",
            ],
        )
        .trim()
        .to_owned();
        command("git", &["init", "--bare", bare_path]);
        let foreign_git = command("jj", &["-R", foreign_path, "git", "root"])
            .trim()
            .to_owned();
        let workspace = "22222222-2222-4222-8222-222222222222";
        let source_ref = |sha: &str| format!("refs/smithers/workspaces/{workspace}/sources/{sha}");
        command(
            "git",
            &[
                "--git-dir",
                &foreign_git,
                "push",
                bare_path,
                &format!("{head}:{}", source_ref(&head)),
                &format!("{base}:{}", source_ref(&base)),
            ],
        );
        fs::write(owned.join("user.txt"), "saved\n").unwrap();
        command("jj", &["-R", owned_path, "status"]);
        let before = super::super::workspace_local::run(
            serde_json::to_string(&json!({
                "operation":"read", "repositoryPath":owned
            }))
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
        fs::write(owned.join("user.txt"), "dirty\n").unwrap();
        let config = Binding {
            version: 1,
            workspace_id: workspace.into(),
            repository_id: 42,
            actor_id: 42,
            repository_path: owned_path.into(),
            repository_slug: "local/mirror".into(),
            api_base_url: "http://127.0.0.1:1/api".into(),
            git_url: bare_path.into(),
            credential_socket: "/tmp/source-import-test-socket".into(),
        };
        let request = json!({"operation":"import_source", "repositoryPath":owned,
            "requestId":"11111111-1111-4111-8111-111111111111",
            "commits":[{"commitId":head, "ref":source_ref(&head)}, {"commitId":base, "ref":source_ref(&base)}]});
        let owned_git = command(
            "jj",
            &["-R", owned_path, "--ignore-working-copy", "git", "root"],
        )
        .trim()
        .to_owned();
        command(
            "git",
            &[
                "--git-dir",
                &owned_git,
                "update-ref",
                "refs/heads/pending",
                before["head"]["commitId"].as_str().unwrap(),
            ],
        );
        assert_eq!(
            run_with_binding(&owned, &request, &config)
                .unwrap_err()
                .code,
            "source_changed"
        );
        command(
            "git",
            &[
                "--git-dir",
                &owned_git,
                "update-ref",
                "-d",
                "refs/heads/pending",
            ],
        );
        let imported = run_with_binding(&owned, &request, &config).unwrap();
        assert_eq!(imported["status"], "imported");
        assert_eq!(imported["head"]["commitId"], before["head"]["commitId"]);
        assert_eq!(imported["revisions"][0]["commitId"], head);
        assert_eq!(imported["revisions"][0]["parentCommitIds"][0], base);
        assert_eq!(
            fs::read_to_string(owned.join("user.txt")).unwrap(),
            "dirty\n"
        );
        assert_eq!(refs(Path::new(&owned_git)).unwrap().len(), 0);
        let replay = run_with_binding(&owned, &request, &config).unwrap();
        assert_eq!(replay["head"]["commitId"], imported["head"]["commitId"]);
        assert_eq!(replay["revisions"], imported["revisions"]);
        let seed = format!("refs/tags/smithers-source-import/{workspace}/11111111-1111-4111-8111-111111111111/{head}");
        command(
            "git",
            &["--git-dir", &owned_git, "update-ref", &seed, &head],
        );
        let recovered = run_with_binding(&owned, &request, &config).unwrap();
        assert_eq!(recovered["head"]["commitId"], imported["head"]["commitId"]);
        assert!(git(
            Path::new(&owned_git),
            &["show-ref", "--hash", "--verify", &seed],
            None,
            true
        )
        .unwrap()
        .is_none());
    }
}
