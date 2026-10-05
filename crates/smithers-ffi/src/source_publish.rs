//! Guest-only transport in the existing native helper. The workspace reporter
//! owns the credential cache; neither its token nor a transport URL is input
//! to a flow. No JJ operation or bookmark is written by publication.
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use jj_lib::git::{self, GitPushOptions, GitRefUpdate, GitSubprocessOptions};
use jj_lib::git::{GitProgress, GitSidebandLineTerminator, GitSubprocessCallback};
use jj_lib::merge::Diff;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::{ReadonlyRepo, Repo};
use serde::{Deserialize, Serialize};
use smithers_ffi::jj_core::{create_settings, load_repo_at_head, UserConfig};
use smithers_ffi::workspace_source::{source_ref, Receipt, Source};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    source: Source,
    expected_operation_id: String,
    #[serde(default)]
    creation: Option<crate::source_create::Proof>,
}

#[derive(Serialize, Deserialize)]
struct Ack {
    #[serde(flatten)]
    receipt: Receipt,
    repository_id: i64,
}

#[derive(Debug, Serialize)]
pub struct Failure {
    pub code: &'static str,
    pub message: &'static str,
}
type Result<T> = std::result::Result<T, Failure>;
fn unavailable() -> Failure {
    Failure {
        code: "source_publication_unavailable",
        message: "Original source publication could not be verified; retry the identical source",
    }
}
fn invalid() -> Failure {
    Failure {
        code: "invalid_request",
        message: "Invalid provisioned source publication configuration or native identity",
    }
}
fn stale() -> Failure {
    Failure {
        code: "revision_conflict",
        message: "Original native source moved before publication; gather and plan again",
    }
}

// Neither transport sideband nor raw errors are emitted: authentication tools
// and a remote may include credentials or untrusted data in their diagnostics.
struct Quiet;
impl GitSubprocessCallback for Quiet {
    fn needs_progress(&self) -> bool {
        false
    }
    fn progress(&mut self, _: &GitProgress) -> std::io::Result<()> {
        Ok(())
    }
    fn local_sideband(
        &mut self,
        _: &[u8],
        _: Option<GitSidebandLineTerminator>,
    ) -> std::io::Result<()> {
        Ok(())
    }
    fn remote_sideband(
        &mut self,
        _: &[u8],
        _: Option<GitSidebandLineTerminator>,
    ) -> std::io::Result<()> {
        Ok(())
    }
}

fn config_valid(config: &Config, path: &Path) -> bool {
    // These fields come from the root-owned provisioning file, never from the
    // repository or request. Restrict them anyway before invoking transports.
    let slug: Vec<_> = config.repository_slug.split('/').collect();
    config.version == 1
        && config.repository_id > 0
        && Path::new(&config.repository_path) == path
        && slug.len() == 2
        && slug.iter().all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
        && config.credential_socket.starts_with('/')
        && config.credential_socket.len() < 1024
        && config
            .credential_socket
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_.".contains(&b))
        && !config
            .api_base_url
            .bytes()
            .any(|b| b <= 32 || b >= 127 || b"\"\\?#@".contains(&b))
        && (config.api_base_url.starts_with("https://")
            || config.api_base_url.starts_with("http://127.0.0.1:")
            || config.api_base_url.starts_with("http://localhost:"))
        && config.api_base_url.ends_with("/api")
        && config.git_url
            == format!(
                "{}/{}.git",
                config.api_base_url.trim_end_matches("/api"),
                config.repository_slug
            )
}

fn credential(config: &Config) -> Result<String> {
    let mut cascade = gix::credentials::helper::Cascade {
        programs: vec![gix::credentials::Program::from_custom_definition(format!(
            "cache --socket {}",
            config.credential_socket
        ))],
        stderr: false,
        use_http_path: true,
        query_user_only: false,
    };
    let outcome = cascade
        .invoke(
            gix::credentials::helper::Action::get_for_url(config.git_url.as_str()),
            gix::prompt::Options {
                mode: gix::prompt::Mode::Disable,
                askpass: None,
            },
        )
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)?;
    let token = outcome.identity.password;
    if token.is_empty() || token.len() > 4096 || token.bytes().any(|b| b <= 32 || b >= 127) {
        return Err(unavailable());
    }
    Ok(token)
}

