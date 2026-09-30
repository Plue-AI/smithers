//! Windows namespace operations relative to pinned directory handles.
//!
//! Every path component is opened separately with reparse processing disabled.
//! No operation reconstructs an absolute path after opening the root.
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, Prefix};
use std::ptr;

use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FileDispositionInformation, FileNamesInformation, FileRenameInformation, NtCreateFile,
    NtQueryDirectoryFile, NtSetInformationFile, FILE_CREATE, FILE_DIRECTORY_FILE,
    FILE_DISPOSITION_INFORMATION, FILE_NAMES_INFORMATION, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    LocalFree, RtlNtStatusToDosError, HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, STATUS_NO_MORE_FILES,
    UNICODE_STRING,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, PSID, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::Storage::FileSystem::{
    FileBasicInfo, FileStandardInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    GetFileType, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_BASIC_INFO, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_STANDARD_INFO, FILE_TRAVERSE, FILE_TYPE_DISK, FILE_WRITE_ATTRIBUTES, SYNCHRONIZE,
};
use windows_sys::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT;
use windows_sys::Win32::System::SystemServices::{
    IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::System::IO::{DeviceIoControl, IO_STATUS_BLOCK};

/// LocalAlloc outputs from the security APIs must be released with LocalFree.
struct LocalAllocation(*mut std::ffi::c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this wrapper exclusively owns a LocalAlloc allocation.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn sid_string(sid: PSID) -> io::Result<String> {
    let mut output = ptr::null_mut();
    // SAFETY: callers supply a SID in a live token or security descriptor.
    if unsafe { ConvertSidToStringSidW(sid, &mut output) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let allocation = LocalAllocation(output.cast());
    // A string SID cannot exceed 184 ASCII characters (15 subauthorities).
    let mut length = 0;
    // SAFETY: the successful API returns a NUL-terminated wide string.
    unsafe {
        while *output.add(length) != 0 {
            length += 1;
        }
        let result = String::from_utf16(std::slice::from_raw_parts(output, length))
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData));
        drop(allocation);
        result
    }
}

fn current_user_sid() -> io::Result<String> {
    let mut token = ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a borrowed pseudo-handle; on success
    // OpenProcessToken transfers a real owned token handle.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful call returned a unique owned handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut size = 0;
    // SAFETY: a null zero-length output is the documented size query.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &mut size,
        );
    }
    if size < size_of::<TOKEN_USER>() as u32 || size > 65536 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    // SAFETY: the aligned output has at least the queried number of bytes.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: TokenUser filled a TOKEN_USER and its pointed-to SID in buffer.
    sid_string(unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid })
}

/// Private files grant the current user and SYSTEM access at creation time.
/// The protected DACL prevents a permissive parent from adding inherited ACEs.
fn private_security() -> io::Result<LocalAllocation> {
    let user = current_user_sid()?;
    let sddl: Vec<_> = format!("O:{user}D:P(A;;FA;;;{user})(A;;FA;;;SY)")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = ptr::null_mut();
    // SAFETY: input is NUL-terminated and the API allocates the output.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalAllocation(descriptor))
}

#[derive(Debug)]
pub(super) enum BoundaryError {
    InvalidPath,
    ReparsePoint,
    HardLink,
    NotRegular,
}

impl std::fmt::Display for BoundaryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "ambiguous or noncanonical Windows path",
            Self::ReparsePoint => "reparse point traversal denied",
            Self::HardLink => "hard-linked file denied",
            Self::NotRegular => "only regular files carry content",
        })
    }
}

impl std::error::Error for BoundaryError {}

fn denied(error: BoundaryError) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, error)
}

fn status_result(status: NTSTATUS) -> io::Result<()> {
    if status >= 0 {
        Ok(())
    } else {
        // SAFETY: conversion has no pointers or ownership requirements.
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ))
    }
}

