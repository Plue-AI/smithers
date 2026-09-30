//! Native coding requests share the packaged helper and the JJ operation lock.
use base64::prelude::{Engine as _, BASE64_STANDARD};
use std::path::Path;
use std::process::Command;

use futures::StreamExt;
use jj_lib::backend::CommitId;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::Repo;
use pollster::FutureExt as _;
use serde_json::{json, Value};
use smithers_ffi::jj_core::{create_settings, load_repo_at_head, UserConfig};

use super::source_create;
use super::source_import;
use super::source_publish;
use super::workspace_engine::{commit, field, id, invalid, jj, CodingLock, Failure};
use super::workspace_files::FilePatch;

type Result<T> = std::result::Result<T, Failure>;
#[cfg(test)]
pub(super) static LOCAL_OWNER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(super) fn revision(repo: &Path, value: &Value, operation: &str) -> Result<Value> {
    let settings = create_settings(&UserConfig::default());
    let (_, loaded) = load_repo_at_head(repo, &settings)
        .map_err(|_| Failure::new("unsupported_jj", "native repository is unavailable"))?;
    let commit_id = CommitId::try_from_hex(id(value)?)
        .ok_or_else(|| Failure::new("revision_conflict", "invalid native commit ID"))?;
    let stored = loaded
        .store()
        .get_commit(&commit_id)
        .map_err(|_| Failure::new("revision_conflict", "native commit is unavailable"))?;
    let tree = stored.tree().tree_ids().clone();
    let shared = json!({"changeId":stored.change_id().reverse_hex(), "commitId":stored.id().hex(),
        "operationId":operation, "parentCommitIds":stored.parent_ids().iter().map(ObjectId::hex).collect::<Vec<_>>(),
        "description":stored.description()});
    let mut output = shared.as_object().unwrap().clone();
    if let Some(tree_id) = tree.as_resolved() {
        output.insert("kind".into(), json!("resolved"));
        output.insert("treeId".into(), json!(tree_id.hex()));
    } else {
        output.insert("kind".into(), json!("conflicted"));
        output.insert(
            "treeTerms".into(),
            json!(tree
                .iter()
                .enumerate()
                .map(|(index, term)| json!({"treeId":term.hex(), "positive":index % 2 == 0}))
                .collect::<Vec<_>>()),
        );
    }
    Ok(Value::Object(output))
}

fn read(repo: &Path, input: &Value) -> Result<Value> {
    let object = input
        .as_object()
        .ok_or_else(|| invalid("coding request must be an object"))?;
    if object.keys().any(|key| {
        !["operation", "repositoryPath", "changeIds", "historyLimit"].contains(&key.as_str())
    }) {
        return Err(invalid("read has unsupported fields"));
    }
    let requested = input
        .get("changeIds")
        .map(|value| {
            value
                .as_array()
                .ok_or_else(|| invalid("changeIds must be an array"))
        })
        .transpose()?
        .cloned()
        .unwrap_or_default();
    if requested.len() > 100 {
        return Err(invalid("read accepts at most 100 change IDs"));
    }
    let operation: Value = serde_json::from_str(&jj(
        repo,
        &["op", "log", "-n", "1", "--no-graph", "-T", "json(self)"],
        false,
    )?)
    .map_err(|_| Failure::new("unsupported_jj", "native operation has no identity"))?;
    let operation_id = field(&operation, "id")?;
    let head = revision(repo, &commit(repo, "@")?, operation_id)?;
    let mut revisions = Vec::new();
    for selected in requested {
        let change_id = selected
            .as_str()
            .ok_or_else(|| invalid("change ID must be a string"))?;
        if change_id.len() != 32 || !change_id.bytes().all(|byte| (b'k'..=b'z').contains(&byte)) {
            return Err(invalid("read requires full native change IDs"));
        }
        let selector = format!("change_id(\"{change_id}\")");
        revisions.push(revision(repo, &commit(repo, &selector)?, operation_id)?);
    }
    let mut capabilities = vec!["apply-files/v1", "create-source/v1"];
    if source_import::available(repo) {
        capabilities.push("import-source/v1");
    }
    let mut result = json!({"status":"read", "operationId":operation_id, "head":head,
        "revisions":revisions, "capabilities":capabilities});
    if let Some(limit) = input.get("historyLimit") {
        let count = limit
            .as_u64()
            .filter(|value| (1..=1024).contains(value))
            .ok_or_else(|| invalid("historyLimit must be 1 to 1024"))?;
        let revset = format!("ancestors(@, {}) ~ root()", count + 1);
        let bound = (count + 1).to_string();
        let output = jj(
            repo,
            &[
                "log",
                "-r",
                &revset,
                "--no-graph",
                "-T",
                "commit_id ++ \"\\n\"",
                "-n",
                &bound,
            ],
            false,
        )?;
        let commits: Vec<_> = output.lines().collect();
        let complete = commits.len() <= count as usize;
        let history = commits
            .into_iter()
            .take(count as usize)
            .rev()
            .map(|selected| revision(repo, &commit(repo, selected)?, operation_id))
            .collect::<Result<Vec<_>>>()?;
        result["history"] = json!(history);
        result["historyComplete"] = json!(complete);
    }
    Ok(result)
}