fn verify_ack(value: serde_json::Value, config: &Config, source: &Source) -> Result<Ack> {
    let ack: Ack = serde_json::from_value(
        value
            .get("retained_source")
            .cloned()
            .ok_or_else(unavailable)?,
    )
    .map_err(|_| unavailable())?;
    if ack.receipt.status != "retained"
        || ack.receipt.workspace_id != config.workspace_id
        || ack.repository_id != config.repository_id
        || ack.receipt.r#ref
            != source_ref(&config.workspace_id, &source.commit_id).map_err(|_| invalid())?
        || ack.receipt.source != *source
    {
        return Err(Failure {
            code: "source_publication_invalid_ack",
            message: "Cloud acknowledgement did not match the exact workspace and source",
        });
    }
    Ok(ack)
}

fn acknowledge(config: &Config, source: &Source, token: &str) -> Result<Option<Ack>> {
    let url = format!(
        "{}/repos/{}/workspaces/{}/head",
        config.api_base_url, config.repository_slug, config.workspace_id
    );
    let body = serde_json::to_string(&serde_json::json!({ "retain_source": source }))
        .map_err(|_| invalid())?;
    // curl is already installed for the reporter. --disable prevents curlrc
    // overrides; the header exists only on stdin, never in argv or a file.
    let input = format!(
        "url = {}\nheader = {}\nheader = \"Content-Type: application/json\"\ndata-binary = {}\n",
        serde_json::to_string(&url).map_err(|_| invalid())?,
        serde_json::to_string(&format!("Authorization: Bearer {token}")).map_err(|_| invalid())?,
        serde_json::to_string(&body).map_err(|_| invalid())?
    );
    let mut child = Command::new("curl")
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--max-time",
            "20",
            "--connect-timeout",
            "5",
            "--max-filesize",
            "1048576",
            "--proto",
            "=https,http",
            "--write-out",
            "\n%{http_code}",
            "--config",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| unavailable())?;
    if child
        .stdin
        .take()
        .ok_or_else(unavailable)?
        .write_all(input.as_bytes())
        .is_err()
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(unavailable());
    }
    let output = child.wait_with_output().map_err(|_| unavailable())?;
    if !output.status.success() || output.stdout.len() > 1_048_580 {
        return Err(unavailable());
    }
    let raw = std::str::from_utf8(&output.stdout).map_err(|_| unavailable())?;
    let (body, status) = raw.rsplit_once('\n').ok_or_else(unavailable)?;
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| unavailable())?;
    match status {
        "200" => verify_ack(value, config, source).map(Some),
        "404" if value.get("code").and_then(|v| v.as_str()) == Some("workspace_source_missing") => {
            Ok(None)
        }
        _ => Err(unavailable()),
    }
}