fn name_units(name: &OsStr) -> io::Result<Vec<u16>> {
    let units: Vec<_> = name.encode_wide().collect();
    if units.is_empty()
        || units.len() > 255
        || units.iter().any(|unit| {
            *unit < 32
                || [
                    b'/' as u16,
                    b'\\' as u16,
                    b':' as u16,
                    b'"' as u16,
                    b'<' as u16,
                    b'>' as u16,
                    b'|' as u16,
                    b'?' as u16,
                    b'*' as u16,
                ]
                .contains(unit)
        })
        || matches!(units.last(), Some(32 | 46))
    {
        return Err(denied(BoundaryError::InvalidPath));
    }
    let stem = units.split(|unit| *unit == b'.' as u16).next().unwrap();
    let stem = String::from_utf16_lossy(stem)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let reserved_number = |prefix: &str| {
        stem.strip_prefix(prefix).is_some_and(|number| {
            matches!(
                number,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    };
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || reserved_number("COM")
        || reserved_number("LPT")
    {
        return Err(denied(BoundaryError::InvalidPath));
    }
    Ok(units)
}

/// Open an existing entry, never following its final reparse point.
fn open(
    parent: Option<&File>,
    name: Vec<u16>,
    access: u32,
    directory: bool,
    share_delete: bool,
) -> io::Result<File> {
    open_with(
        parent,
        name,
        access,
        directory,
        FILE_SHARE_READ | FILE_SHARE_WRITE | if share_delete { FILE_SHARE_DELETE } else { 0 },
        None,
    )
}

fn open_with(
    parent: Option<&File>,
    mut name: Vec<u16>,
    access: u32,
    directory: bool,
    share: u32,
    creation: Option<&LocalAllocation>,
) -> io::Result<File> {
    let length = u16::try_from(name.len() * 2).map_err(|_| denied(BoundaryError::InvalidPath))?;
    let name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.map_or(ptr::null_mut(), |file| file.as_raw_handle()),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: creation.map_or(ptr::null(), |value| value.0.cast()),
        ..Default::default()
    };
    let mut handle: HANDLE = ptr::null_mut();
    let mut result = IO_STATUS_BLOCK::default();
    // SAFETY: all buffers and attributes outlive this synchronous call. A
    // successful call transfers one owned handle to File below.
    status_result(unsafe {
        NtCreateFile(
            &mut handle,
            access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &attributes,
            &mut result,
            ptr::null(),
            0,
            share,
            if creation.is_some() {
                FILE_CREATE
            } else {
                FILE_OPEN
            },
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory { FILE_DIRECTORY_FILE } else { 0 },
            ptr::null(),
            0,
        )
    })?;
    // SAFETY: NtCreateFile succeeded and returned a newly owned file handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

pub(super) struct Info {
    pub(super) file: BY_HANDLE_FILE_INFORMATION,
    pub(super) basic: FILE_BASIC_INFO,
    pub(super) standard: FILE_STANDARD_INFO,
}

impl Info {
    pub(super) fn identity(&self) -> String {
        let inode =
            (u64::from(self.file.nFileIndexHigh) << 32) | u64::from(self.file.nFileIndexLow);
        format!("{}:{inode}", self.file.dwVolumeSerialNumber)
    }

    pub(super) fn fingerprint(&self) -> [i128; 9] {
        [
            self.file.dwVolumeSerialNumber as i128,
            ((u64::from(self.file.nFileIndexHigh) << 32) | u64::from(self.file.nFileIndexLow))
                as i128,
            self.basic.FileAttributes as i128,
            self.standard.NumberOfLinks as i128,
            self.standard.EndOfFile as i128,
            self.basic.LastWriteTime as i128,
            self.basic.ChangeTime as i128,
            self.basic.CreationTime as i128,
            self.standard.AllocationSize as i128,
        ]
    }

    /// Match the Node adapter's Windows stat fields. Its mode bits describe
    /// the readonly attribute; the DACL, checked separately, controls access.
    pub(super) fn stat_json(&self) -> io::Result<serde_json::Value> {
        if self.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(denied(BoundaryError::ReparsePoint));
        }
        let directory = self.basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        if !directory && self.standard.NumberOfLinks > 1 {
            return Err(denied(BoundaryError::HardLink));
        }
        let mode = if directory { 0o040000 } else { 0o100000 }
            | if self.basic.FileAttributes & FILE_ATTRIBUTE_READONLY != 0 {
                0o444
            } else {
                0o666
            };
        // FILETIME is a count of 100 ns intervals since 1601-01-01. Subtract
        // the epoch before converting to floating point to retain precision.
        let millis = |ticks: i64| (ticks as i128 - 116_444_736_000_000_000i128) as f64 / 10_000.0;
        let inode =
            (u64::from(self.file.nFileIndexHigh) << 32) | u64::from(self.file.nFileIndexLow);
        Ok(serde_json::json!({
            "type": if directory { "Directory" } else { "File" },
            "mtime": millis(self.basic.LastWriteTime),
            "atime": millis(self.basic.LastAccessTime),
            "birthtime": millis(self.basic.CreationTime),
            "dev": self.file.dwVolumeSerialNumber,
            // Effect's optional numeric inode cannot represent every NTFS ID.
            // Root identity remains an exact decimal string via identity().
            "ino": (inode <= 9_007_199_254_740_991).then_some(inode),
            "mode": mode,
            "nlink": self.standard.NumberOfLinks,
            "uid": 0, "gid": 0, "rdev": 0,
            "size": if directory { 0 } else { self.standard.EndOfFile }.to_string(),
            "blksize": "4096",
            "blocks": self.standard.AllocationSize / 512,
        }))
    }
}

pub(super) fn info(file: &File) -> io::Result<Info> {
    let mut value = Info {
        file: BY_HANDLE_FILE_INFORMATION::default(),
        basic: FILE_BASIC_INFO::default(),
        standard: FILE_STANDARD_INFO::default(),
    };
    // SAFETY: File owns a live handle; all output buffers have their declared
    // layout and size and stay valid for these synchronous calls.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value.file) } == 0
        || unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                (&mut value.basic as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        || unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileStandardInfo,
                (&mut value.standard as *mut FILE_STANDARD_INFO).cast(),
                size_of::<FILE_STANDARD_INFO>() as u32,
            )
        } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(value)
}

fn no_reparse(file: &File) -> io::Result<Info> {
    let info = info(file)?;
    if info.file.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(denied(BoundaryError::ReparsePoint));
    }
    Ok(info)
}

