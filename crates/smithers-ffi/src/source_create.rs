//! A checked immutable child, without changing any editing workspace.
//! The native operation is both the mutation and its retry/publication receipt.
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use futures::StreamExt;
use jj_lib::backend::{CommitId, CopyId, TreeValue};
use jj_lib::default_backend_factories::{
    default_backend_factories, default_working_copy_factories,
};
use jj_lib::merged_tree::MergedTree;
use jj_lib::object_id::ObjectId;
use jj_lib::operation::Operation;
use jj_lib::repo::{ReadonlyRepo, Repo};
use jj_lib::repo_path::RepoPathBuf;
use jj_lib::tree_builder::TreeBuilder;
use jj_lib::workspace::Workspace;
use pollster::FutureExt as _;
use serde::{Deserialize, Serialize};
use smithers_ffi::jj_core::{create_settings, read_file_content, UserConfig};
use smithers_ffi::workspace_source::{source_ref, Source};

const ATTRIBUTE: &str = "smithers.source-create/v1";
const MAX_FILES: usize = 30;
const MAX_BYTES: usize = 256 * 1024;
const MAX_OPERATIONS: usize = 100_000;

#[derive(Debug, Serialize)]
pub struct Failure {
    pub code: &'static str,
    pub message: &'static str,
}
type Result<T> = std::result::Result<T, Failure>;
fn invalid() -> Failure {
    Failure {
        code: "invalid_request",
        message: "Invalid bounded native source request",
    }
}
fn conflict() -> Failure {
    Failure {
        code: "operation_conflict",
        message: "Native operation changed; retain the draft and inspect before retrying",
    }
}
fn unavailable() -> Failure {
    Failure {
        code: "source_creation_unavailable",
        message: "Native source creation could not be verified",
    }
}
fn receipt_invalid() -> Failure {
    Failure {
        code: "source_creation_invalid_receipt",
        message: "Native creation receipt does not authorize this exact source",
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub workspace_id: String,
    pub repository_id: i64,
    pub actor_id: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    version: u32,
    workspace_id: String,
    repository_id: i64,
    actor_id: i64,
    repository_path: String,
}

/// Check the fixed root-owned binding without following a replaceable symlink.
#[cfg(unix)]
pub fn read_provisioned_config<T: serde::de::DeserializeOwned>() -> Result<T> {
    #[cfg(feature = "trusted-process-binding")]
    if let Some(filename) = std::env::var_os(TRUSTED_PROCESS_BINDING) {
        return read_trusted_process_config(Path::new(&filename));
    }
    use std::os::unix::fs::MetadataExt;
    let directory = Path::new("/etc/smithers");
    for parent in [Path::new("/etc"), directory] {
        let metadata = std::fs::symlink_metadata(parent).map_err(|_| invalid())?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(invalid());
        }
    }
    let filename = directory.join("workspace-coding.json");
    let expected = std::fs::symlink_metadata(&filename).map_err(|_| invalid())?;
    if !expected.is_file()
        || expected.uid() != 0
        || expected.mode() & 0o022 != 0
        || expected.len() > 16_384
    {
        return Err(invalid());
    }
    let file = std::fs::File::open(&filename).map_err(|_| invalid())?;
    let actual = file.metadata().map_err(|_| invalid())?;
    if (actual.dev(), actual.ino()) != (expected.dev(), expected.ino()) {
        return Err(invalid());
    }
    let config = serde_json::from_reader(file.take(16_385)).map_err(|_| invalid())?;
    let final_metadata = std::fs::symlink_metadata(&filename).map_err(|_| invalid())?;
    if (final_metadata.dev(), final_metadata.ino()) != (expected.dev(), expected.ino()) {
        return Err(invalid());
    }
    Ok(config)
}

/// The variable a trusted-process runtime names its workspace's binding with.
#[cfg(all(unix, feature = "trusted-process-binding"))]
pub const TRUSTED_PROCESS_BINDING: &str = "SMITHERS_WORKSPACE_CODING_CONFIG";

/// A trusted-process runtime's binding: a host process has no root-owned
/// /etc, so the runtime writes the binding as this user and names it in the
/// host's environment. Only a build with this feature reads it; no guest,
/// bundle or release build enables the feature, so a guest still trusts only
/// the root-owned file.
#[cfg(all(unix, feature = "trusted-process-binding"))]
fn read_trusted_process_config<T: serde::de::DeserializeOwned>(filename: &Path) -> Result<T> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let user = unsafe { libc::geteuid() };
    let expected = std::fs::symlink_metadata(filename).map_err(|_| invalid())?;
    if !filename.is_absolute()
        || !expected.is_file()
        || expected.uid() != user
        || expected.mode() & 0o022 != 0
        || expected.len() > 16_384
    {
        return Err(invalid());
    }
    let file = std::fs::File::open(filename).map_err(|_| invalid())?;
    let actual = file.metadata().map_err(|_| invalid())?;
    if (actual.dev(), actual.ino()) != (expected.dev(), expected.ino()) {
        return Err(invalid());
    }
    serde_json::from_reader(file.take(16_385)).map_err(|_| invalid())
}