fn push_source(repo: &ReadonlyRepo, config: &Config, source: &Source, name: &str) -> Result<()> {
    let mut options =
        GitSubprocessOptions::from_settings(repo.settings()).map_err(|_| unavailable())?;
    let entries = [
        ("remote.origin.url", config.git_url.clone()),
        ("remote.origin.pushurl", config.git_url.clone()),
        ("credential.helper", String::new()),
        (
            "credential.helper",
            format!("cache --socket {}", config.credential_socket),
        ),
        ("credential.useHttpPath", "true".into()),
        ("core.hooksPath", "/dev/null".into()),
        ("http.followRedirects", "false".into()),
        ("http.lowSpeedLimit", "1".into()),
        ("http.lowSpeedTime", "30".into()),
    ];
    options
        .environment
        .insert("GIT_CONFIG_COUNT".into(), entries.len().to_string().into());
    for (index, (key, value)) in entries.into_iter().enumerate() {
        options
            .environment
            .insert(format!("GIT_CONFIG_KEY_{index}").into(), key.into());
        options
            .environment
            .insert(format!("GIT_CONFIG_VALUE_{index}").into(), value.into());
    }
    for key in [
        "GIT_TERMINAL_PROMPT",
        "GIT_TRACE",
        "GIT_TRACE_PACKET",
        "GIT_TRACE_CURL",
        "GIT_CURL_VERBOSE",
        "GIT_TRACE2",
        "GIT_TRACE2_EVENT",
        "GIT_TRACE2_PERF",
    ] {
        options.environment.insert(key.into(), "0".into());
    }
    options
        .environment
        .insert("GIT_ASKPASS".into(), "false".into());
    let update = GitRefUpdate {
        qualified_name: name.to_owned().into(),
        targets: Diff {
            before: None,
            after: Some(
                gix::ObjectId::from_hex(source.commit_id.as_bytes()).map_err(|_| invalid())?,
            ),
        },
    };
    // The native transport owns push/CAS; even an ambiguous transport failure
    // is resolved only by the exact authoritative ACK, never by exit status.
    let _ = git::push_updates(
        repo,
        options,
        "origin".as_ref(),
        &[update],
        &mut Quiet,
        &GitPushOptions::default(),
    );
    Ok(())
}

fn publish(path: &Path, config: Config, request: Request) -> Result<serde_json::Value> {
    if !config_valid(&config, path)
        || request.expected_operation_id.len() != 128
        || !request
            .expected_operation_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    request.source.validate().map_err(|_| invalid())?;
    source_ref(&config.workspace_id, &request.source.commit_id).map_err(|_| invalid())?;
    let token = credential(&config)?;
    publish_authenticated(path, &config, &request, &token)
}

fn publish_authenticated(
    path: &Path,
    config: &Config,
    request: &Request,
    token: &str,
) -> Result<serde_json::Value> {
    let name =
        source_ref(&config.workspace_id, &request.source.commit_id).map_err(|_| invalid())?;
    // A supplied proof is always verified before cloud replay or transport.
    // It never falls back to the legacy current-editor-head authority.
    if let Some(proof) = &request.creation {
        let (_, repo) = crate::source_create::load_single(path).map_err(|_| stale())?;
        let owner = crate::source_create::Owner {
            workspace_id: config.workspace_id.clone(),
            repository_id: config.repository_id,
            actor_id: config.actor_id,
        };
        crate::source_create::verify_creation(
            &repo,
            &owner,
            &request.expected_operation_id,
            proof,
            &request.source,
        )
        .map_err(|_| invalid())?;
        if let Some(ack) = acknowledge(config, &request.source, token)? {
            return serde_json::to_value(ack).map_err(|_| unavailable());
        }
        // Detect a concurrent operation before the first external publication.
        use pollster::FutureExt as _;
        if repo
            .op_heads_store()
            .get_op_heads()
            .block_on()
            .map_err(|_| stale())?
            != [repo.operation().id().clone()]
        {
            return Err(stale());
        }
        push_source(repo.as_ref(), config, &request.source, &name)?;
        let ack = acknowledge(config, &request.source, token)?.ok_or_else(unavailable)?;
        return serde_json::to_value(ack).map_err(|_| unavailable());
    }
    // Replaying an acknowledged publication is safe after the local source
    // was rewritten. A first publication must still pass the native fence.
    if let Some(ack) = acknowledge(config, &request.source, token)? {
        return serde_json::to_value(ack).map_err(|_| unavailable());
    }
    let settings = create_settings(&UserConfig::default());
    let (workspace, repo) = load_repo_at_head(path, &settings).map_err(|_| unavailable())?;
    if repo.operation().id().hex() != request.expected_operation_id {
        return Err(stale());
    }
    let head = repo
        .view()
        .get_wc_commit_id(workspace.workspace_name())
        .ok_or_else(stale)?;
    let commit = repo.store().get_commit(head).map_err(|_| stale())?;
    if Source::from_commit(&commit).map_err(|_| stale())? != request.source {
        return Err(stale());
    }
    push_source(repo.as_ref(), config, &request.source, &name)?;
    let ack = acknowledge(config, &request.source, token)?.ok_or_else(unavailable)?;
    serde_json::to_value(ack).map_err(|_| unavailable())
}