fn regular_file(file: &File) -> io::Result<()> {
    let value = no_reparse(file)?;
    // SAFETY: this only inspects the live owned handle's type.
    if value.file.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
        || unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
    {
        return Err(denied(BoundaryError::NotRegular));
    }
    if value.file.nNumberOfLinks > 1 {
        return Err(denied(BoundaryError::HardLink));
    }
    Ok(())
}

/// Decode the counted link payload without treating it as a C string or
/// following its destination. Offsets are relative to the variant's PathBuffer.
fn reparse_target(bytes: &[u8]) -> io::Result<OsString> {
    let invalid = || io::Error::from(io::ErrorKind::InvalidData);
    if bytes.len() < 8 {
        return Err(invalid());
    }
    let tag = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    let data_len = u16::from_le_bytes(bytes[4..6].try_into().unwrap()) as usize;
    let data = bytes.get(8..8 + data_len).ok_or_else(invalid)?;
    let header = match tag {
        IO_REPARSE_TAG_SYMLINK => 12,
        IO_REPARSE_TAG_MOUNT_POINT => 8,
        _ => return Err(io::Error::from(io::ErrorKind::Unsupported)),
    };
    if data.len() < header {
        return Err(invalid());
    }
    let offset = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    let length = u16::from_le_bytes(data[2..4].try_into().unwrap()) as usize;
    if !offset.is_multiple_of(2) || !length.is_multiple_of(2) || length == 0 {
        return Err(invalid());
    }
    let path = data
        .get(header + offset..header + offset + length)
        .ok_or_else(invalid)?;
    let mut units: Vec<_> = path
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    if units.contains(&0) {
        return Err(invalid());
    }
    let namespace: Vec<_> = r"\??\".encode_utf16().collect();
    let drive = units.starts_with(&namespace)
        && units.len() >= 6
        && ((b'A' as u16..=b'Z' as u16).contains(&units[4])
            || (b'a' as u16..=b'z' as u16).contains(&units[4]))
        && units[5] == b':' as u16
        && (units.len() == 6 || units[6] == b'\\' as u16);
    if tag == IO_REPARSE_TAG_MOUNT_POINT && !drive {
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    }
    if drive {
        units.drain(..4);
    } else if units.starts_with(&namespace)
        && units.len() >= 8
        && String::from_utf16_lossy(&units[4..8]).eq_ignore_ascii_case(r"UNC\")
    {
        // NT UNC becomes an ordinary Win32 UNC path, like Node's readlink.
        units.drain(..6);
        units[0] = b'\\' as u16;
    }
    Ok(OsString::from_wide(&units))
}

pub(super) struct Directory(File);

impl Directory {
    /// Recovery directories may be reused only with the exact private ACL we
    /// create. A pre-existing broadly accessible directory is not a private slot.
    pub(super) fn private_child(&self, name: &OsStr) -> io::Result<Self> {
        match self.create_private_directory(name) {
            Ok(directory) => Ok(directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let file = open(
                    Some(&self.0),
                    name_units(name)?,
                    FILE_LIST_DIRECTORY | FILE_TRAVERSE | 0x0002_0000, // READ_CONTROL
                    true,
                    false,
                )?;
                no_reparse(&file)?;
                verify_private(&file)?;
                Ok(Self(file))
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn root(path: &Path) -> io::Result<Self> {
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return Err(denied(BoundaryError::InvalidPath));
        };
        let mut device = OsString::from("\\??\\");
        match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                device.push(format!("{}:\\", char::from(drive)));
            }
            Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                name_units(server)?;
                name_units(share)?;
                device.push("UNC\\");
                device.push(server);
                device.push("\\");
                device.push(share);
                device.push("\\");
            }
            _ => return Err(denied(BoundaryError::InvalidPath)),
        }
        if components.next() != Some(Component::RootDir) {
            return Err(denied(BoundaryError::InvalidPath));
        }
        let mut current = Self(open(
            None,
            device.encode_wide().collect(),
            FILE_LIST_DIRECTORY | FILE_TRAVERSE,
            true,
            false,
        )?);
        no_reparse(&current.0)?;
        for component in components {
            match component {
                Component::Normal(name) => current = current.child(name)?,
                Component::CurDir => {}
                _ => return Err(denied(BoundaryError::InvalidPath)),
            }
        }
        Ok(current)
    }

    pub(super) fn try_clone(&self) -> io::Result<Self> {
        self.0.try_clone().map(Self)
    }

    pub(super) fn self_info(&self) -> io::Result<Info> {
        info(&self.0)
    }

    pub(super) fn child(&self, name: &OsStr) -> io::Result<Self> {
        let file = open(
            Some(&self.0),
            name_units(name)?,
            FILE_LIST_DIRECTORY | FILE_TRAVERSE,
            true,
            false,
        )?;
        no_reparse(&file)?;
        Ok(Self(file))
    }

    pub(super) fn identity(&self) -> io::Result<String> {
        Ok(info(&self.0)?.identity())
    }

    /// Canonical names come from the pinned handle, including long-name
    /// expansion of DOS 8.3 aliases. No absolute path is reopened.
    pub(super) fn canonical_path(&self, name: Option<&OsStr>) -> io::Result<String> {
        let file = match name {
            Some(name) => open(Some(&self.0), name_units(name)?, 0, false, false)?,
            None => self.0.try_clone()?,
        };
        // Only a reparse point is refused: a hard-linked file's name is an
        // answer, not content, and every content operation still refuses it.
        if info(&file)?.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(denied(BoundaryError::ReparsePoint));
        }
        // SAFETY: a zero-length buffer queries the required UTF-16 capacity.
        let size =
            unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), ptr::null_mut(), 0, 0) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        if size > 32_768 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut buffer = vec![0u16; size as usize + 1];
        // SAFETY: buffer has the advertised capacity and the file stays open.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length as usize >= buffer.len() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let path = String::from_utf16(&buffer[..length as usize])
            .map_err(|_| io::ErrorKind::InvalidData)?;
        if let Some(unc) = path.strip_prefix("\\\\?\\UNC\\") {
            return Ok(format!("\\\\{unc}"));
        }
        let path = path
            .strip_prefix("\\\\?\\")
            .ok_or(io::ErrorKind::InvalidData)?;
        Ok(path.to_owned())
    }

    pub(super) fn metadata(&self, name: &OsStr) -> io::Result<Info> {
        info(&open(Some(&self.0), name_units(name)?, 0, false, true)?)
    }

    pub(super) fn read_file(&self, name: &OsStr) -> io::Result<File> {
        let file = open(
            Some(&self.0),
            name_units(name)?,
            FILE_READ_DATA,
            false,
            true,
        )?;
        regular_file(&file)?;
        Ok(file)
    }

    /// Create without an intermediate broadly readable state. Existing entries,
    /// including dangling links, are never opened or overwritten by this call.
    pub(super) fn create_private_file(&self, name: &OsStr) -> io::Result<File> {
        let security = private_security()?;
        let file = open_with(
            Some(&self.0),
            name_units(name)?,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            false,
            FILE_SHARE_READ,
            Some(&security),
        )?;
        regular_file(&file)?;
        Ok(file)
    }

    pub(super) fn create_private_directory(&self, name: &OsStr) -> io::Result<Self> {
        let security = private_security()?;
        let file = open_with(
            Some(&self.0),
            name_units(name)?,
            FILE_GENERIC_READ | FILE_TRAVERSE,
            true,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            Some(&security),
        )?;
        no_reparse(&file)?;
        Ok(Self(file))
    }

    /// Opens without truncating. The caller may mutate only after the handle's
    /// type/link checks; denying write/delete sharing pins that checked entry.
    pub(super) fn write_existing_file(&self, name: &OsStr) -> io::Result<File> {
        let file = open_with(
            Some(&self.0),
            name_units(name)?,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            false,
            FILE_SHARE_READ,
            None,
        )?;
        regular_file(&file)?;
        Ok(file)
    }

    /// Windows chmod changes the readonly attribute. It must preserve the
    /// existing DACL and must never follow an alias to another file.
    pub(super) fn set_readonly(&self, name: &OsStr, readonly: bool) -> io::Result<()> {
        let file = open_with(
            Some(&self.0),
            name_units(name)?,
            FILE_WRITE_ATTRIBUTES,
            false,
            FILE_SHARE_READ,
            None,
        )?;
        regular_file(&file)?;
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(readonly);
        file.set_permissions(permissions)
    }

    pub(super) fn read_link(&self, name: &OsStr) -> io::Result<OsString> {
        let file = open(Some(&self.0), name_units(name)?, 0, false, true)?;
        let mut buffer = vec![0u64; 2048];
        let mut used = 0;
        // SAFETY: the live handle was opened with OPEN_REPARSE_POINT. The
        // aligned 16 KiB output buffer and byte count stay valid for the call.
        if unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_GET_REPARSE_POINT,
                ptr::null(),
                0,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut used,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if used as usize > buffer.len() * 8 {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        // SAFETY: only the returned initialized bytes are passed to the parser.
        reparse_target(unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast(), used as usize) })
    }

    pub(super) fn entries(&self, limit: usize) -> io::Result<Vec<OsString>> {
        let mut entries = Vec::new();
        // u64 storage provides alignment for every directory information field.
        let mut buffer = vec![0u64; 8192];
        let mut restart = true;
        loop {
            let mut result = IO_STATUS_BLOCK::default();
            // SAFETY: a synchronous directory handle, aligned writable buffer,
            // and live status block satisfy NtQueryDirectoryFile's contract.
            let status = unsafe {
                NtQueryDirectoryFile(
                    self.0.as_raw_handle(),
                    ptr::null_mut(),
                    None,
                    ptr::null(),
                    &mut result,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * size_of::<u64>()) as u32,
                    FileNamesInformation,
                    false,
                    ptr::null(),
                    restart,
                )
            };
            if status == STATUS_NO_MORE_FILES {
                break;
            }
            status_result(status)?;
            restart = false;
            let used = result.Information;
            if used == 0 || used > buffer.len() * size_of::<u64>() {
                return Err(io::Error::from(io::ErrorKind::InvalidData));
            }
            let mut offset = 0;
            loop {
                const HEADER: usize = offset_of!(FILE_NAMES_INFORMATION, FileName);
                if used - offset < HEADER {
                    return Err(io::Error::from(io::ErrorKind::InvalidData));
                }
                // SAFETY: only the fixed 12-byte header is read. Reading the
                // whole C structure would include its flexible array and padding.
                let (next, length) = unsafe {
                    let record = buffer.as_ptr().cast::<u8>().add(offset);
                    (
                        ptr::read_unaligned(record.cast::<u32>()) as usize,
                        ptr::read_unaligned(record.add(8).cast::<u32>()) as usize,
                    )
                };
                if length % 2 != 0 || length > used - offset - HEADER {
                    return Err(io::Error::from(io::ErrorKind::InvalidData));
                }
                // SAFETY: the complete UTF-16 name lies within the initialized
                // response and each record starts at an even byte offset.
                let name = unsafe {
                    std::slice::from_raw_parts(
                        buffer
                            .as_ptr()
                            .cast::<u8>()
                            .add(offset + HEADER)
                            .cast::<u16>(),
                        length / 2,
                    )
                };
                if name != [b'.' as u16] && name != [b'.' as u16, b'.' as u16] {
                    entries.push(OsString::from_wide(name));
                    if entries.len() > limit {
                        return Err(io::Error::new(
                            io::ErrorKind::FileTooLarge,
                            "directory entry limit exceeded",
                        ));
                    }
                }
                if next == 0 {
                    break;
                }
                if next < HEADER + length || next % 2 != 0 || next >= used - offset {
                    return Err(io::Error::from(io::ErrorKind::InvalidData));
                }
                offset += next;
            }
        }
        entries.sort();
        Ok(entries)
    }

    pub(super) fn remove(&self, name: &OsStr) -> io::Result<()> {
        let file = open(Some(&self.0), name_units(name)?, DELETE, false, true)?;
        no_reparse(&file)?;
        let disposition = FILE_DISPOSITION_INFORMATION { DeleteFile: true };
        let mut result = IO_STATUS_BLOCK::default();
        // SAFETY: both structures have the expected layout and the live file
        // was opened with DELETE. The kernel removes that opened entry.
        status_result(unsafe {
            NtSetInformationFile(
                file.as_raw_handle(),
                &mut result,
                (&disposition as *const FILE_DISPOSITION_INFORMATION).cast(),
                size_of::<FILE_DISPOSITION_INFORMATION>() as u32,
                FileDispositionInformation,
            )
        })
    }

    pub(super) fn rename(&self, name: &OsStr, destination: &Self, to: &OsStr) -> io::Result<()> {
        let file = open(Some(&self.0), name_units(name)?, DELETE, false, true)?;
        no_reparse(&file)?;
        match destination.metadata(to) {
            Ok(info) if info.file.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                return Err(denied(BoundaryError::ReparsePoint));
            }
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let name = name_units(to)?;
        const HEADER: usize = offset_of!(FILE_RENAME_INFORMATION, FileName);
        let length = HEADER + name.len() * size_of::<u16>();
        let mut buffer = vec![0u64; length.div_ceil(size_of::<u64>())];
        // SAFETY: the u64 buffer is sufficiently large and aligned for the
        // fixed header followed by the exact counted UTF-16 file name.
        unsafe {
            let value = &mut *buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
            value.Anonymous.ReplaceIfExists = true;
            value.RootDirectory = destination.0.as_raw_handle();
            value.FileNameLength = (name.len() * 2) as u32;
            ptr::copy_nonoverlapping(
                name.as_ptr(),
                buffer.as_mut_ptr().cast::<u8>().add(HEADER).cast::<u16>(),
                name.len(),
            );
        }
        let mut result = IO_STATUS_BLOCK::default();
        // SAFETY: all referenced handles and buffers remain live throughout
        // the synchronous rename, whose destination is relative to its handle.
        status_result(unsafe {
            NtSetInformationFile(
                file.as_raw_handle(),
                &mut result,
                buffer.as_ptr().cast(),
                length as u32,
                FileRenameInformation,
            )
        })
    }
}