/// Managed guests use a root-owned Unix binding and credential socket. A local
/// Windows host cannot acquire that authority from a similarly named file.
#[cfg(windows)]
pub fn read_provisioned_config<T: serde::de::DeserializeOwned>() -> Result<T> {
    Err(unavailable())
}
pub fn provisioned_owner(path: &Path) -> Result<Owner> {
    let config: Config = read_provisioned_config()?;
    if config.version != 1 || Path::new(&config.repository_path) != path {
        return Err(invalid());
    }
    let owner = Owner {
        workspace_id: config.workspace_id,
        repository_id: config.repository_id,
        actor_id: config.actor_id,
    };
    validate_owner(&owner)?;
    Ok(owner)
}
fn validate_owner(owner: &Owner) -> Result<()> {
    if owner.actor_id <= 0
        || owner.repository_id <= 0
        || source_ref(&owner.workspace_id, &"a".repeat(40)).is_err()
    {
        return Err(invalid());
    }
    Ok(())
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn request_id(value: &str) -> bool {
    source_ref(value, &"a".repeat(40)).is_ok()
}
fn sha256(bytes: &[u8]) -> String {
    let mut hash = gix::hash::hasher(gix::hash::Kind::Sha256);
    hash.update(bytes);
    hash.try_finalize()
        .expect("SHA256 is infallible")
        .to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub path: String,
    pub before_digest: Option<String>,
    pub content: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub expected_operation_id: String,
    pub base: Source,
    pub description: String,
    pub files: Vec<File>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proof {
    pub request_id: String,
    pub request_digest: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    owner: Owner,
    proof: Proof,
    expected_operation_id: String,
    base: Source,
    source: Source,
    previous_head: Source,
    workspace_name: String,
    paths: Vec<String>,
}

fn validate(request: &Request) -> Result<()> {
    if !request_id(&request.request_id)
        || !hex(&request.expected_operation_id, 128)
        || request.base.validate().is_err()
        || request.base.commit_id == "0".repeat(40)
        || request.description.trim().is_empty()
        || request.description.len() > 16_384
        || request.description.contains('\0')
        || request.files.is_empty()
        || request.files.len() > MAX_FILES
    {
        return Err(invalid());
    }
    let mut paths = HashSet::new();
    let mut bytes = 0;
    for file in &request.files {
        let parts: Vec<_> = file.path.split('/').collect();
        if file.path.len() > 1000
            || file.path.contains('\\')
            || file.path.chars().any(char::is_control)
            || parts.iter().any(|part| {
                part.is_empty() || matches!(*part, "." | ".." | ".git" | ".jj" | ".smithers")
            })
            || !paths.insert(file.path.clone())
            || file
                .before_digest
                .as_ref()
                .is_some_and(|value| !hex(value, 64))
            || (file.before_digest.is_none() && file.content.is_none())
        {
            return Err(invalid());
        }
        bytes += file.content.as_ref().map_or(0, String::len);
        if bytes > MAX_BYTES {
            return Err(invalid());
        }
    }
    for path in &paths {
        if paths
            .iter()
            .any(|other| other != path && other.starts_with(&(path.clone() + "/")))
        {
            return Err(invalid());
        }
    }
    Ok(())
}

/// `load_at_head` merges divergent operations. This path must never do that.
pub fn load_single(path: &Path) -> Result<(Workspace, Arc<ReadonlyRepo>)> {
    let settings = create_settings(&UserConfig::default());
    let workspace = Workspace::load(
        &settings,
        path,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )
    .map_err(|_| unavailable())?;
    let loader = workspace.repo_loader();
    let heads = loader
        .op_heads_store()
        .get_op_heads()
        .block_on()
        .map_err(|_| unavailable())?;
    if heads.len() != 1 {
        return Err(conflict());
    }
    let data = loader
        .op_store()
        .read_operation(&heads[0])
        .block_on()
        .map_err(|_| unavailable())?;
    let operation = Operation::new(loader.op_store().clone(), heads[0].clone(), data);
    let repo = loader
        .load_at(&operation)
        .block_on()
        .map_err(|_| unavailable())?;
    Ok((workspace, repo))
}
fn head(repo: &ReadonlyRepo, workspace: &Workspace) -> Result<Source> {
    let id = repo
        .view()
        .get_wc_commit_id(workspace.workspace_name())
        .ok_or_else(unavailable)?;
    Source::from_commit(&repo.store().get_commit(id).map_err(|_| unavailable())?)
        .map_err(|_| invalid())
}
fn read_record(operation: &Operation) -> Result<Option<Record>> {
    operation
        .metadata()
        .attributes
        .get(ATTRIBUTE)
        .map(|raw| {
            if raw.len() > 65536 {
                return Err(receipt_invalid());
            }
            serde_json::from_str(raw).map_err(|_| receipt_invalid())
        })
        .transpose()
}
fn record_valid(
    repo: &Arc<ReadonlyRepo>,
    operation: &Operation,
    record: &Record,
    owner: &Owner,
) -> Result<()> {
    if record.version != 1
        || &record.owner != owner
        || !request_id(&record.proof.request_id)
        || !hex(&record.proof.request_digest, 64)
        || operation.parent_ids().len() != 1
        || operation.parent_ids()[0].hex() != record.expected_operation_id
        || record.source.parent_commit_ids != [record.base.commit_id.clone()]
    {
        return Err(receipt_invalid());
    }
    let previous = operation
        .parents()
        .block_on()
        .map_err(|_| receipt_invalid())?
        .remove(0);
    let before = repo
        .loader()
        .load_at(&previous)
        .block_on()
        .map_err(|_| receipt_invalid())?;
    let after = repo
        .loader()
        .load_at(operation)
        .block_on()
        .map_err(|_| receipt_invalid())?;
    let id = CommitId::try_from_hex(&record.source.commit_id).ok_or_else(receipt_invalid)?;
    let base_id = CommitId::try_from_hex(&record.base.commit_id).ok_or_else(receipt_invalid)?;
    if before.index().has_id(&id).map_err(|_| receipt_invalid())?
        || !after.index().has_id(&id).map_err(|_| receipt_invalid())?
        || !before
            .index()
            .has_id(&base_id)
            .map_err(|_| receipt_invalid())?
    {
        return Err(receipt_invalid());
    }
    for source in [&record.base, &record.source, &record.previous_head] {
        source.validate().map_err(|_| receipt_invalid())?;
        let commit = repo
            .store()
            .get_commit(&CommitId::try_from_hex(&source.commit_id).ok_or_else(receipt_invalid)?)
            .map_err(|_| receipt_invalid())?;
        if Source::from_commit(&commit).map_err(|_| receipt_invalid())? != *source {
            return Err(receipt_invalid());
        }
    }
    // Reconstruct the bounded request from immutable bytes. Metadata cannot
    // substitute another child/tree while copying an approved request digest.
    if record.paths.is_empty() || record.paths.len() > MAX_FILES {
        return Err(receipt_invalid());
    }
    let base = repo
        .store()
        .get_commit(&base_id)
        .map_err(|_| receipt_invalid())?;
    let source = repo
        .store()
        .get_commit(&id)
        .map_err(|_| receipt_invalid())?;
    let base_tree = base.tree();
    let source_tree = source.tree();
    let mut stream = base_tree.diff_stream(&source_tree, &jj_lib::matchers::EverythingMatcher);
    let mut changed = HashSet::new();
    while let Some(entry) = stream.next().block_on() {
        entry.values.map_err(|_| receipt_invalid())?;
        changed.insert(entry.path.as_internal_file_string().to_owned());
        if changed.len() > MAX_FILES {
            return Err(receipt_invalid());
        }
    }
    if changed != record.paths.iter().cloned().collect() {
        return Err(receipt_invalid());
    }
    let mut files = Vec::new();
    for name in &record.paths {
        let path = RepoPathBuf::from_internal_string(name).map_err(|_| receipt_invalid())?;
        let read = |tree: &MergedTree| -> Result<_> {
            let value = tree
                .path_value(&path)
                .block_on()
                .map_err(|_| receipt_invalid())?;
            match value.as_resolved() {
                Some(None) => Ok((None, false, CopyId::placeholder())),
                Some(Some(TreeValue::File {
                    id,
                    executable,
                    copy_id,
                })) => Ok((
                    Some(
                        read_file_content(repo.store(), &path, id, MAX_BYTES as u64)
                            .map_err(|_| receipt_invalid())?
                            .ok_or_else(receipt_invalid)?,
                    ),
                    *executable,
                    copy_id.clone(),
                )),
                _ => Err(receipt_invalid()),
            }
        };
        let (old, old_exec, old_copy) = read(&base_tree)?;
        let (new, new_exec, new_copy) = read(&source_tree)?;
        if new.is_some() && (old_exec != new_exec || old_copy != new_copy) {
            return Err(receipt_invalid());
        }
        files.push(File {
            path: name.clone(),
            before_digest: old.as_ref().map(|bytes| sha256(bytes)),
            content: new
                .map(String::from_utf8)
                .transpose()
                .map_err(|_| receipt_invalid())?,
        });
    }
    let request = Request {
        request_id: record.proof.request_id.clone(),
        expected_operation_id: record.expected_operation_id.clone(),
        base: record.base.clone(),
        description: source.description().to_owned(),
        files,
    };
    validate(&request).map_err(|_| receipt_invalid())?;
    if sha256(&serde_json::to_vec(&(owner, &request)).map_err(|_| receipt_invalid())?)
        != record.proof.request_digest
    {
        return Err(receipt_invalid());
    }
    let before_view = before.view().store_view();
    let mut after_view = after.view().store_view().clone();
    let workspace_name: &jj_lib::ref_name::WorkspaceName =
        jj_lib::ref_name::WorkspaceName::new(&record.workspace_name);
    if before
        .view()
        .get_wc_commit_id(workspace_name)
        .map(ObjectId::hex)
        .as_deref()
        != Some(&record.previous_head.commit_id)
        || !after_view.head_ids.contains(&id)
        || after_view
            .head_ids
            .difference(&before_view.head_ids)
            .any(|added| added != &id)
    {
        return Err(receipt_invalid());
    }
    for removed in before_view.head_ids.difference(&after_view.head_ids) {
        if !before
            .index()
            .is_ancestor(removed, &base_id)
            .block_on()
            .map_err(|_| receipt_invalid())?
        {
            return Err(receipt_invalid());
        }
    }
    after_view.head_ids = before_view.head_ids.clone();
    if &after_view != before_view {
        return Err(receipt_invalid());
    }
    Ok(())
}

/// Receipt must be in the current single-head ancestry, not an arbitrary op ID.
pub fn verify_creation(
    repo: &Arc<ReadonlyRepo>,
    owner: &Owner,
    operation_id: &str,
    proof: &Proof,
    source: &Source,
) -> Result<()> {
    if !hex(operation_id, 128) {
        return Err(receipt_invalid());
    }
    let mut operations = Box::pin(jj_lib::op_walk::walk_ancestors(std::slice::from_ref(
        repo.operation(),
    )));
    let mut inspected = 0;
    while let Some(operation) = operations.next().block_on() {
        inspected += 1;
        if inspected > MAX_OPERATIONS {
            return Err(receipt_invalid());
        }
        let operation = operation.map_err(|_| receipt_invalid())?;
        if operation.id().hex() != operation_id {
            continue;
        }
        let record = read_record(&operation)?.ok_or_else(receipt_invalid)?;
        record_valid(repo, &operation, &record, owner)?;
        return if &record.proof == proof && &record.source == source {
            Ok(())
        } else {
            Err(receipt_invalid())
        };
    }
    Err(receipt_invalid())
}
fn revision(source: &Source, operation: &Operation) -> serde_json::Value {
    serde_json::json!({"kind":"resolved", "changeId":source.change_id, "commitId":source.commit_id, "treeId":source.tree_id,
        "operationId":operation.id().hex(), "parentCommitIds":source.parent_commit_ids})
}
fn result(
    record: &Record,
    operation: &Operation,
    replayed: bool,
    publication_ready: bool,
) -> serde_json::Value {
    serde_json::json!({"status":"created", "replayed":replayed, "requestId":record.proof.request_id, "requestDigest":record.proof.request_digest,
        "workspaceId":record.owner.workspace_id, "repositoryId":record.owner.repository_id, "operationId":operation.id().hex(),
        "parentOperationId":record.expected_operation_id, "base":record.base,
        "head":revision(&record.previous_head,operation), "source":revision(&record.source,operation), "publicationReady":publication_ready})
}

pub(crate) fn create(path: &Path, owner: Owner, request: Request) -> Result<serde_json::Value> {
    create_with_hook(path, owner, request, |_| {})
}
fn create_with_hook(
    path: &Path,
    owner: Owner,
    request: Request,
    after_commit: impl FnOnce(&Arc<ReadonlyRepo>),
) -> Result<serde_json::Value> {
    validate_owner(&owner)?;
    validate(&request)?;
    let digest = sha256(&serde_json::to_vec(&(&owner, &request)).map_err(|_| invalid())?);
    let (workspace, repo) = load_single(path)?;
    let mut operations = Box::pin(jj_lib::op_walk::walk_ancestors(std::slice::from_ref(
        repo.operation(),
    )));
    let mut found = None;
    let mut inspected = 0;
    while let Some(operation) = operations.next().block_on() {
        inspected += 1;
        if inspected > MAX_OPERATIONS {
            return Err(unavailable());
        }
        let operation = operation.map_err(|_| unavailable())?;
        if let Some(record) = read_record(&operation)? {
            if record.proof.request_id != request.request_id {
                continue;
            }
            if record.proof.request_digest != digest || record.owner != owner {
                return Err(Failure {
                    code: "request_conflict",
                    message: "Request ID already identifies a different native source operation",
                });
            }
            record_valid(&repo, &operation, &record, &owner)?;
            if found.is_some() {
                return Err(receipt_invalid());
            }
            found = Some((record, operation));
        }
    }
    if let Some((record, operation)) = found {
        let publication_ready = repo
            .op_heads_store()
            .get_op_heads()
            .block_on()
            .is_ok_and(|heads| heads == [repo.operation().id().clone()]);
        return Ok(result(&record, &operation, true, publication_ready));
    }
    if repo.operation().id().hex() != request.expected_operation_id {
        return Err(conflict());
    }
    let previous_head = head(&repo, &workspace)?;
    let base_id = CommitId::try_from_hex(&request.base.commit_id).ok_or_else(invalid)?;
    if !repo.index().has_id(&base_id).map_err(|_| unavailable())? {
        return Err(Failure {
            code: "source_missing",
            message: "The exact main source is not available in the native store",
        });
    }
    let base = repo
        .store()
        .get_commit(&base_id)
        .map_err(|_| unavailable())?;
    if Source::from_commit(&base).map_err(|_| invalid())? != request.base {
        return Err(invalid());
    }
    let base_tree = base.tree();
    let base_tree_id = base_tree
        .tree_ids()
        .clone()
        .into_resolved()
        .map_err(|_| invalid())?;
    let mut builder = TreeBuilder::new(repo.store().clone(), base_tree_id);
    for file in &request.files {
        let path = RepoPathBuf::from_internal_string(&file.path).map_err(|_| invalid())?;
        // A parent symlink/submodule/file cannot be traversed or silently replaced.
        let mut parent = path.parent();
        while let Some(ancestor) = parent {
            if !ancestor.is_root() {
                let value = base_tree
                    .path_value(ancestor)
                    .block_on()
                    .map_err(|_| invalid())?;
                if !matches!(
                    value.as_resolved(),
                    Some(None) | Some(Some(TreeValue::Tree(_)))
                ) {
                    return Err(invalid());
                }
            }
            parent = ancestor.parent();
        }
        let value = base_tree
            .path_value(&path)
            .block_on()
            .map_err(|_| invalid())?;
        let (before, executable, copy_id) = match value.as_resolved() {
            Some(None) => (None, false, CopyId::placeholder()),
            Some(Some(TreeValue::File {
                id,
                executable,
                copy_id,
            })) => (
                Some(
                    read_file_content(repo.store(), &path, id, MAX_BYTES as u64)
                        .map_err(|_| unavailable())?
                        .ok_or_else(invalid)?,
                ),
                *executable,
                copy_id.clone(),
            ),
            _ => return Err(invalid()),
        };
        if before.as_ref().map(|bytes| sha256(bytes)) != file.before_digest
            || before.as_deref() == file.content.as_ref().map(|value| value.as_bytes())
        {
            return Err(Failure {
                code: "file_conflict",
                message: "Checked file preimage differs from the exact main source",
            });
        }
        if let Some(content) = &file.content {
            let id = repo
                .store()
                .write_file(&path, &mut content.as_bytes())
                .block_on()
                .map_err(|_| unavailable())?;
            builder.set(
                path,
                TreeValue::File {
                    id,
                    executable,
                    copy_id,
                },
            );
        } else {
            builder.remove(path);
        }
    }
    let tree_id = builder.write_tree().block_on().map_err(|_| unavailable())?;
    let mut transaction = repo.start_transaction();
    let source = transaction
        .repo_mut()
        .new_commit(
            vec![base_id],
            MergedTree::resolved(repo.store().clone(), tree_id),
        )
        .set_description(&request.description)
        .write()
        .block_on()
        .map_err(|_| unavailable())?;
    let record = Record {
        version: 1,
        owner,
        proof: Proof {
            request_id: request.request_id,
            request_digest: digest,
        },
        expected_operation_id: request.expected_operation_id,
        base: request.base,
        source: Source::from_commit(&source).map_err(|_| unavailable())?,
        previous_head,
        workspace_name: workspace.workspace_name().as_str().to_owned(),
        paths: request.files.iter().map(|file| file.path.clone()).collect(),
    };
    transaction.set_attribute(
        ATTRIBUTE.to_string(),
        serde_json::to_string(&record).map_err(|_| unavailable())?,
    );
    let heads = repo
        .op_heads_store()
        .get_op_heads()
        .block_on()
        .map_err(|_| unavailable())?;
    if heads != [repo.operation().id().clone()] {
        return Err(conflict());
    }
    let updated = transaction
        .commit("create checked repository source")
        .block_on()
        .map_err(|_| unavailable())?;
    after_commit(&updated);
    // The transaction already committed. A concurrent head is retained work,
    // never a claim of no mutation or permission to publish another head.
    let publication_ready = updated
        .op_heads_store()
        .get_op_heads()
        .block_on()
        .is_ok_and(|heads| heads == [updated.operation().id().clone()])
        && record_valid(&updated, updated.operation(), &record, &record.owner).is_ok();
    Ok(result(
        &record,
        updated.operation(),
        false,
        publication_ready,
    ))
}

pub fn run(path: &Path) -> Result<serde_json::Value> {
    let owner = provisioned_owner(path)?;
    let mut raw = Vec::new();
    std::io::stdin()
        .take((2 * 1024 * 1024) + 1)
        .read_to_end(&mut raw)
        .map_err(|_| invalid())?;
    if raw.len() > 2 * 1024 * 1024 {
        return Err(invalid());
    }
    let request = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    create(path, owner, request)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use jj_lib::op_store::RefTarget;
    use jj_lib::ref_name::RefName;

    pub(crate) fn owner() -> Owner {
        Owner {
            workspace_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
            repository_id: 200,
            actor_id: 10,
        }
    }
    fn write_tree(repo: &Arc<ReadonlyRepo>, base: &Source, files: &[(&str, &str)]) -> MergedTree {
        let commit = repo
            .store()
            .get_commit(&CommitId::try_from_hex(&base.commit_id).unwrap())
            .unwrap();
        let mut builder = TreeBuilder::new(
            repo.store().clone(),
            commit.tree().tree_ids().clone().into_resolved().unwrap(),
        );
        for (path, content) in files {
            let path = RepoPathBuf::from_internal_string(*path).unwrap();
            let id = repo
                .store()
                .write_file(&path, &mut content.as_bytes())
                .block_on()
                .unwrap();
            builder.set(
                path,
                TreeValue::File {
                    id,
                    executable: false,
                    copy_id: CopyId::placeholder(),
                },
            );
        }
        MergedTree::resolved(
            repo.store().clone(),
            builder.write_tree().block_on().unwrap(),
        )
    }
    pub(crate) fn fixture() -> (tempfile::TempDir, Request) {
        let temp = tempfile::TempDir::new().unwrap();
        Workspace::init_internal_git(
            &create_settings(&UserConfig::default()),
            temp.path(),
            gix::hash::Kind::Sha1,
        )
        .block_on()
        .unwrap();
        let (workspace, repo) = load_single(temp.path()).unwrap();
        let initial = head(&repo, &workspace).unwrap();
        let mut tx = repo.start_transaction();
        let base = tx
            .repo_mut()
            .new_commit(
                vec![CommitId::try_from_hex(&initial.commit_id).unwrap()],
                write_tree(&repo, &initial, &[("code.txt", "original\n")]),
            )
            .set_description("public main")
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_local_bookmark_target(RefName::new("main"), RefTarget::normal(base.id().clone()));
        let base = Source::from_commit(&base).unwrap();
        let editor = tx
            .repo_mut()
            .new_commit(
                vec![CommitId::try_from_hex(&base.commit_id).unwrap()],
                write_tree(
                    &repo,
                    &base,
                    &[
                        (
                            ".smithers/repository-jobs/issues/prompt.md",
                            "saved configuration",
                        ),
                        (".smithers/flows/repository-jobs/issues.md", "saved flow"),
                    ],
                ),
            )
            .set_description("saved setup assets")
            .write()
            .block_on()
            .unwrap();
        let descendant = tx
            .repo_mut()
            .new_commit(vec![editor.id().clone()], editor.tree())
            .set_description("user descendant")
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_wc_commit(
                workspace.workspace_name().to_owned(),
                descendant.id().clone(),
            )
            .unwrap();
        tx.repo_mut().set_local_bookmark_target(
            RefName::new("my-work"),
            RefTarget::normal(descendant.id().clone()),
        );
        let repo = tx.commit("source creation fixture").block_on().unwrap();
        std::fs::create_dir_all(temp.path().join(".smithers/repository-jobs/issues")).unwrap();
        std::fs::write(
            temp.path()
                .join(".smithers/repository-jobs/issues/prompt.md"),
            "unsaved prompt edit",
        )
        .unwrap();
        std::fs::write(temp.path().join("code.txt"), "uncommitted user bytes\n").unwrap();
        std::fs::write(temp.path().join("untracked.txt"), "untracked bytes\n").unwrap();
        let request = Request {
            request_id: "47f7ee7c-7900-4b52-ac40-a45244f5bb2f".into(),
            expected_operation_id: repo.operation().id().hex(),
            base,
            description: "checked feature".into(),
            files: vec![File {
                path: "code.txt".into(),
                before_digest: Some(sha256(b"original\n")),
                content: Some("checked implementation\n".into()),
            }],
        };
        (temp, request)
    }
    fn source(value: &serde_json::Value) -> Source {
        serde_json::from_value(serde_json::json!({"change_id":value["changeId"], "commit_id":value["commitId"], "tree_id":value["treeId"], "parent_commit_ids":value["parentCommitIds"]})).unwrap()
    }
    fn unchanged_editing(before: &Arc<ReadonlyRepo>, after: &Arc<ReadonlyRepo>) {
        let mut view = after.view().store_view().clone();
        view.head_ids = before.view().store_view().head_ids.clone();
        assert_eq!(&view, before.view().store_view());
    }
    #[test]
    fn creates_exact_immutable_child_preserving_editor_setup_bookmarks_and_descendants() {
        let (temp, request) = fixture();
        let (_, before) = load_single(temp.path()).unwrap();
        let result = create(temp.path(), owner(), request.clone()).unwrap();
        assert_eq!(result["publicationReady"], true);
        let (_, after) = load_single(temp.path()).unwrap();
        unchanged_editing(&before, &after);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("code.txt")).unwrap(),
            "uncommitted user bytes\n"
        );
        assert_eq!(
            std::fs::read_to_string(
                temp.path()
                    .join(".smithers/repository-jobs/issues/prompt.md")
            )
            .unwrap(),
            "unsaved prompt edit"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("untracked.txt")).unwrap(),
            "untracked bytes\n"
        );
        let created = source(&result["source"]);
        assert_eq!(created.parent_commit_ids, [request.base.commit_id]);
        let output = tempfile::TempDir::new().unwrap();
        let export = smithers_ffi::tree_export::export_commit_tree(
            temp.path(),
            &created.commit_id,
            output.path(),
        )
        .unwrap();
        let root = Path::new(&export.path);
        assert_eq!(
            std::fs::read_to_string(root.join("code.txt")).unwrap(),
            "checked implementation\n"
        );
        assert!(!root.join(".smithers").exists());
        assert!(!root.join("untracked.txt").exists());
        let proof = Proof {
            request_id: result["requestId"].as_str().unwrap().into(),
            request_digest: result["requestDigest"].as_str().unwrap().into(),
        };
        verify_creation(
            &after,
            &owner(),
            result["operationId"].as_str().unwrap(),
            &proof,
            &created,
        )
        .unwrap();
    }
    #[test]
    fn identical_retry_after_later_operations_reuses_receipt_and_checks_owner_and_request() {
        let (temp, request) = fixture();
        let first = create(temp.path(), owner(), request.clone()).unwrap();
        let (_, repo) = load_single(temp.path()).unwrap();
        repo.start_transaction()
            .commit("later unrelated operation")
            .block_on()
            .unwrap();
        let second = create(temp.path(), owner(), request.clone()).unwrap();
        assert_eq!(second["replayed"], true);
        for key in ["source", "head", "operationId", "requestDigest"] {
            assert_eq!(first[key], second[key]);
        }
        for kind in ["owner", "files", "description", "operation", "base"] {
            let mut changed = request.clone();
            let mut actor = owner();
            match kind {
                "owner" => actor.actor_id += 1,
                "files" => changed.files[0].content = Some("different".into()),
                "description" => changed.description.push('!'),
                "operation" => changed.expected_operation_id = "f".repeat(128),
                _ => changed.base.tree_id = "f".repeat(40),
            }
            assert_eq!(
                create(temp.path(), actor, changed).unwrap_err().code,
                "request_conflict"
            );
        }
        let (_, repo) = load_single(temp.path()).unwrap();
        let proof = Proof {
            request_id: request.request_id,
            request_digest: first["requestDigest"].as_str().unwrap().into(),
        };
        let operation = first["operationId"].as_str().unwrap();
        verify_creation(
            &repo,
            &owner(),
            operation,
            &proof,
            &source(&first["source"]),
        )
        .unwrap();
        let mut foreign = owner();
        foreign.actor_id += 1;
        assert!(verify_creation(
            &repo,
            &foreign,
            operation,
            &proof,
            &source(&first["source"])
        )
        .is_err());
        assert!(verify_creation(&repo, &owner(), operation, &proof, &request.base).is_err());
        assert!(verify_creation(
            &repo,
            &owner(),
            &repo.operation().id().hex(),
            &proof,
            &source(&first["source"])
        )
        .is_err());
    }
    #[test]
    fn stale_operation_bad_preimage_and_unsafe_paths_do_not_commit() {
        for kind in [
            "stale",
            "preimage",
            "metadata",
            "overlap",
            "traversal",
            "noop",
        ] {
            let (temp, mut request) = fixture();
            let (_, before) = load_single(temp.path()).unwrap();
            match kind {
                "stale" => request.expected_operation_id = "f".repeat(128),
                "preimage" => request.files[0].before_digest = Some("f".repeat(64)),
                "metadata" => request.files[0].path = ".smithers/flows/job.md".into(),
                "overlap" => request.files.push(File {
                    path: "code.txt/child".into(),
                    before_digest: None,
                    content: Some("x".into()),
                }),
                "traversal" => request.files[0].path = "../outside".into(),
                _ => request.files[0].content = Some("original\n".into()),
            }
            assert!(create(temp.path(), owner(), request).is_err(), "{kind}");
            let (_, after) = load_single(temp.path()).unwrap();
            assert_eq!(before.operation().id(), after.operation().id(), "{kind}");
        }
    }
    #[test]
    fn post_commit_race_returns_retained_source_and_refuses_publication_without_merging() {
        let (temp, request) = fixture();
        let (_, before) = load_single(temp.path()).unwrap();
        let result = create_with_hook(temp.path(), owner(), request, |_| {
            before
                .start_transaction()
                .commit("concurrent editor operation")
                .block_on()
                .unwrap();
        })
        .unwrap();
        assert_eq!(result["status"], "created");
        assert_eq!(result["publicationReady"], false);
        assert!(before
            .store()
            .get_commit(
                &CommitId::try_from_hex(result["source"]["commitId"].as_str().unwrap()).unwrap()
            )
            .is_ok());
        assert!(matches!(
            load_single(temp.path()),
            Err(Failure {
                code: "operation_conflict",
                ..
            })
        ));
        assert_eq!(
            before
                .op_heads_store()
                .get_op_heads()
                .block_on()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn divergent_operations_are_not_automatically_reconciled() {
        let (temp, request) = fixture();
        let (_, before) = load_single(temp.path()).unwrap();
        before
            .start_transaction()
            .commit("left")
            .block_on()
            .unwrap();
        before
            .start_transaction()
            .commit("right")
            .block_on()
            .unwrap();
        let heads = before.op_heads_store().get_op_heads().block_on().unwrap();
        assert_eq!(heads.len(), 2);
        assert_eq!(
            create(temp.path(), owner(), request).unwrap_err().code,
            "operation_conflict"
        );
        assert_eq!(
            before.op_heads_store().get_op_heads().block_on().unwrap(),
            heads
        );
    }
    #[test]
    fn copied_receipt_cannot_authorize_an_already_existing_commit() {
        let (temp, request) = fixture();
        let value = create(temp.path(), owner(), request).unwrap();
        let (_, repo) = load_single(temp.path()).unwrap();
        let mut record = read_record(repo.operation()).unwrap().unwrap();
        record.expected_operation_id = repo.operation().id().hex();
        let mut tx = repo.start_transaction();
        tx.set_attribute(ATTRIBUTE.into(), serde_json::to_string(&record).unwrap());
        let copied = tx
            .commit("copied metadata is not source creation")
            .block_on()
            .unwrap();
        let proof = Proof {
            request_id: value["requestId"].as_str().unwrap().into(),
            request_digest: value["requestDigest"].as_str().unwrap().into(),
        };
        assert!(verify_creation(
            &copied,
            &owner(),
            &copied.operation().id().hex(),
            &proof,
            &source(&value["source"])
        )
        .is_err());
    }

    #[cfg(feature = "trusted-process-binding")]
    #[test]
    fn trusted_process_binding_is_read_only_from_a_private_file_of_this_user() {
        use std::os::unix::fs::PermissionsExt;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Binding {
            workspace_id: String,
        }
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("workspace-coding.json");
        std::fs::write(&file, r#"{"version":1,"workspaceId":"w-1"}"#).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let binding: Binding = read_trusted_process_config(&file).unwrap();
        assert_eq!(binding.workspace_id, "w-1");
        // Another writer could replace the identity: refused.
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o620)).unwrap();
        assert!(read_trusted_process_config::<Binding>(&file).is_err());
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        // A symlink is never followed, and a relative name never resolves.
        let link = temp.path().join("link.json");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(read_trusted_process_config::<Binding>(&link).is_err());
        assert!(read_trusted_process_config::<Binding>(Path::new("workspace-coding.json")).is_err());
        // An oversized binding is refused before it is parsed.
        std::fs::write(&file, vec![b' '; 16_385]).unwrap();
        assert!(read_trusted_process_config::<Binding>(&file).is_err());
    }
}