pub(crate) fn run_bytes(path: &Path, raw: &[u8]) -> Result<serde_json::Value> {
    let config: Config = crate::source_create::read_provisioned_config().map_err(|_| invalid())?;
    if config.actor_id <= 0 {
        return Err(invalid());
    }
    if raw.len() > 65_536 {
        return Err(invalid());
    }
    let request = serde_json::from_slice(raw).map_err(|_| invalid())?;
    publish(path, config, request)
}

pub fn run(path: &Path) -> Result<serde_json::Value> {
    let mut raw = Vec::new();
    std::io::stdin()
        .take(65_537)
        .read_to_end(&mut raw)
        .map_err(|_| invalid())?;
    run_bytes(path, &raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jj_lib::git_backend::GitBackend;
    use jj_lib::merged_tree::MergedTree;
    use jj_lib::workspace::Workspace;
    use pollster::FutureExt as _;
    use std::ffi::{CStr, CString};
    use std::net::TcpListener;

    fn require_curl() {
        let status = Command::new("curl")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("source publication tests require curl on PATH");
        assert!(
            status.success(),
            "source publication tests require working curl"
        );
    }

    fn fixture() -> (tempfile::TempDir, Config, Request) {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = create_settings(&UserConfig::default());
        Workspace::init_internal_git(&settings, temp.path(), gix::hash::Kind::Sha1)
            .block_on()
            .unwrap();
        let (workspace, repo) = load_repo_at_head(temp.path(), &settings).unwrap();
        let commit = repo
            .store()
            .get_commit(
                repo.view()
                    .get_wc_commit_id(workspace.workspace_name())
                    .unwrap(),
            )
            .unwrap();
        let source = Source::from_commit(&commit).unwrap();
        let config = Config {
            version: 1,
            workspace_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
            repository_id: 200,
            actor_id: 10,
            repository_path: temp.path().to_str().unwrap().into(),
            repository_slug: "acme/widgets".into(),
            api_base_url: "https://example.test/api".into(),
            git_url: "https://example.test/acme/widgets.git".into(),
            credential_socket: "/tmp/test-cache/socket".into(),
        };
        let request = Request {
            source,
            expected_operation_id: repo.operation().id().hex(),
            creation: None,
        };
        (temp, config, request)
    }

    #[test]
    #[cfg(unix)]
    fn credential_uses_the_reporters_existing_cache_with_repository_path_scope() {
        let (temp, mut config, _) = fixture();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        config.credential_socket = temp.path().join("socket").to_str().unwrap().into();
        let mut program = gix::credentials::Program::from_custom_definition(format!(
            "cache --timeout=5 --socket {}",
            config.credential_socket
        ));
        program.stderr = false;
        let entry = "protocol=https\nhost=example.test\npath=acme/widgets.git\nusername=x-access-token\npassword=sentinel-private-token\n\n";
        gix::credentials::helper::invoke(
            &mut program,
            &gix::credentials::helper::Action::Store(entry.into()),
        )
        .unwrap();
        let token = credential(&config).unwrap();
        assert!(token == "sentinel-private-token");
        config.git_url = "https://example.test/acme/other.git".into();
        assert_eq!(
            credential(&config).unwrap_err().code,
            "source_publication_unavailable"
        );
        gix::credentials::helper::invoke(
            &mut program,
            &gix::credentials::helper::Action::Erase(entry.into()),
        )
        .unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn local_windows_host_cannot_acquire_managed_unix_guest_credentials() {
        assert!(crate::source_create::read_provisioned_config::<Config>().is_err());
    }

    fn receipt(config: &Config, source: &Source) -> serde_json::Value {
        serde_json::json!({"retained_source": {"status":"retained", "workspace_id":config.workspace_id,"repository_id":config.repository_id,
            "ref":source_ref(&config.workspace_id,&source.commit_id).unwrap(),"source":source}})
    }

    fn move_source(path: &Path) {
        let settings = create_settings(&UserConfig::default());
        let (workspace, repo) = load_repo_at_head(path, &settings).unwrap();
        let mut tx = repo.start_transaction();
        let next = tx
            .repo_mut()
            .new_commit(
                vec![repo.store().root_commit_id().clone()],
                MergedTree::resolved(repo.store().clone(), repo.store().empty_tree_id().clone()),
            )
            .set_description("rewritten later source")
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_wc_commit(workspace.workspace_name().to_owned(), next.id().clone())
            .unwrap();
        tx.commit("move source after publication")
            .block_on()
            .unwrap();
    }

    fn serve(
        listener: TcpListener,
        count: usize,
        reply: impl Fn(usize) -> Option<(u16, serde_json::Value)> + Send + 'static,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            for index in 0..count {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "timed out waiting for source publication HTTP request {index}"
                            );
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(error) => panic!("source publication HTTP accept failed: {error}"),
                    }
                };
                // BSD sockets inherit the listener's non-blocking mode on
                // accept; the request is read under the timeout below instead.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let mut raw = Vec::new();
                loop {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    raw.push(byte[0]);
                    assert!(raw.len() < 16_384);
                    if raw.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let headers = String::from_utf8(raw).unwrap();
                assert!(headers.starts_with("POST /api/repos/acme/widgets/workspaces/0f8fad5b-d9cb-469f-a165-70867728950e/head HTTP/1.1"));
                assert!(headers.contains("Authorization: Bearer sentinel-private-token"));
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                assert!(!String::from_utf8_lossy(&body).contains("sentinel-private-token"));
                if let Some((status, value)) = reply(index) {
                    let body = serde_json::to_vec(&value).unwrap();
                    write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                    stream.write_all(&body).unwrap();
                }
            }
        })
    }

    #[test]
    fn publication_replay_precedes_source_fence_and_only_explicit_missing_permits_push() {
        require_curl();
        for mode in [
            "replay",
            "missing",
            "generic404",
            "incomplete",
            "wrong-workspace",
        ] {
            let (temp, mut config, request) = fixture();
            let mut value = receipt(&config, &request.source);
            let status = match mode {
                "missing" => {
                    value = serde_json::json!({"code":"workspace_source_missing"});
                    404
                }
                "generic404" => {
                    value = serde_json::json!({"message":"old API"});
                    404
                }
                "incomplete" => {
                    value = serde_json::json!({"id":config.workspace_id});
                    200
                }
                "wrong-workspace" => {
                    value["retained_source"]["workspace_id"] = serde_json::json!("other");
                    200
                }
                _ => 200,
            };
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            config.api_base_url = format!("http://{}/api", listener.local_addr().unwrap());
            let server = serve(listener, 1, move |_| Some((status, value.clone())));
            move_source(temp.path());
            let result =
                publish_authenticated(temp.path(), &config, &request, "sentinel-private-token");
            server.join().unwrap();
            if mode == "replay" {
                assert_eq!(
                    result.unwrap()["source"]["commit_id"],
                    request.source.commit_id
                );
            } else {
                let error = result.unwrap_err();
                assert_eq!(
                    error.code,
                    if mode == "missing" {
                        "revision_conflict"
                    } else if mode == "wrong-workspace" {
                        "source_publication_invalid_ack"
                    } else {
                        "source_publication_unavailable"
                    }
                );
            }
        }
    }

    #[test]
    fn native_transport_and_authoritative_ack_recover_lost_ack_after_source_rewrite() {
        require_curl();
        let (temp, mut config, mut request) = fixture();
        let target = tempfile::TempDir::new().unwrap();
        let settings = create_settings(&UserConfig::default());
        Workspace::init_internal_git(&settings, target.path(), gix::hash::Kind::Sha1)
            .block_on()
            .unwrap();
        let (_, target_repo) = load_repo_at_head(target.path(), &settings).unwrap();
        config.git_url = target_repo
            .store()
            .backend_impl::<GitBackend>()
            .unwrap()
            .git_repo()
            .path()
            .to_str()
            .unwrap()
            .into();
        let (_, repo) = load_repo_at_head(temp.path(), &settings).unwrap();
        let mut tx = repo.start_transaction();
        git::add_remote(tx.repo_mut(), "origin".as_ref(), &config.git_url, None).unwrap();
        let repo = tx
            .commit("configure test native transport")
            .block_on()
            .unwrap();
        request.expected_operation_id = repo.operation().id().hex();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        config.api_base_url = format!("http://{}/api", listener.local_addr().unwrap());
        let path = target.path().to_owned();
        let native_request = serde_json::to_string(
            &serde_json::json!({"workspace_id":config.workspace_id,"source":request.source}),
        )
        .unwrap();
        let server = serve(listener, 3, move |index| {
            let path = CString::new(path.to_str().unwrap()).unwrap();
            let request = CString::new(native_request.as_str()).unwrap();
            let ptr = smithers_ffi::smithers_read_workspace_source(path.as_ptr(), request.as_ptr());
            let mut result: serde_json::Value =
                unsafe { serde_json::from_slice(CStr::from_ptr(ptr).to_bytes()).unwrap() };
            unsafe { smithers_ffi::smithers_free_string(ptr) };
            if index == 0 {
                assert_eq!(result["code"], "workspace_source_missing");
                return Some((404, result));
            }
            assert_eq!(
                result["status"], "retained",
                "transport must actually retain the native source before ACK"
            );
            if index == 1 {
                return None;
            } // accepted push, lost HTTP acknowledgement
            result["repository_id"] = serde_json::json!(200);
            Some((200, serde_json::json!({"retained_source":result})))
        });
        let error = publish_authenticated(temp.path(), &config, &request, "sentinel-private-token")
            .unwrap_err();
        assert_eq!(error.code, "source_publication_unavailable");
        move_source(temp.path());
        let recovered =
            publish_authenticated(temp.path(), &config, &request, "sentinel-private-token")
                .unwrap();
        server.join().unwrap();
        assert_eq!(recovered["source"]["commit_id"], request.source.commit_id);
        assert!(!recovered.to_string().contains("sentinel-private-token"));
        let (_, cloud) = load_repo_at_head(target.path(), &settings).unwrap();
        assert!(
            cloud.view().local_bookmarks().next().is_none(),
            "retention must not create visible history bookmarks"
        );
    }
    #[test]
    fn owned_created_source_is_published_without_moving_the_editor_and_proof_is_required_before_ack(
    ) {
        require_curl();
        let (temp, create_request) = crate::source_create::tests::fixture();
        let (_, mut config, _) = fixture();
        config.repository_path = temp.path().to_str().unwrap().into();
        let target = tempfile::TempDir::new().unwrap();
        let settings = create_settings(&UserConfig::default());
        Workspace::init_internal_git(&settings, target.path(), gix::hash::Kind::Sha1)
            .block_on()
            .unwrap();
        let (_, target_repo) = crate::source_create::load_single(target.path()).unwrap();
        config.git_url = target_repo
            .store()
            .backend_impl::<GitBackend>()
            .unwrap()
            .git_repo()
            .path()
            .to_str()
            .unwrap()
            .into();
        let (_, repo) = crate::source_create::load_single(temp.path()).unwrap();
        let mut tx = repo.start_transaction();
        git::add_remote(tx.repo_mut(), "origin".as_ref(), &config.git_url, None).unwrap();
        let repo = tx.commit("owned publication fixture").block_on().unwrap();
        let created = crate::source_create::create(
            temp.path(),
            crate::source_create::tests::owner(),
            crate::source_create::Request {
                expected_operation_id: repo.operation().id().hex(),
                ..create_request
            },
        )
        .unwrap();
        let source = serde_json::from_value(serde_json::json!({"change_id":created["source"]["changeId"], "commit_id":created["source"]["commitId"],
            "tree_id":created["source"]["treeId"], "parent_commit_ids":created["source"]["parentCommitIds"]})).unwrap();
        let mut request = Request {
            source,
            expected_operation_id: created["operationId"].as_str().unwrap().into(),
            creation: Some(crate::source_create::Proof {
                request_id: created["requestId"].as_str().unwrap().into(),
                request_digest: created["requestDigest"].as_str().unwrap().into(),
            }),
        };
        let (_, before) = crate::source_create::load_single(temp.path()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        config.api_base_url = format!("http://{}/api", listener.local_addr().unwrap());
        let path = target.path().to_owned();
        let native_request = serde_json::to_string(
            &serde_json::json!({"workspace_id":config.workspace_id,"source":request.source}),
        )
        .unwrap();
        let server = serve(listener, 3, move |index| {
            let path = CString::new(path.to_str().unwrap()).unwrap();
            let request = CString::new(native_request.as_str()).unwrap();
            let ptr = smithers_ffi::smithers_read_workspace_source(path.as_ptr(), request.as_ptr());
            let mut value: serde_json::Value =
                unsafe { serde_json::from_slice(CStr::from_ptr(ptr).to_bytes()).unwrap() };
            unsafe { smithers_ffi::smithers_free_string(ptr) };
            if index == 0 {
                assert_eq!(value["code"], "workspace_source_missing");
                return Some((404, value));
            }
            assert_eq!(value["status"], "retained");
            value["repository_id"] = serde_json::json!(200);
            Some((200, serde_json::json!({"retained_source":value})))
        });
        let accepted =
            publish_authenticated(temp.path(), &config, &request, "sentinel-private-token")
                .unwrap();
        assert_eq!(
            accepted["source"]["commit_id"],
            created["source"]["commitId"]
        );
        let (_, after) = crate::source_create::load_single(temp.path()).unwrap();
        assert_eq!(before.operation().id(), after.operation().id());
        assert_eq!(before.view().store_view(), after.view().store_view());
        after
            .start_transaction()
            .commit("later operation")
            .block_on()
            .unwrap();
        assert!(
            publish_authenticated(temp.path(), &config, &request, "sentinel-private-token").is_ok()
        );
        server.join().unwrap();
        // The HTTP server has ended: every tampered proof must fail locally,
        // even though the exact remote source now exists and could be ACKed.
        request.creation.as_mut().unwrap().request_digest = "f".repeat(64);
        assert_eq!(
            publish_authenticated(temp.path(), &config, &request, "sentinel-private-token")
                .unwrap_err()
                .code,
            "invalid_request"
        );
        request.creation.as_mut().unwrap().request_digest =
            created["requestDigest"].as_str().unwrap().into();
        config.actor_id += 1;
        assert_eq!(
            publish_authenticated(temp.path(), &config, &request, "sentinel-private-token")
                .unwrap_err()
                .code,
            "invalid_request"
        );
        config.actor_id -= 1;
        request.source.tree_id = "f".repeat(40);
        assert_eq!(
            publish_authenticated(temp.path(), &config, &request, "sentinel-private-token")
                .unwrap_err()
                .code,
            "invalid_request"
        );
    }
}