fn verify_private(file: &File) -> io::Result<()> {
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        GetAce, GetSecurityDescriptorControl, ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED,
    };
    let mut owner = ptr::null_mut();
    let mut dacl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: returned pointers belong to the allocated descriptor.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let _allocation = LocalAllocation(descriptor);
    let user = current_user_sid()?;
    let refusal = || io::Error::from(io::ErrorKind::PermissionDenied);
    if owner.is_null() || sid_string(owner)? != user || dacl.is_null() {
        return Err(refusal());
    }
    let mut control = 0;
    let mut revision = 0;
    // SAFETY: the successful security query supplied a valid descriptor/ACL.
    unsafe {
        if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0 {
            return Err(io::Error::last_os_error());
        }
        if control & SE_DACL_PROTECTED == 0 || (*dacl).AceCount != 2 {
            return Err(refusal());
        }
        let mut trustees = Vec::new();
        for index in 0..2 {
            let mut ace = ptr::null_mut();
            if GetAce(dacl, index, &mut ace) == 0 {
                return Err(io::Error::last_os_error());
            }
            let header = &*ace.cast::<windows_sys::Win32::Security::ACE_HEADER>();
            if header.AceType != 0
                || header.AceFlags != 0
                || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
            {
                return Err(refusal());
            }
            let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            if ace.Mask != 0x1f01ff {
                return Err(refusal());
            }
            trustees.push(sid_string(ptr::addr_of!(ace.SidStart).cast_mut().cast())?);
        }
        trustees.sort();
        let mut expected = vec![user, "S-1-5-18".to_owned()];
        expected.sort();
        if trustees != expected {
            return Err(refusal());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::os::windows::fs::{symlink_dir, symlink_file};

    #[test]
    fn rejects_aliases_streams_and_traversal_components() {
        for name in [
            "",
            ".",
            "..",
            "../file",
            "child\\file",
            "file:stream",
            "file.",
            "file ",
            "NUL",
            "nul.txt",
            "CON .txt",
            "COM1",
            "COM¹.txt",
            "LPT9",
            "LPT².txt",
            "x\0y",
            "a?",
            "a*",
            "a|b",
            "a<b",
            "a>b",
            "a\"b",
        ] {
            assert!(name_units(OsStr::new(name)).is_err(), "{name:?}");
        }
        for name in ["file", "file.txt", "COM10.txt", "a b", "café.txt", "[name]"] {
            assert!(name_units(OsStr::new(name)).is_ok(), "{name:?}");
        }
    }

    #[test]
    fn reads_enumerates_renames_and_removes_inside_open_directories() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("child")).unwrap();
        fs::write(temp.path().join("child/before"), "retained bytes").unwrap();
        let root = Directory::root(temp.path()).unwrap();
        assert!(!root.identity().unwrap().is_empty());
        let child = root.child(OsStr::new("child")).unwrap();
        assert_eq!(child.entries(10).unwrap(), [OsString::from("before")]);
        // A second enumeration must restart the native directory cursor.
        assert_eq!(child.entries(10).unwrap(), [OsString::from("before")]);
        let mut bytes = String::new();
        child
            .read_file(OsStr::new("before"))
            .unwrap()
            .read_to_string(&mut bytes)
            .unwrap();
        assert_eq!(bytes, "retained bytes");
        child
            .rename(OsStr::new("before"), &root, OsStr::new("after"))
            .unwrap();
        assert_eq!(
            fs::read_to_string(temp.path().join("after")).unwrap(),
            "retained bytes"
        );
        assert!(!temp.path().join("child/before").exists());
        root.remove(OsStr::new("after")).unwrap();
        assert!(!temp.path().join("after").exists());
        drop(child);
        root.remove(OsStr::new("child")).unwrap();
        assert!(root.entries(10).unwrap().is_empty());
    }

    #[test]
    fn refuses_file_and_directory_links_without_touching_the_target() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "outside").unwrap();
        symlink_dir(outside.path(), temp.path().join("escape")).unwrap();
        symlink_file(outside.path().join("secret"), temp.path().join("link")).unwrap();
        let root = Directory::root(temp.path()).unwrap();
        assert!(root.child(OsStr::new("escape")).is_err());
        assert!(Directory::root(&temp.path().join("escape")).is_err());
        assert!(root.read_file(OsStr::new("link")).is_err());
        assert!(root.remove(OsStr::new("link")).is_err());
        assert!(root
            .rename(OsStr::new("link"), &root, OsStr::new("moved"))
            .is_err());
        fs::write(temp.path().join("safe"), "inside").unwrap();
        assert!(root
            .rename(OsStr::new("safe"), &root, OsStr::new("link"))
            .is_err());
        fs::hard_link(outside.path().join("secret"), temp.path().join("hard")).unwrap();
        assert!(root.read_file(OsStr::new("hard")).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "outside"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("safe")).unwrap(),
            "inside"
        );
    }

    fn assert_private(file: &File) {
        use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{
            GetAce, GetSecurityDescriptorControl, ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION,
            OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        };
        let mut owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        // SAFETY: all returned pointers belong to descriptor until LocalFree.
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
                    &mut owner,
                    ptr::null_mut(),
                    &mut dacl,
                    ptr::null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let allocation = LocalAllocation(descriptor);
        assert_eq!(sid_string(owner).unwrap(), current_user_sid().unwrap());
        assert!(
            !dacl.is_null(),
            "NULL DACL would grant everyone full access"
        );
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: descriptor and dacl came from the successful query above.
        unsafe {
            assert_ne!(
                GetSecurityDescriptorControl(descriptor, &mut control, &mut revision),
                0
            );
            assert_ne!(control & SE_DACL_PROTECTED, 0);
            assert_eq!((*dacl).AceCount, 2);
            let mut trustees = Vec::new();
            for index in 0..2 {
                let mut ace = ptr::null_mut();
                assert_ne!(GetAce(dacl, index, &mut ace), 0);
                let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                assert_eq!(ace.Header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
                assert_eq!(ace.Header.AceFlags, 0); // no inherited or inheritable grants
                assert_eq!(ace.Mask, 0x1f01ff); // FILE_ALL_ACCESS
                trustees.push(sid_string(ptr::addr_of!(ace.SidStart).cast_mut().cast()).unwrap());
            }
            trustees.sort();
            let mut expected = vec![current_user_sid().unwrap(), "S-1-5-18".to_owned()];
            expected.sort();
            assert_eq!(trustees, expected);
        }
        drop(allocation);
    }

    #[test]
    fn creates_private_files_and_directories_with_protected_access() {
        let temp = tempfile::tempdir().unwrap();
        let root = Directory::root(temp.path()).unwrap();
        let child = root
            .create_private_directory(OsStr::new("private"))
            .unwrap();
        assert_private(&child.0);
        let mut file = child.create_private_file(OsStr::new("secret")).unwrap();
        assert_private(&file);
        verify_private(&file).unwrap();
        root.private_child(OsStr::new("private")).unwrap();
        fs::create_dir(temp.path().join("broad")).unwrap();
        assert_eq!(
            root.private_child(OsStr::new("broad"))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        file.write_all(b"private content").unwrap();
        file.sync_all().unwrap();
        // Neither another writer nor a rename can invalidate a checked write.
        assert!(child.write_existing_file(OsStr::new("secret")).is_err());
        assert!(fs::rename(
            temp.path().join("private/secret"),
            temp.path().join("moved")
        )
        .is_err());
        drop(file);
        assert_eq!(
            fs::read(temp.path().join("private/secret")).unwrap(),
            b"private content"
        );
        assert!(root
            .create_private_directory(OsStr::new("private"))
            .is_err());
        assert!(child.create_private_file(OsStr::new("secret")).is_err());
        let mut file = child.write_existing_file(OsStr::new("secret")).unwrap();
        file.set_len(0).unwrap();
        file.write_all(b"replacement").unwrap();
        file.sync_all().unwrap();
        assert_private(&file);
        drop(file);
        assert_eq!(
            fs::read(temp.path().join("private/secret")).unwrap(),
            b"replacement"
        );
    }

    #[test]
    fn refuses_writes_and_creation_over_links_before_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret");
        fs::write(&secret, b"outside").unwrap();
        symlink_file(&secret, temp.path().join("link")).unwrap();
        symlink_file(outside.path().join("missing"), temp.path().join("dangling")).unwrap();
        fs::hard_link(&secret, temp.path().join("hard")).unwrap();
        symlink_dir(outside.path(), temp.path().join("directory")).unwrap();
        let root = Directory::root(temp.path()).unwrap();
        for name in ["link", "dangling", "hard", "directory"] {
            assert!(
                root.write_existing_file(OsStr::new(name)).is_err(),
                "{name}"
            );
            assert!(
                root.create_private_file(OsStr::new(name)).is_err(),
                "{name}"
            );
            assert!(
                root.create_private_directory(OsStr::new(name)).is_err(),
                "{name}"
            );
        }
        assert_eq!(fs::read(&secret).unwrap(), b"outside");
        assert!(!outside.path().join("missing").exists());
    }

    #[test]
    fn reads_link_payloads_without_resolving_the_destination() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let absolute = outside.path().join("absent");
        symlink_file(&absolute, temp.path().join("absolute")).unwrap();
        symlink_file("missing", temp.path().join("relative")).unwrap();
        fs::write(temp.path().join("regular"), b"regular").unwrap();
        let root = Directory::root(temp.path()).unwrap();
        assert_eq!(
            root.read_link(OsStr::new("absolute")).unwrap(),
            absolute.as_os_str()
        );
        assert_eq!(root.read_link(OsStr::new("relative")).unwrap(), "missing");
        assert!(root.read_link(OsStr::new("regular")).is_err());
        assert!(!absolute.exists());
        assert!(!temp.path().join("missing").exists());
        // A junction is an entry whose payload can be inspected, never a
        // directory through which the confined filesystem may descend.
        let junction = temp.path().join("junction");
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            root.read_link(OsStr::new("junction")).unwrap(),
            outside.path().as_os_str()
        );
        assert!(root.child(OsStr::new("junction")).is_err());
        // Remove only the junction, never its destination.
        fs::remove_dir(&junction).unwrap();
        assert!(outside.path().exists());
    }

    #[test]
    fn rejects_malformed_reparse_payloads_and_preserves_namespaces() {
        fn payload(tag: u32, name: &str) -> Vec<u8> {
            let header = if tag == IO_REPARSE_TAG_SYMLINK { 12 } else { 8 };
            let path: Vec<u8> = name.encode_utf16().flat_map(u16::to_le_bytes).collect();
            let mut buffer = vec![0; 8 + header];
            buffer[0..4].copy_from_slice(&tag.to_le_bytes());
            buffer[4..6].copy_from_slice(&((header + path.len()) as u16).to_le_bytes());
            buffer[10..12].copy_from_slice(&(path.len() as u16).to_le_bytes());
            buffer.extend(path);
            buffer
        }
        for (name, expected) in [
            (r"\??\C:\target", r"C:\target"),
            (r"\??\UNC\server\share\target", r"\\server\share\target"),
            (r"\\?\C:\target", r"\\?\C:\target"),
            (r"..\relative", r"..\relative"),
        ] {
            assert_eq!(
                reparse_target(&payload(IO_REPARSE_TAG_SYMLINK, name)).unwrap(),
                expected
            );
        }
        let valid = payload(IO_REPARSE_TAG_SYMLINK, "target");
        for length in 0..valid.len() {
            assert!(reparse_target(&valid[..length]).is_err());
        }
        let mut odd = valid.clone();
        odd[8] = 1;
        assert!(reparse_target(&odd).is_err());
        let mut overflow = valid.clone();
        overflow[10..12].copy_from_slice(&u16::MAX.to_le_bytes());
        assert!(reparse_target(&overflow).is_err());
        assert!(reparse_target(&payload(IO_REPARSE_TAG_SYMLINK, "a\0b")).is_err());
        assert!(
            reparse_target(&payload(IO_REPARSE_TAG_MOUNT_POINT, r"\??\Volume{unknown}")).is_err()
        );
        assert!(reparse_target(&payload(0, "unknown")).is_err());
    }

    #[test]
    fn canonical_names_come_from_handles_instead_of_the_callers_spelling() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("CanonicalDirectory");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("Mémoire.txt"), b"canonical").unwrap();
        let root = Directory::root(&temporary.path().join("canonicaldirectory")).unwrap();
        for (name, expected) in [
            (None, directory.clone()),
            (
                Some(OsStr::new("mémoire.txt")),
                directory.join("Mémoire.txt"),
            ),
        ] {
            let native = std::process::Command::new("node")
                .args([
                    "-e",
                    "console.log(JSON.stringify(require('node:fs').realpathSync.native(process.argv[1])))",
                ])
                .arg(expected)
                .output()
                .unwrap();
            assert!(native.status.success());
            let expected: String = serde_json::from_slice(&native.stdout).unwrap();
            assert_eq!(root.canonical_path(name).unwrap(), expected);
        }
        fs::hard_link(directory.join("Mémoire.txt"), directory.join("hard")).unwrap();
        // Kernel authorization canonicalizes through this answer (#2882).
        let hard = root.canonical_path(Some(OsStr::new("hard"))).unwrap();
        assert!(
            [directory.join("hard"), directory.join("Mémoire.txt")]
                .iter()
                .any(|path| path.to_str() == Some(hard.as_str())),
            "{hard}"
        );
    }

    #[test]
    fn optional_numeric_inodes_never_round_an_exact_root_identity() {
        let temporary = tempfile::tempfile().unwrap();
        let mut metadata = info(&temporary).unwrap();
        metadata.file.dwVolumeSerialNumber = 7;
        metadata.file.nFileIndexHigh = 0x20_0000;
        metadata.file.nFileIndexLow = 1;
        assert_eq!(metadata.identity(), "7:9007199254740993");
        assert!(metadata.stat_json().unwrap()["ino"].is_null());
        metadata.file.nFileIndexHigh = 0x1f_ffff;
        metadata.file.nFileIndexLow = u32::MAX;
        assert_eq!(
            metadata.stat_json().unwrap()["ino"].as_u64(),
            Some(9_007_199_254_740_991)
        );
    }

    #[test]
    fn stat_fields_match_node_and_fingerprints_detect_content_changes() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("empty"), b"").unwrap();
        fs::write(temp.path().join("content"), vec![1u8; 9000]).unwrap();
        fs::write(temp.path().join("readonly"), b"retained").unwrap();
        fs::create_dir(temp.path().join("directory")).unwrap();
        let readonly = temp.path().join("readonly");
        let original_permissions = fs::metadata(&readonly).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&readonly, permissions).unwrap();
        let root = Directory::root(temp.path()).unwrap();
        for name in ["empty", "content", "readonly", "directory"] {
            let ours = root
                .metadata(OsStr::new(name))
                .unwrap()
                .stat_json()
                .unwrap();
            let output = std::process::Command::new("node").arg("-e").arg(
                "const s=require('node:fs').lstatSync(process.argv[1]);console.log(JSON.stringify({type:s.isDirectory()?'Directory':'File',mtime:s.mtimeMs,atime:s.atimeMs,birthtime:s.birthtimeMs,dev:s.dev,ino:Number.isSafeInteger(s.ino)?s.ino:null,mode:s.mode,nlink:s.nlink,uid:s.uid,gid:s.gid,rdev:s.rdev,size:String(s.size),blksize:String(s.blksize),blocks:s.blocks}))"
            ).arg(temp.path().join(name)).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let native: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            for (key, value) in ours.as_object().unwrap() {
                if ["mtime", "atime", "birthtime"].contains(&key.as_str()) {
                    assert!(
                        (value.as_f64().unwrap() - native[key].as_f64().unwrap()).abs() <= 1.0,
                        "{name}: {key}"
                    );
                } else {
                    assert_eq!(value, &native[key], "{name}: {key}");
                }
            }
        }
        let before = root.metadata(OsStr::new("content")).unwrap().fingerprint();
        fs::write(temp.path().join("content"), b"changed").unwrap();
        let after = root.metadata(OsStr::new("content")).unwrap().fingerprint();
        assert_ne!(before, after);
        fs::set_permissions(&readonly, original_permissions).unwrap();
        symlink_file("content", temp.path().join("link")).unwrap();
        assert!(root
            .metadata(OsStr::new("link"))
            .unwrap()
            .stat_json()
            .is_err());
        fs::hard_link(temp.path().join("content"), temp.path().join("hard")).unwrap();
        assert!(root
            .metadata(OsStr::new("hard"))
            .unwrap()
            .stat_json()
            .is_err());
    }

    #[test]
    fn pins_the_root_and_bounds_enumeration() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("root");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("a"), "a").unwrap();
        fs::write(path.join("b"), "b").unwrap();
        let root = Directory::root(&path).unwrap();
        assert!(root.entries(1).is_err());
        assert!(fs::rename(&path, temp.path().join("moved")).is_err());
        assert_eq!(fs::read_to_string(path.join("a")).unwrap(), "a");
        drop(root);
        fs::rename(&path, temp.path().join("moved")).unwrap();
    }
}
