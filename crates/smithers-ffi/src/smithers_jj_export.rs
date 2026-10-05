use std::io::Read as _;
use std::path::Path;

#[cfg(unix)]
mod atomic_fs;
#[cfg(windows)]
#[path = "atomic_windows_fs.rs"]
mod atomic_fs;
mod atomic_glob;
mod atomic_protocol;
#[cfg(windows)]
mod atomic_windows_handle;
mod file_eligibility;
mod source_create;
mod source_import;
mod source_publish;
mod workspace_engine;
mod workspace_files;
mod workspace_local;
mod workspace_projections;

const USAGE: &str = "usage: smithers-jj-export [--engine|--local] < JSON request\n       smithers-jj-export --eligible <repository-root> < JSON request\n       smithers-jj-export --projections <repository-root> <workspace-id> [cursor]\n       smithers-jj-export --head-projections <repository-root> <workspace-id> <cursor> <change-id> <commit-id> <ahead> <behind>\n       smithers-jj-export --check-config <repository-root> <workspace-id> <actor-id>\n       smithers-jj-export --create-source|--publish-source <repository-root> < JSON request\n       smithers-jj-export <repository-root> <full-commit-id> <output-parent>";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--atomic-fs" {
        return Ok(atomic_fs::serve()?);
    }
    #[cfg(windows)]
    if args.len() == 2 && args[0] == "--process-info" {
        let pid: u32 = args[1]
            .to_str()
            .ok_or("process ID must be UTF-8")?
            .parse()?;
        let observed = windows_process::started_at_ms(pid)?;
        println!(
            "{}",
            match observed {
                Some(started) => serde_json::json!({"status":"started", "startedAtMs":started}),
                None => serde_json::json!({"status":"gone"}),
            }
        );
        return Ok(());
    }
    #[cfg(windows)]
    if args.len() == 2 && args[0] == "--process-identity" {
        let pid: u32 = args[1]
            .to_str()
            .ok_or("process ID must be UTF-8")?
            .parse()?;
        let observed = windows_process::identity(pid)?;
        println!(
            "{}",
            match observed {
                Some(created) =>
                    serde_json::json!({"status":"started", "created":created.to_string()}),
                None => serde_json::json!({"status":"gone"}),
            }
        );
        return Ok(());
    }
    #[cfg(windows)]
    if args.len() == 3 && args[0] == "--process-job" {
        let pid: u32 = args[1]
            .to_str()
            .ok_or("process ID must be UTF-8")?
            .parse()?;
        let created: u64 = args[2]
            .to_str()
            .ok_or("process identity must be UTF-8")?
            .parse()?;
        return Ok(windows_process::guard_job(pid, created)?);
    }
    // Provisioning stages this helper into every workspace guest and smoke-tests
    // the staged copy before trusting it (internal/services/workspace_scripts).
    // The smoke must prove the dynamic loader resolved the binary without
    // touching a repository, so both flags exit 0 with no side effects.
    if args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    if args.len() == 1 && (args[0] == "--version" || args[0] == "-V") {
        println!("smithers-jj-export {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.len() == 1 && args[0] == "--capabilities" {
        #[cfg(not(feature = "trusted-process-binding"))]
        println!("{{\"capabilities\":[\"create-source/v1\",\"publish-created-source/v1\"]}}");
        // A test runtime asks for this build before it binds a host process.
        #[cfg(feature = "trusted-process-binding")]
        println!("{{\"capabilities\":[\"create-source/v1\",\"publish-created-source/v1\",\"trusted-process-binding/v1\"]}}");
        return Ok(());
    }
    if args.len() == 4 && args[0] == "--check-config" {
        let repo = Path::new(&args[1]);
        let owner = source_create::provisioned_owner(repo)
            .map_err(|_| "workspace coding config is unavailable")?;
        let workspace = args[2].to_str().ok_or("workspace ID must be UTF-8")?;
        let actor: i64 = args[3].to_str().ok_or("actor ID must be UTF-8")?.parse()?;
        if owner.workspace_id != workspace || owner.actor_id != actor {
            return Err("workspace coding config owner does not match".into());
        }
        println!("ok");
        return Ok(());
    }
    if args.len() == 2 && args[0] == "--create-source" {
        match source_create::run(Path::new(&args[1])) {
            Ok(result) => println!("{}", serde_json::to_string(&result)?),
            Err(error) => {
                println!("{}", serde_json::json!({"error": error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() == 2 && args[0] == "--publish-source" {
        match source_publish::run(Path::new(&args[1])) {
            Ok(result) => println!("{}", serde_json::to_string(&result)?),
            Err(error) => {
                println!("{}", serde_json::json!({"error": error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() == 2 && args[0] == "--eligible" {
        let mut raw = Vec::new();
        std::io::stdin().take((1 << 20) + 1).read_to_end(&mut raw)?;
        if raw.len() > 1 << 20 {
            return Err("eligibility request exceeds 1 MiB".into());
        }
        let input = serde_json::from_slice(&raw)?;
        let result = file_eligibility::check(Path::new(&args[1]), input)?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    if args.len() == 1 && args[0] == "--engine" {
        let mut raw = Vec::new();
        std::io::stdin().take((1 << 20) + 1).read_to_end(&mut raw)?;
        let result = if raw.len() > 1 << 20 {
            Err(workspace_engine::Failure::new(
                "invalid_request",
                "engine request exceeds 1 MiB",
            ))
        } else {
            workspace_engine::run(&raw)
        };
        match result {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() == 1 && args[0] == "--local" {
        let mut raw = Vec::new();
        std::io::stdin().take((2 << 20) + 1).read_to_end(&mut raw)?;
        let result = if raw.len() > 2 << 20 {
            Err(workspace_engine::Failure::new(
                "invalid_request",
                "coding request exceeds 2 MiB",
            ))
        } else {
            workspace_local::run(&raw)
        };
        match result {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if (args.len() == 4 || args.len() == 3) && args[0] == "--projections" {
        let repo = Path::new(&args[1]);
        let workspace = args[2].to_str().ok_or("workspace ID must be UTF-8")?;
        let after = if args.len() == 4 {
            args[3].to_str().ok_or("cursor must be UTF-8")?
        } else {
            ""
        };
        match workspace_projections::run(repo, workspace, after) {
            Ok(value) => println!("{value}"),
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() == 8 && args[0] == "--head-projections" {
        let repo = Path::new(&args[1]);
        let values: Vec<_> = args[2..]
            .iter()
            .map(|arg| arg.to_str().ok_or("head report argument must be UTF-8"))
            .collect::<Result<_, _>>()?;
        let ahead: u32 = values[4].parse()?;
        let behind: u32 = values[5].parse()?;
        let projection = workspace_projections::run(repo, values[0], values[1]);
        match projection {
            Ok(value) => {
                println!("{}", value["cursor"].as_str().unwrap_or(""));
                println!("{}", if value["more"] == true { "yes" } else { "no" });
                println!(
                    "{}",
                    serde_json::json!({"change_id":values[2], "commit_id":values[3],
                    "ahead":ahead, "behind":behind, "coding_operations":value["coding_operations"]})
                );
            }
            Err(error) => {
                println!("{}", serde_json::json!({"error":error}));
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if args.len() != 3 {
        return Err(USAGE.into());
    }
    let commit = args[1].to_str().ok_or("commit ID must be UTF-8")?;
    let result = smithers_ffi::tree_export::export_commit_tree(
        Path::new(&args[0]),
        commit,
        Path::new(&args[2]),
    )?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

// Process handles pin the kernel object while its identity is inspected. This
// observation is read-only; an unreadable object never becomes a dead process.
#[cfg(windows)]
mod windows_process {
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{
        ERROR_INVALID_PARAMETER, FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    fn open_process(pid: u32, access: u32) -> io::Result<Option<OwnedHandle>> {
        if pid <= 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "reserved process ID",
            ));
        }
        let raw = unsafe { OpenProcess(access, 0, pid) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        Ok(Some(unsafe { OwnedHandle::from_raw_handle(raw) }))
    }

    fn running(handle: &OwnedHandle) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => Ok(false),
            WAIT_TIMEOUT => Ok(true),
            _ => Err(io::Error::last_os_error()),
        }
    }

    fn created(handle: &OwnedHandle) -> io::Result<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        if unsafe {
            GetProcessTimes(
                handle.as_raw_handle(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }

    pub(super) fn identity(pid: u32) -> io::Result<Option<u64>> {
        let Some(handle) =
            open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?
        else {
            return Ok(None);
        };
        if !running(&handle)? {
            return Ok(None);
        }
        created(&handle).map(Some)
    }

    pub(super) fn started_at_ms(pid: u32) -> io::Result<Option<u64>> {
        let Some(ticks) = identity(pid)? else {
            return Ok(None);
        };
        let unix_ticks = ticks.checked_sub(116_444_736_000_000_000).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "process creation time precedes Unix epoch",
            )
        })?;
        Ok(Some(unix_ticks / 10_000))
    }

    /// The guardian holds the only non-inheritable job handle. Assignment is
    /// permitted only for the exact owner that the host has not yet activated.
    struct ProcessJob {
        owner: OwnedHandle,
        job: OwnedHandle,
    }

    impl ProcessJob {
        fn attach(pid: u32, expected_created: u64) -> io::Result<Self> {
            use windows_sys::Win32::System::JobObjects::*;
            use windows_sys::Win32::System::Threading::{PROCESS_SET_QUOTA, PROCESS_TERMINATE};
            if pid == std::process::id() || expected_created == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid process owner",
                ));
            }
            let owner = open_process(
                pid,
                PROCESS_QUERY_LIMITED_INFORMATION
                    | PROCESS_SYNCHRONIZE
                    | PROCESS_SET_QUOTA
                    | PROCESS_TERMINATE,
            )?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "process owner is gone"))?;
            // Both observations use the same retained kernel handle. A recycled
            // PID cannot substitute another process between comparison/assignment.
            if !running(&owner)? || created(&owner)? != expected_created {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "process owner identity changed",
                ));
            }
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if unsafe { AssignProcessToJobObject(job.as_raw_handle(), owner.as_raw_handle()) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { owner, job })
        }

        fn terminate_and_wait(&self) -> io::Result<()> {
            use std::time::{Duration, Instant};
            use windows_sys::Win32::System::JobObjects::*;
            if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
                    unsafe { std::mem::zeroed() };
                if unsafe {
                    QueryInformationJobObject(
                        self.job.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as *mut _,
                        std::mem::size_of_val(&accounting) as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if accounting.ActiveProcesses == 0 {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "process job did not become empty",
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    pub(super) fn guard_job(pid: u32, expected_created: u64) -> io::Result<()> {
        use std::io::{Read as _, Write as _};
        use std::sync::Arc;
        use windows_sys::Win32::System::Threading::{
            CreateEventW, SetEvent, WaitForMultipleObjects,
        };
        let job = ProcessJob::attach(pid, expected_created)?;
        let raw = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let disconnected = Arc::new(unsafe { OwnedHandle::from_raw_handle(raw) });
        let notify = disconnected.clone();
        // EOF covers a crashed host independently of the Node owner's event
        // loop. A byte is an explicit forced stop. No target stdin is shared.
        std::thread::Builder::new()
            .name("job-control".into())
            .spawn(move || {
                let _ = std::io::stdin().read(&mut [0_u8; 1]);
                unsafe {
                    SetEvent(notify.as_raw_handle());
                }
            })?;
        let mut output = std::io::stdout().lock();
        writeln!(
            output,
            "{}",
            serde_json::json!({"status":"ready", "ownerPid":pid})
        )?;
        output.flush()?;
        let handles = [job.owner.as_raw_handle(), disconnected.as_raw_handle()];
        let result =
            unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, u32::MAX) };
        if result != WAIT_OBJECT_0 && result != WAIT_OBJECT_0 + 1 {
            return Err(io::Error::last_os_error());
        }
        job.terminate_and_wait()?;
        writeln!(output, "{}", serde_json::json!({"status":"settled"}))?;
        output.flush()?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::process::{Child, Command, Stdio};
        use std::time::{SystemTime, UNIX_EPOCH};

        struct OwnedChild(Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        fn now() -> u64 {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        }

        #[test]
        fn observes_live_and_exited_processes_without_signalling_them() {
            let before = now();
            let mut child = OwnedChild(
                Command::new("node")
                    .args(["-e", "setInterval(()=>{},1000)"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let first = started_at_ms(child.0.id()).unwrap().unwrap();
            assert!(first >= before.saturating_sub(1000) && first <= now());
            assert_eq!(started_at_ms(child.0.id()).unwrap(), Some(first));
            assert!(child.0.try_wait().unwrap().is_none());
            child.0.kill().unwrap();
            child.0.wait().unwrap();
            // Child still owns the handle, so the kernel cannot reuse its PID.
            assert_eq!(started_at_ms(child.0.id()).unwrap(), None);
            assert!(started_at_ms(std::process::id()).unwrap().unwrap() <= now());
        }

        #[test]
        fn refuses_reserved_ids_and_observes_a_missing_process() {
            for pid in [0, 1] {
                assert_eq!(
                    started_at_ms(pid).unwrap_err().kind(),
                    io::ErrorKind::InvalidInput
                );
            }
            assert_eq!(started_at_ms(u32::MAX).unwrap(), None);
        }

        fn helper() -> std::path::PathBuf {
            std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("smithers-jj-export.exe")
        }

        fn guarded_owner(directory: &std::path::Path) -> OwnedChild {
            let pid_file = serde_json::to_string(&directory.join("descendant.pid")).unwrap();
            OwnedChild(Command::new("node").args(["-e", &format!(
                "require('node:readline').createInterface({{input:process.stdin}}).on('line',line=>{{
                  if(line==='start'){{const child=require('node:child_process').spawn(process.execPath,
                    ['-e','setInterval(()=>{{}},1000)'],{{detached:true,stdio:'ignore'}});
                    child.unref();require('node:fs').writeFileSync({pid_file},String(child.pid));}}
                  else process.exit(0);
                }});"
            )]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap())
        }

        fn guardian(
            owner: &OwnedChild,
            token: u64,
        ) -> (OwnedChild, std::sync::mpsc::Receiver<String>) {
            use std::io::BufRead as _;
            let mut child = OwnedChild(
                Command::new(helper())
                    .args([
                        "--process-job",
                        &owner.0.id().to_string(),
                        &token.to_string(),
                    ])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap(),
            );
            let output = child.0.stdout.take().unwrap();
            let (send, receive) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(output).lines() {
                    if send.send(line.unwrap()).is_err() {
                        break;
                    }
                }
            });
            (child, receive)
        }

        fn frame(receive: &std::sync::mpsc::Receiver<String>) -> serde_json::Value {
            serde_json::from_str(
                &receive
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .expect("guardian did not answer"),
            )
            .unwrap()
        }

        fn wait_child(child: &mut Child) -> std::process::ExitStatus {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    return status;
                }
                assert!(std::time::Instant::now() < deadline, "child did not exit");
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }

        #[test]
        fn exact_identity_mismatch_never_assigns_or_signals_the_owner() {
            let directory = tempfile::tempdir().unwrap();
            let mut owner = guarded_owner(directory.path());
            let token = identity(owner.0.id()).unwrap().unwrap();
            let output = Command::new(helper())
                .args([
                    "--process-job",
                    &owner.0.id().to_string(),
                    &(token + 1).to_string(),
                ])
                .output()
                .unwrap();
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
            assert!(owner.0.try_wait().unwrap().is_none());
            assert_eq!(identity(owner.0.id()).unwrap(), Some(token));
            owner.0.kill().unwrap();
            owner.0.wait().unwrap();
            let output = Command::new(helper())
                .args([
                    "--process-job",
                    &owner.0.id().to_string(),
                    &token.to_string(),
                ])
                .output()
                .unwrap();
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
        }

        fn exercise_job_stop(mode: &str) {
            use std::io::Write as _;
            let directory = tempfile::tempdir().unwrap();
            let mut owner = guarded_owner(directory.path());
            let mut unrelated = guarded_owner(directory.path());
            let token = identity(owner.0.id()).unwrap().unwrap();
            let (mut guard, receive) = guardian(&owner, token);
            assert_eq!(
                frame(&receive),
                serde_json::json!({"status":"ready", "ownerPid":owner.0.id()})
            );
            assert!(!directory.path().join("descendant.pid").exists());
            owner
                .0
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"start\n")
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let descendant = loop {
                if let Ok(text) = std::fs::read_to_string(directory.path().join("descendant.pid")) {
                    if let Ok(pid) = text.parse::<u32>() {
                        break pid;
                    }
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "owner did not start its descendant"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            };
            let pinned = open_process(
                descendant,
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            )
            .unwrap()
            .unwrap();
            assert!(running(&pinned).unwrap());
            match mode {
                "owner-exit" => owner
                    .0
                    .stdin
                    .as_mut()
                    .unwrap()
                    .write_all(b"exit\n")
                    .unwrap(),
                "host-disconnect" => drop(guard.0.stdin.take()),
                "guardian-crash" => guard.0.kill().unwrap(),
                _ => panic!("unknown fixture mode"),
            }
            if mode != "guardian-crash" {
                assert_eq!(frame(&receive), serde_json::json!({"status":"settled"}));
                assert!(wait_child(&mut guard.0).success());
            } else {
                wait_child(&mut guard.0);
            }
            wait_child(&mut owner.0);
            assert_eq!(
                unsafe { WaitForSingleObject(pinned.as_raw_handle(), 5000) },
                WAIT_OBJECT_0
            );
            assert!(unrelated.0.try_wait().unwrap().is_none());
        }

        #[test]
        fn job_cleans_detached_descendants_after_natural_owner_exit() {
            exercise_job_stop("owner-exit");
        }

        #[test]
        fn job_cleans_owner_and_descendants_when_host_disconnects() {
            exercise_job_stop("host-disconnect");
        }

        #[test]
        fn job_closes_owner_and_descendants_when_guardian_crashes() {
            exercise_job_stop("guardian-crash");
        }
    }
}