pub(super) fn operation(repo: &Path) -> Result<Value> {
    serde_json::from_str(&jj(
        repo,
        &["op", "log", "-n", "1", "--no-graph", "-T", "json(self)"],
        false,
    )?)
    .map_err(|_| Failure::new("unsupported_jj", "native operation has no identity"))
}

fn expected_revision(repo: &Path, input: &Value, name: &str, at: &str) -> Result<Value> {
    let expected = input
        .get(name)
        .ok_or_else(|| invalid("native operation lacks an expected revision"))?;
    let change_id = field(expected, "changeId")?;
    if change_id.len() != 32 || !change_id.bytes().all(|byte| (b'k'..=b'z').contains(&byte)) {
        return Err(invalid("native revision requires a full change ID"));
    }
    let selector = format!("change_id(\"{change_id}\")");
    let actual = revision(repo, &commit(repo, &selector)?, at)?;
    for key in [
        "changeId",
        "commitId",
        "treeId",
        "operationId",
        "parentCommitIds",
    ] {
        if actual.get(key) != expected.get(key) {
            return Err(Failure::new(
                "revision_conflict",
                "exact native revision changed; read and replan",
            ));
        }
    }
    if actual["kind"] != "resolved" {
        return Err(Failure::new(
            "revision_conflict",
            "conflicted revision cannot be mutated",
        ));
    }
    Ok(actual)
}

fn projection_marker(repo: &Path, input: &Value) -> Option<String> {
    let owner = local_owner(repo).ok()?;
    let mut request =
        json!({"operation":input["operation"], "expectedOperationId":input["expectedOperationId"]});
    for name in ["target", "source", "after"] {
        if let Some(value) = input.get(name) {
            request[name] = json!({"changeId":value["changeId"], "commitId":value["commitId"]});
        }
    }
    let encoded = BASE64_STANDARD.encode(
        json!({"version":1, "workspaceId":owner.workspace_id, "request":request}).to_string(),
    );
    Some(format!("smithers.coding-projection=\"{encoded}\""))
}

fn mutate_command(
    repo: &Path,
    marker: &str,
    projection: Option<&str>,
    args: &[String],
) -> Result<()> {
    let mut command = Command::new("jj");
    command
        .arg("-R")
        .arg(repo)
        .args(["--no-pager", "--color=never", "--config", marker]);
    if let Some(value) = projection {
        command.args(["--config", value]);
    }
    let output = command
        .args(args)
        .env("JJ_EDITOR", "false")
        .env("PAGER", "cat")
        .current_dir(repo)
        .output()
        .map_err(|_| Failure::new("unsupported_jj", "JJ is unavailable"))?;
    if !output.status.success() {
        return Err(Failure::new(
            "jj_conflict",
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(2000)
                .collect::<String>(),
        ));
    }
    Ok(())
}

fn receipt(repo: &Path, request_id: &str, digest: &str) -> Result<Option<Value>> {
    let output = jj(
        repo,
        &["op", "log", "--no-graph", "-T", "json(self) ++ \"\\n\""],
        false,
    )?;
    let mut found = None;
    for line in output.lines() {
        let operation: Value = serde_json::from_str(line)
            .map_err(|_| Failure::new("unsupported_jj", "JJ operation log is invalid"))?;
        let args = operation_args(&operation);
        // Only the helper's config argument is a receipt. The later -m argument
        // can contain arbitrary user text, including another request UUID.
        let recorded = args
            .split_once(" --no-pager '--color=never' --config 'smithers.coding-request=\"")
            .and_then(|(_, rest)| rest.split_once("\"'"))
            .and_then(|(value, _)| value.split_once(':'))
            .filter(|(id, hash)| {
                id.len() == 36
                    && hash.len() == 64
                    && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        if recorded == Some((request_id, digest)) {
            if found.is_some() {
                return Err(Failure::new(
                    "operation_conflict",
                    "multiple operations carry this native receipt",
                ));
            }
            found = Some(operation);
        } else if recorded.is_some_and(|(id, _)| id == request_id) {
            return Err(Failure::new(
                "request_conflict",
                "request ID was used for different content",
            ));
        }
    }
    Ok(found)
}

fn operation_args(operation: &Value) -> &str {
    operation
        .pointer("/attributes/args")
        .or_else(|| operation.pointer("/tags/args"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn mutate(repo: &Path, input: &Value) -> Result<Value> {
    let kind = field(input, "operation")?;
    let request_id = field(input, "requestId")?;
    let expected_op = field(input, "expectedOperationId")?;
    if expected_op.len() != 128
        || !expected_op
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || request_id.len() != 36
        || !request_id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
    {
        return Err(invalid(
            "native mutation needs an exact operation ID and request UUID",
        ));
    }
    let encoded = serde_json::to_vec(input).map_err(|_| invalid("invalid native operation"))?;
    let mut sha = gix::hash::hasher(gix::hash::Kind::Sha256);
    sha.update(&encoded);
    let digest = sha
        .try_finalize()
        .expect("SHA256 is infallible")
        .to_string();
    if kind == "apply_files" {
        return apply_files(repo, input, &digest);
    }
    if let Some(previous) = receipt(repo, request_id, &digest)? {
        return mutation_result(repo, input, &previous, true);
    }
    let before = operation(repo)?;
    let before_id = field(&before, "id")?;
    if before_id != expected_op {
        return Err(Failure::new(
            "operation_conflict",
            "operation head changed; read and replan",
        ));
    }
    let target = expected_revision(repo, input, "target", before_id)?;
    let target_id = field(&target, "commitId")?;
    let head = commit(repo, "@")?;
    let marker = format!("smithers.coding-request=\"{request_id}:{digest}\"");
    let description = input
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    if description.len() > 16 << 10 || description.contains('\0') {
        return Err(invalid("description is not bounded"));
    }
    let source = if kind == "amend" {
        Some(expected_revision(repo, input, "source", before_id)?)
    } else {
        None
    };
    let after = if kind == "reorder" {
        Some(expected_revision(repo, input, "after", before_id)?)
    } else {
        None
    };
    let command: Vec<String> = match kind {
        "snapshot" => {
            if id(&head)? != target_id {
                return Err(Failure::new(
                    "revision_conflict",
                    "snapshot target must be the working-copy revision",
                ));
            }
            vec!["status"]
        }
        "create" => vec!["new", "--insert-after", target_id, "-m", description],
        "describe" => {
            if target["description"].as_str().unwrap_or("").trim_end() == description.trim_end() {
                return Ok(
                    json!({"status":"unchanged", "operationId":before_id, "revision":target}),
                );
            }
            vec!["describe", target_id, "-m", description]
        }
        "edit" => {
            if id(&head)? == target_id {
                return Ok(
                    json!({"status":"unchanged", "operationId":before_id, "revision":target}),
                );
            }
            vec!["edit", target_id]
        }
        "amend" => {
            vec![
                "squash",
                "--from",
                field(source.as_ref().unwrap(), "commitId")?,
                "--into",
                target_id,
                "--keep-emptied",
                "--use-destination-message",
            ]
        }
        "reorder" => {
            vec![
                "rebase",
                "--revisions",
                target_id,
                "--insert-after",
                field(after.as_ref().unwrap(), "commitId")?,
            ]
        }
        _ => return Err(invalid("unsupported native mutation")),
    }
    .into_iter()
    .map(str::to_owned)
    .collect();
    // A pending editor write must become its own operation before any planned
    // history rewrite. The caller then refreshes its exact base.
    if !["snapshot"].contains(&kind) {
        jj(repo, &["status"], true)?;
        if field(&operation(repo)?, "id")? != before_id {
            return Err(Failure::new(
                "dirty_workspace",
                "working files were snapshotted; read and replan",
            ));
        }
    }
    let projection = projection_marker(repo, input);
    mutate_command(repo, &marker, projection.as_deref(), &command)?;
    match receipt(repo, request_id, &digest)? {
        Some(accepted) => mutation_result(repo, input, &accepted, false),
        None if field(&operation(repo)?, "id")? == before_id => {
            Ok(json!({"status":"unchanged", "operationId":before_id, "revision":target}))
        }
        None => Err(Failure::new(
            "operation_conflict",
            "native operation has no recoverable receipt",
        )),
    }
}

fn apply_files(repo: &Path, input: &Value, digest: &str) -> Result<Value> {
    let request_id = field(input, "requestId")?;
    let expected_op = field(input, "expectedOperationId")?;
    let patch = FilePatch::new(repo, request_id, digest, input)?;
    if let Some(previous) = receipt(repo, request_id, digest)? {
        patch.prepare()?;
        let mut result = mutation_result(repo, input, &previous, true)?;
        verify_file_snapshot(repo, input, &patch, &result)?;
        result["recovery"] = patch.recovery();
        return Ok(result);
    }
    let before = operation(repo)?;
    let before_id = field(&before, "id")?;
    if before_id != expected_op {
        return Err(Failure::new(
            "operation_conflict",
            "operation head changed; read and replan",
        ));
    }
    let target = expected_revision(repo, input, "target", before_id)?;
    if field(&target, "commitId")? != id(&commit(repo, "@")?)? {
        return Err(Failure::new(
            "revision_conflict",
            "file patch target must be the working-copy revision",
        ));
    }
    let fresh = patch.prepare()?;
    if fresh {
        jj(repo, &["status"], true)?;
        if field(&operation(repo)?, "id")? != before_id {
            return Err(Failure::new(
                "revision_conflict",
                "working files were snapshotted; read and replan",
            )
            .with_recovery(patch.recovery()));
        }
        patch.install()?;
    }
    if field(&operation(repo)?, "id")? != before_id {
        return Err(Failure::new(
            "operation_conflict",
            "native owner changed before file snapshot",
        )
        .with_recovery(patch.recovery()));
    }
    patch.verify()?;
    let marker = format!("smithers.coding-request=\"{request_id}:{digest}\"");
    let projection = projection_marker(repo, input);
    mutate_command(repo, &marker, projection.as_deref(), &["status".into()])?;
    let accepted = receipt(repo, request_id, digest)?.ok_or_else(|| {
        Failure::new(
            "file_recovery_required",
            "files were retained but JJ did not create a receipt",
        )
        .with_recovery(patch.recovery())
    })?;
    patch.verify()?;
    let mut result = mutation_result(repo, input, &accepted, false)?;
    verify_file_snapshot(repo, input, &patch, &result)?;
    result["recovery"] = patch.recovery();
    Ok(result)
}

fn verify_file_snapshot(
    repo: &Path,
    input: &Value,
    patch: &FilePatch,
    result: &Value,
) -> Result<()> {
    let before = field(&input["target"], "commitId")?;
    let after = field(&result["revision"], "commitId")?;
    if result["revision"]["changeId"] != input["target"]["changeId"]
        || result["revision"]["parentCommitIds"] != input["target"]["parentCommitIds"]
    {
        return Err(
            Failure::new("file_conflict", "file snapshot changed its native owner")
                .with_recovery(patch.recovery()),
        );
    }
    let changed = changed_paths(repo, before, after)?;
    if changed
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>()
        != patch.paths()
    {
        return Err(Failure::new(
            "file_conflict",
            "native snapshot includes other files or omits proposed files",
        )
        .with_recovery(patch.recovery()));
    }
    Ok(())
}

/// Paths whose tree entries differ between two immutable commits. Compares
/// native tree entries, so a rename is its source and target paths rather
/// than one rendered `{old => new}` row.
fn changed_paths(
    repo: &Path,
    before: &str,
    after: &str,
) -> Result<std::collections::HashSet<String>> {
    let settings = create_settings(&UserConfig::default());
    let (_, loaded) = load_repo_at_head(repo, &settings)
        .map_err(|_| Failure::new("unsupported_jj", "native repository is unavailable"))?;
    let tree = |value: &str| {
        let commit_id = CommitId::try_from_hex(value)
            .ok_or_else(|| Failure::new("revision_conflict", "invalid native commit ID"))?;
        loaded
            .store()
            .get_commit(&commit_id)
            .map(|stored| stored.tree())
            .map_err(|_| Failure::new("revision_conflict", "native commit is unavailable"))
    };
    let (from, to) = (tree(before)?, tree(after)?);
    let mut stream = from.diff_stream(&to, &jj_lib::matchers::EverythingMatcher);
    let mut changed = std::collections::HashSet::new();
    while let Some(entry) = stream.next().block_on() {
        entry
            .values
            .map_err(|_| Failure::new("unsupported_jj", "native tree diff is unavailable"))?;
        changed.insert(entry.path.as_internal_file_string().to_owned());
    }
    Ok(changed)
}

fn mutation_result(repo: &Path, input: &Value, receipt: &Value, replayed: bool) -> Result<Value> {
    let at = field(receipt, "id")?;
    let parents = receipt
        .get("parents")
        .and_then(Value::as_array)
        .ok_or_else(|| Failure::new("unsupported_jj", "operation has no parents"))?;
    if parents.len() != 1 || parents[0] != input["expectedOperationId"] {
        return Err(Failure::new(
            "operation_conflict",
            "another operation intervened before native mutation",
        ));
    }
    let kind = field(input, "operation")?;
    let selector = if ["create", "snapshot", "apply_files"].contains(&kind) {
        "@".to_owned()
    } else {
        format!("change_id(\"{}\")", field(&input["target"], "changeId")?)
    };
    // A receipt pins an immutable operation. These selectors must be read in
    // that view even if unrelated operations have since moved the live head.
    let target: Value = serde_json::from_str(&jj_at(
        repo,
        at,
        &["log", "-r", &selector, "--no-graph", "-T", "json(self)"],
    )?)
    .map_err(|_| Failure::new("revision_conflict", "receipt target is unavailable"))?;
    let head: Value = serde_json::from_str(&jj_at(
        repo,
        at,
        &["log", "-r", "@", "--no-graph", "-T", "json(self)"],
    )?)
    .map_err(|_| Failure::new("revision_conflict", "receipt head is unavailable"))?;
    let changed = revision(repo, &target, at)?;
    Ok(
        json!({"status":"accepted", "replayed":replayed, "operationId":at,
        "parentOperationId":parents[0], "timestamp":receipt.pointer("/time/end").and_then(Value::as_str).unwrap_or(""),
        "head":revision(repo, &head, at)?, "revision":changed, "revisions":[changed]}),
    )
}

pub(super) fn jj_at(repo: &Path, op: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("jj")
        .arg("-R")
        .arg(repo)
        .args(["--no-pager", "--color=never", "--ignore-working-copy"])
        .arg(format!("--at-op={op}"))
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|_| Failure::new("unsupported_jj", "JJ is unavailable"))?;
    if !output.status.success() {
        return Err(Failure::new(
            "jj_conflict",
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| Failure::new("unsupported_jj", "JJ returned non-UTF8 output"))
}

pub(super) fn local_owner(repo: &Path) -> Result<source_create::Owner> {
    if let Ok(owner) = source_create::provisioned_owner(repo) {
        return Ok(owner);
    }
    if std::env::var("SMITHERS_CODING_LOCAL_OWNER").as_deref() != Ok("1") {
        return Err(Failure::new(
            "source_creation_unavailable",
            "native source owner is not configured",
        ));
    }
    let root = repo
        .canonicalize()
        .map_err(|_| invalid("repository root is unavailable"))?;
    let mut sha = gix::hash::hasher(gix::hash::Kind::Sha256);
    sha.update(root.to_string_lossy().as_bytes());
    let hex = sha
        .try_finalize()
        .expect("SHA256 is infallible")
        .to_string();
    let uuid = format!(
        "{}-{}-4{}-8{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    );
    Ok(source_create::Owner {
        workspace_id: uuid,
        repository_id: 1,
        actor_id: 1,
    })
}

fn create_source(repo: &Path, input: &Value) -> Result<Value> {
    let base = input
        .get("base")
        .ok_or_else(|| invalid("source creation requires a base"))?;
    let files = input
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("source creation requires files"))?;
    let payload = json!({"request_id":field(input, "requestId")?,
        "expected_operation_id":field(input, "expectedOperationId")?,
        "base":{"change_id":field(base, "changeId")?, "commit_id":field(base, "commitId")?,
            "tree_id":field(base, "treeId")?, "parent_commit_ids":base["parentCommitIds"]},
        "description":field(input, "description")?,
        "files":files.iter().map(|file| json!({"path":file["path"], "before_digest":file["beforeDigest"],
            "content":file["content"]})).collect::<Vec<_>>()});
    let request: source_create::Request = serde_json::from_value(payload)
        .map_err(|_| invalid("source creation has invalid native fields"))?;
    let owner = local_owner(repo)?;
    let mut result = source_create::create(repo, owner, request)
        .map_err(|error| Failure::new(error.code, error.message))?;
    result["base"] = json!({"changeId":base["changeId"], "commitId":base["commitId"],
        "treeId":base["treeId"], "parentCommitIds":base["parentCommitIds"]});
    Ok(result)
}

fn publish_source(repo: &Path, input: &Value) -> Result<Value> {
    let source = input
        .get("source")
        .ok_or_else(|| invalid("source publication requires an immutable source"))?;
    let payload = json!({"source":{"change_id":field(source, "changeId")?,
        "commit_id":field(source, "commitId")?, "tree_id":field(source, "treeId")?,
        "parent_commit_ids":source["parentCommitIds"]},
        "expected_operation_id":field(source, "operationId")?, "creation":input.get("creation")});
    let raw = serde_json::to_vec(&payload).map_err(|_| invalid("invalid source publication"))?;
    let published = source_publish::run_bytes(repo, &raw)
        .map_err(|error| Failure::new(error.code, error.message))?;
    let owner = local_owner(repo)?;
    let expected_ref = format!(
        "refs/smithers/workspaces/{}/sources/{}",
        owner.workspace_id,
        field(source, "commitId")?
    );
    if published["status"] != "retained"
        || published["ref"] != expected_ref
        || published["workspace_id"] != owner.workspace_id
        || published["repository_id"] != owner.repository_id
    {
        return Err(Failure::new(
            "source_publication_invalid_ack",
            "source publication did not acknowledge the exact owner",
        ));
    }
    Ok(
        json!({"status":"retained", "requestId":field(input, "requestId")?,
        "workspaceId":owner.workspace_id, "repositoryId":owner.repository_id,
        "ref":expected_ref, "source":{"changeId":source["changeId"], "commitId":source["commitId"],
            "treeId":source["treeId"], "parentCommitIds":source["parentCommitIds"]}}),
    )
}

pub fn run(raw: &[u8]) -> Result<Value> {
    let input: Value =
        serde_json::from_slice(raw).map_err(|_| invalid("coding request is not JSON"))?;
    let repo = Path::new(field(&input, "repositoryPath")?);
    if !repo.is_absolute() {
        return Err(invalid("repository path must be absolute"));
    }
    let _lock = CodingLock::acquire(repo)?;
    match field(&input, "operation")? {
        "read" => read(repo, &input),
        "snapshot" | "create" | "describe" | "edit" | "amend" | "reorder" | "apply_files" => {
            mutate(repo, &input)
        }
        "create_source" => create_source(repo, &input),
        "publish_source" => publish_source(repo, &input),
        "import_source" => source_import::run(repo, &input),
        _ => Err(invalid("unsupported local coding operation")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    #[test]
    fn operation_args_supports_old_and_new_jj_receipts() {
        let args = "jj --no-pager '--color=never' --config 'smithers.coding-request=\"11111111-1111-4111-8111-111111111111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"'";
        for operation in [
            json!({"tags":{"args":args}}),
            json!({"attributes":{"args":args}}),
        ] {
            assert_eq!(operation_args(&operation), args);
        }
        assert_eq!(operation_args(&json!({"attributes":{"args":42}})), "");
        assert_eq!(operation_args(&json!({})), "");
    }

    #[test]
    fn reads_the_actual_jj_head_and_history() {
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        std::fs::write(dir.path().join("one.txt"), "one").unwrap();
        super::super::workspace_engine::run(
            serde_json::to_string(&json!({
                "operation":"snapshot", "repositoryPath":dir.path()
            }))
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
        let result = run(serde_json::to_string(&json!({
            "operation":"read", "repositoryPath":dir.path(), "historyLimit":1
        }))
        .unwrap()
        .as_bytes())
        .unwrap();
        assert_eq!(result["status"], "read");
        assert_eq!(result["head"]["kind"], "resolved");
        assert_eq!(result["history"].as_array().unwrap().len(), 1);
        assert_eq!(result["history"][0]["commitId"], result["head"]["commitId"]);
    }

    #[test]
    fn create_and_describe_replay_from_jj_operation_receipts() {
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        let first = run(serde_json::to_string(
            &json!({"operation":"read", "repositoryPath":dir.path()}),
        )
        .unwrap()
        .as_bytes())
        .unwrap();
        let request = json!({"operation":"create", "repositoryPath":dir.path(),
            "requestId":"11111111-1111-4111-8111-111111111111", "expectedOperationId":first["operationId"],
            "target":first["head"], "description":"first change"});
        let created = run(serde_json::to_string(&request).unwrap().as_bytes()).unwrap();
        assert_eq!(created["status"], "accepted");
        assert_eq!(
            created["revision"]["description"]
                .as_str()
                .unwrap()
                .trim_end(),
            "first change"
        );
        let replay = run(serde_json::to_string(&request).unwrap().as_bytes()).unwrap();
        assert_eq!(replay["status"], "accepted");
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["operationId"], created["operationId"]);
        let description = json!({"operation":"describe", "repositoryPath":dir.path(),
            "requestId":"22222222-2222-4222-8222-222222222222", "expectedOperationId":created["operationId"],
            "target":created["head"], "description":"renamed change"});
        let described = run(serde_json::to_string(&description).unwrap().as_bytes()).unwrap();
        assert_eq!(described["status"], "accepted");
        assert_eq!(
            described["revision"]["description"]
                .as_str()
                .unwrap()
                .trim_end(),
            "renamed change"
        );
    }

    #[test]
    fn description_uuid_does_not_reserve_another_native_request() {
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        let first = run(serde_json::to_string(&json!({
            "operation":"read", "repositoryPath":dir.path()
        }))
        .unwrap()
        .as_bytes())
        .unwrap();
        let original = json!({"operation":"create", "repositoryPath":dir.path(),
            "requestId":"11111111-1111-4111-8111-111111111111",
            "expectedOperationId":first["operationId"], "target":first["head"],
            "description":"Related request 22222222-2222-4222-8222-222222222222"});
        let created = run(serde_json::to_string(&original).unwrap().as_bytes()).unwrap();
        assert_eq!(created["status"], "accepted");
        let replay = run(serde_json::to_string(&original).unwrap().as_bytes()).unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["operationId"], created["operationId"]);
        let mut changed = original.clone();
        changed["description"] = json!("different payload");
        assert_eq!(
            run(serde_json::to_string(&changed).unwrap().as_bytes())
                .unwrap_err()
                .code,
            "request_conflict"
        );

        let next = json!({"operation":"create", "repositoryPath":dir.path(),
            "requestId":"22222222-2222-4222-8222-222222222222",
            "expectedOperationId":created["operationId"], "target":created["head"],
            "description":"another change"});
        let accepted = run(serde_json::to_string(&next).unwrap().as_bytes()).unwrap();
        assert_eq!(accepted["status"], "accepted");
        assert_eq!(accepted["replayed"], false);
        let replay = run(serde_json::to_string(&next).unwrap().as_bytes()).unwrap();
        assert_eq!(replay["replayed"], true);
        let mut changed = next.clone();
        changed["description"] = json!("changed again");
        assert_eq!(
            run(serde_json::to_string(&changed).unwrap().as_bytes())
                .unwrap_err()
                .code,
            "request_conflict"
        );
    }

    #[test]
    fn apply_files_retains_preimage_and_replays_the_same_native_receipt() {
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        let read = run(serde_json::to_string(
            &json!({"operation":"read", "repositoryPath":dir.path()}),
        )
        .unwrap()
        .as_bytes())
        .unwrap();
        let request = json!({"operation":"apply_files", "repositoryPath":dir.path(),
            "requestId":"33333333-3333-4333-8333-333333333333", "expectedOperationId":read["operationId"],
            "target":read["head"], "files":[{"path":"src/hello.txt", "beforeDigest":null, "content":"hello\n"}]});
        let applied = run(serde_json::to_string(&request).unwrap().as_bytes()).unwrap();
        assert_eq!(applied["status"], "accepted");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src/hello.txt")).unwrap(),
            "hello\n"
        );
        let replay = run(serde_json::to_string(&request).unwrap().as_bytes()).unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["operationId"], applied["operationId"]);
        assert!(replay["recovery"]["files"][0]["proposed"]
            .as_str()
            .is_some());
    }

    fn snapshot_seeded(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        for (path, content) in files {
            let path = dir.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        super::super::workspace_engine::run(
            serde_json::to_string(&json!({
                "operation":"snapshot", "repositoryPath":dir.path()
            }))
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn apply_files_rename_returns_and_replays_native_receipt() {
        // JJ renders delete plus same-bytes create as one `R {old => new}`
        // summary row; the receipt must still verify against both paths.
        for (index, (old, new)) in [("old.txt", "new.txt"), ("old.txt", "moved/deep/new.txt")]
            .into_iter()
            .enumerate()
        {
            let dir = snapshot_seeded(&[(old, "before\n"), ("keep.txt", "keep\n")]);
            let read = run(serde_json::to_string(
                &json!({"operation":"read", "repositoryPath":dir.path()}),
            )
            .unwrap()
            .as_bytes())
            .unwrap();
            let request = json!({"operation":"apply_files", "repositoryPath":dir.path(),
                "requestId":format!("88888888-8888-4888-8888-88888888888{index}"),
                "expectedOperationId":read["operationId"], "target":read["head"],
                "files":[
                    {"path":old, "beforeDigest":super::super::workspace_files::hash(b"before\n"), "content":null},
                    {"path":new, "beforeDigest":null, "content":"before\n"}]});
            let applied = run(serde_json::to_string(&request).unwrap().as_bytes()).unwrap();
            assert_eq!(applied["status"], "accepted");
            assert_eq!(applied["replayed"], false);
            assert!(!dir.path().join(old).exists());
            assert_eq!(
                std::fs::read_to_string(dir.path().join(new)).unwrap(),
                "before\n"
            );
            let replay = run(serde_json::to_string(&request).unwrap().as_bytes()).unwrap();
            assert_eq!(replay["status"], "accepted");
            assert_eq!(replay["replayed"], true);
            assert_eq!(replay["operationId"], applied["operationId"]);
            assert_eq!(replay["revision"], applied["revision"]);
        }
    }

    #[test]
    fn changed_paths_lists_rename_endpoints_and_unrelated_files() {
        let dir = snapshot_seeded(&[("old.txt", "before\n"), ("keep.txt", "keep\n")]);
        let before = commit(dir.path(), "@").unwrap();
        std::fs::remove_file(dir.path().join("old.txt")).unwrap();
        std::fs::create_dir_all(dir.path().join("a")).unwrap();
        std::fs::write(dir.path().join("a/new.txt"), "before\n").unwrap();
        std::fs::write(dir.path().join("keep.txt"), "changed\n").unwrap();
        jj(dir.path(), &["status"], true).unwrap();
        let after = commit(dir.path(), "@").unwrap();
        let changed = changed_paths(dir.path(), id(&before).unwrap(), id(&after).unwrap()).unwrap();
        // An unrelated edit stays visible, so verification still refuses a
        // snapshot that includes other files.
        assert_eq!(
            changed,
            ["old.txt", "a/new.txt", "keep.txt"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
        assert_eq!(
            changed_paths(dir.path(), "zz", id(&after).unwrap())
                .unwrap_err()
                .code,
            "revision_conflict"
        );
    }

    #[test]
    fn apply_files_retains_existing_bytes_and_refuses_a_stale_digest() {
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        std::fs::write(dir.path().join("note.txt"), "old\n").unwrap();
        super::super::workspace_engine::run(
            serde_json::to_string(&json!({
                "operation":"snapshot", "repositoryPath":dir.path()
            }))
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
        let read = run(serde_json::to_string(
            &json!({"operation":"read", "repositoryPath":dir.path()}),
        )
        .unwrap()
        .as_bytes())
        .unwrap();
        let before = super::super::workspace_files::hash(b"old\n");
        let request = json!({"operation":"apply_files", "repositoryPath":dir.path(),
            "requestId":"44444444-4444-4444-8444-444444444444", "expectedOperationId":read["operationId"],
            "target":read["head"], "files":[{"path":"note.txt", "beforeDigest":before, "content":"new\n"}]});
        let applied = run(serde_json::to_string(&request).unwrap().as_bytes()).unwrap();
        let saved = applied["recovery"]["files"][0]["preimage"]
            .as_str()
            .unwrap();
        assert_eq!(std::fs::read_to_string(saved).unwrap(), "old\n");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "new\n"
        );
        let mut stale = request.clone();
        stale["requestId"] = json!("55555555-5555-4555-8555-555555555555");
        stale["expectedOperationId"] = applied["operationId"].clone();
        stale["target"] = applied["head"].clone();
        assert_eq!(
            run(serde_json::to_string(&stale).unwrap().as_bytes())
                .unwrap_err()
                .code,
            "file_conflict"
        );
    }

    #[test]
    fn apply_files_rejects_case_alias_metadata_without_mutation() {
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", "--colocate", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        let read = run(serde_json::to_string(&json!({
            "operation":"read", "repositoryPath":dir.path()
        }))
        .unwrap()
        .as_bytes())
        .unwrap();

        for (index, (actual, alias)) in [
            (".git/config", ".GIT/config"),
            (".jj/working_copy/type", ".JJ/working_copy/type"),
        ]
        .into_iter()
        .enumerate()
        {
            let actual = dir.path().join(actual);
            let alias_path = dir.path().join(alias);
            let original = std::fs::read(&actual).unwrap();
            let mut changed = original.clone();
            changed.extend_from_slice(b"\n# rejected metadata patch\n");
            let request = json!({"operation":"apply_files", "repositoryPath":dir.path(),
                "requestId":format!("77777777-7777-4777-8777-77777777777{index}"),
                "expectedOperationId":read["operationId"], "target":read["head"],
                "files":[{"path":alias, "beforeDigest":super::super::workspace_files::hash(&original),
                    "content":String::from_utf8(changed.clone()).unwrap()}]});
            assert_eq!(
                run(serde_json::to_string(&request).unwrap().as_bytes())
                    .unwrap_err()
                    .code,
                "invalid_request"
            );
            assert_eq!(std::fs::read(&actual).unwrap(), original);
            if alias_path.exists() {
                assert_eq!(std::fs::read(&alias_path).unwrap(), original);
            }
        }
    }

    #[test]
    fn create_source_keeps_the_editor_head_and_creates_an_immutable_child() {
        let _guard = LOCAL_OWNER_TEST_LOCK.lock().unwrap();
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(output.status.success());
        let read = run(serde_json::to_string(
            &json!({"operation":"read", "repositoryPath":dir.path()}),
        )
        .unwrap()
        .as_bytes())
        .unwrap();
        // The local owner is explicit; Plue obtains its owner from its protected guest config.
        unsafe {
            std::env::set_var("SMITHERS_CODING_LOCAL_OWNER", "1");
        }
        let request = json!({"operation":"create_source", "repositoryPath":dir.path(),
            "requestId":"66666666-6666-4666-8666-666666666666", "expectedOperationId":read["operationId"],
            "base":read["head"], "description":"isolated source",
            "files":[{"path":"source.txt", "beforeDigest":null, "content":"source\n"}]});
        let result = run(serde_json::to_string(&request).unwrap().as_bytes()).unwrap();
        unsafe {
            std::env::remove_var("SMITHERS_CODING_LOCAL_OWNER");
        }
        assert_eq!(result["status"], "created");
        assert_eq!(result["base"]["commitId"], read["head"]["commitId"]);
        assert_eq!(result["head"]["commitId"], read["head"]["commitId"]);
        assert_ne!(result["source"]["commitId"], result["head"]["commitId"]);
    }
}
