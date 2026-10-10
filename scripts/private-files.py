#!/usr/bin/env python3
"""Create and validate private producer files on POSIX and Windows.

Windows security is enforced with native owner and DACL checks. chmod is not a
Windows privacy mechanism and is never used as a fallback there.
"""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import stat


class PrivateFileError(ValueError):
    """A path does not meet the private-file policy."""


def _validate_acl_policy(*, owner_matches: bool, dacl_protected: bool,
                         dacl_present: bool, dacl_is_null: bool,
                         aces: list[dict], current_sid: object,
                         directory: bool = False) -> None:
    """Pure policy check used by the Win32 adapter and platform-independent tests.

    Each ACE record has ``kind``, ``sid``, ``flags`` and a nonzero ``mask``. Only explicit allow
    ACEs for the current user are accepted. Directories may propagate their
    explicit ACE to children with OBJECT_INHERIT_ACE and CONTAINER_INHERIT_ACE.
    That rejects inherited, deny,
    object-specific, callback, and broad-principal ACEs without trying to
    interpret policy extensions this helper does not understand.
    """
    if not owner_matches or not dacl_protected or not dacl_present or dacl_is_null:
        raise PrivateFileError("Windows owner or protected DACL check failed")
    if not isinstance(aces, list) or not aces:
        raise PrivateFileError("Windows DACL is empty or malformed")
    allowed = 0
    for ace in aces:
        if not isinstance(ace, dict) or ace.get("kind") != "allow":
            raise PrivateFileError("Windows DACL contains an unsupported ACE")
        flags = ace.get("flags")
        allowed_flags = 0x03 if directory else 0
        if (not isinstance(flags, int) or isinstance(flags, bool) or flags & ~allowed_flags
                or ace.get("sid") != current_sid
                or not isinstance(ace.get("mask"), int) or isinstance(ace.get("mask"), bool)
                or ace["mask"] <= 0):
            raise PrivateFileError("Windows DACL contains inherited or broad access")
        allowed += 1
    if not allowed:
        raise PrivateFileError("Windows DACL does not grant the current user access")


def _path_components(path: Path):
    """Yield absolute path prefixes, including the drive or UNC root."""
    absolute = path.absolute()
    current = Path(absolute.anchor)
    if not current:
        raise PrivateFileError("path must be absolute")
    yield current
    for part in absolute.parts[1:]:
        current = current / part
        yield current


def _check_no_reparse_components(path: Path) -> None:
    if os.name == "nt":
        _win32_check_no_reparse_components(path)
        return
    for component in _path_components(path):
        try:
            info = component.lstat()
        except FileNotFoundError as exc:
            raise PrivateFileError("path component does not exist") from exc
        if stat.S_ISLNK(info.st_mode):
            raise PrivateFileError("symlink paths are not allowed")


def assert_private_file(path: str | os.PathLike[str]) -> Path:
    """Validate an existing regular private file and all path components."""
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise PrivateFileError("private path must be absolute")
    _check_no_reparse_components(target)
    try:
        info = target.lstat()
    except OSError as exc:
        raise PrivateFileError("private file is unavailable") from exc
    if not stat.S_ISREG(info.st_mode):
        raise PrivateFileError("private path must be a regular file")
    if os.name == "nt":
        _win32_assert_private(target, directory=False)
    elif stat.S_IMODE(info.st_mode) != 0o600:
        raise PrivateFileError("private files must have mode 0600")
    return target


def assert_regular_file_no_reparse(path: str | os.PathLike[str]) -> Path:
    """Validate a regular file and its path without imposing private permissions."""
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise PrivateFileError("file path must be absolute")
    _check_no_reparse_components(target)
    try:
        info = target.lstat()
    except OSError as exc:
        raise PrivateFileError("file is unavailable") from exc
    if not stat.S_ISREG(info.st_mode):
        raise PrivateFileError("path must be a regular file")
    return target


def assert_directory_no_reparse(path: str | os.PathLike[str]) -> Path:
    """Validate an existing directory and its path without ACL/mode policy."""
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise PrivateFileError("directory path must be absolute")
    _check_no_reparse_components(target)
    try:
        info = target.lstat()
    except OSError as exc:
        raise PrivateFileError("directory is unavailable") from exc
    if not stat.S_ISDIR(info.st_mode):
        raise PrivateFileError("path must be a directory")
    return target


def assert_private_directory(path: str | os.PathLike[str]) -> Path:
    """Validate an existing private directory and all path components."""
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise PrivateFileError("private path must be absolute")
    _check_no_reparse_components(target)
    try:
        info = target.lstat()
    except OSError as exc:
        raise PrivateFileError("private directory is unavailable") from exc
    if not stat.S_ISDIR(info.st_mode):
        raise PrivateFileError("private path must be a directory")
    if os.name == "nt":
        _win32_assert_private(target, directory=True)
    elif stat.S_IMODE(info.st_mode) != 0o700:
        raise PrivateFileError("private directories must have mode 0700")
    return target


def assert_private_path(path: str | os.PathLike[str], *, directory: bool) -> Path:
    """Validate a private file or directory according to its expected type."""
    return assert_private_directory(path) if directory else assert_private_file(path)


def ensure_private_directory(path: str | os.PathLike[str]) -> Path:
    """Create a private directory or validate an existing one.

    Newly created Windows directories receive a protected DACL at creation
    time, so they never briefly inherit access from a broader parent.
    """
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise PrivateFileError("private directory path must be absolute")
    # Check existing ancestors before creating anything. Missing suffixes are
    # created one level at a time and validated immediately.
    missing: list[Path] = []
    current = target
    while True:
        try:
            current.lstat()
            break
        except FileNotFoundError:
            missing.append(current)
            if current == current.parent:
                raise PrivateFileError("path root does not exist")
            current = current.parent
    _check_no_reparse_components(current)
    for directory in reversed(missing):
        if os.name == "nt":
            _win32_create_directory(directory)
        else:
            try:
                directory.mkdir(mode=0o700)
            except FileExistsError:
                pass
            os.chmod(directory, 0o700)
        _check_no_reparse_components(directory)
        if os.name != "nt":
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise PrivateFileError("created private path is not a directory")
    if os.name == "nt":
        assert_private_directory(target)
    else:
        # Match the bridge's established POSIX behavior for an existing
        # outbox: tighten it to owner-only, then verify the resulting object.
        try:
            if not stat.S_ISDIR(target.lstat().st_mode):
                raise PrivateFileError("private path must be a directory")
            os.chmod(target, 0o700)
        except OSError as exc:
            raise PrivateFileError("private directory is unavailable") from exc
        assert_private_directory(target)
    return target


def create_private_file(path: str | os.PathLike[str], data: bytes) -> Path:
    """Create a new file with private permissions; refuse to overwrite."""
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise PrivateFileError("private file path must be absolute")
    assert_private_directory(target.parent)
    if os.name == "nt":
        _win32_create_file(target, data)
    else:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(target, flags, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    return assert_private_file(target)


def ensure_private_sqlite_database(path: str | os.PathLike[str]) -> Path:
    """Create a new SQLite database file privately, or validate an existing one."""
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise PrivateFileError("SQLite path must be absolute")
    assert_private_directory(target.parent)
    if target.exists() or target.is_symlink():
        return assert_private_file(target)
    return create_private_file(target, b"")


def secure_sqlite_artifacts(path: str | os.PathLike[str]) -> None:
    """Validate and secure the database plus its SQLite sidecars.

    SQLite creates WAL, SHM and rollback-journal files itself. A validated
    owner-only parent directory limits their inherited access at creation;
    inherited current-user-only ACEs are then converted to protected explicit
    ACEs with identical masks. Foreign owners or any other principal fail
    closed and are never repaired.
    """
    database = Path(path).expanduser()
    if not database.is_absolute():
        raise PrivateFileError("SQLite path must be absolute")
    assert_private_directory(database.parent)
    artifacts = (database, Path(str(database) + "-wal"),
                 Path(str(database) + "-shm"), Path(str(database) + "-journal"))
    for artifact in artifacts:
        if not artifact.exists() and not artifact.is_symlink():
            continue
        assert_regular_file_no_reparse(artifact)
        if os.name == "nt":
            _win32_harden_sqlite_file(artifact)
        else:
            try:
                os.chmod(artifact, 0o600)
            except OSError as exc:
                raise PrivateFileError("SQLite artifact permissions could not be secured") from exc
        assert_private_file(artifact)


def atomic_write_private(path: str | os.PathLike[str], data: bytes) -> Path:
    """Atomically replace a file inside a validated private directory."""
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise PrivateFileError("private file path must be absolute")
    parent = assert_private_directory(target.parent)
    # A temporary file is created with private security at creation time. The
    # rename is allowed only within the already-validated protected directory.
    temporary = parent / (".private-" + secrets.token_hex(16))
    created = False
    try:
        create_private_file(temporary, data)
        created = True
        if target.exists() or target.is_symlink():
            _check_no_reparse_components(target)
            assert_private_file(target)
        os.replace(temporary, target)
        return assert_private_file(target)
    finally:
        if created:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    _SE_FILE_OBJECT = 1
    _OWNER_SECURITY_INFORMATION = 0x1
    _DACL_SECURITY_INFORMATION = 0x4
    _SE_DACL_PROTECTED = 0x1000
    _FILE_ATTRIBUTE_REPARSE_POINT = 0x400
    _INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF
    _GENERIC_ALL = 0x10000000
    _TOKEN_QUERY = 0x0008
    _TOKEN_USER_CLASS = 1
    _ACL_REVISION = 2
    _ACCESS_ALLOWED_ACE_TYPE = 0
    _INHERITED_ACE = 0x10
    _OBJECT_INHERIT_ACE = 0x01
    _CONTAINER_INHERIT_ACE = 0x02
    _PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
    _CREATE_NEW = 1
    _FILE_ATTRIBUTE_NORMAL = 0x80
    _FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    class _SID_AND_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]

    class _TOKEN_USER(ctypes.Structure):
        _fields_ = [("User", _SID_AND_ATTRIBUTES)]

    class _SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                    ("bInheritHandle", wintypes.BOOL)]

    class _ACL_SIZE_INFORMATION(ctypes.Structure):
        _fields_ = [("AceCount", wintypes.DWORD), ("AclBytesInUse", wintypes.DWORD),
                    ("AclBytesFree", wintypes.DWORD)]

    # Explicit prototypes are required on 64-bit Windows: ctypes otherwise
    # assumes a 32-bit integer return and truncates HANDLE/descriptor pointers.
    _kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
    _kernel32.GetFileAttributesW.restype = wintypes.DWORD
    _kernel32.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(_SECURITY_ATTRIBUTES)]
    _kernel32.CreateDirectoryW.restype = wintypes.BOOL
    _kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.POINTER(_SECURITY_ATTRIBUTES), wintypes.DWORD,
                                      wintypes.DWORD, wintypes.HANDLE]
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                                    ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    _kernel32.WriteFile.restype = wintypes.BOOL
    _kernel32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
    _kernel32.FlushFileBuffers.restype = wintypes.BOOL
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    _kernel32.LocalFree.restype = ctypes.c_void_p
    _advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    _advapi32.OpenProcessToken.restype = wintypes.BOOL
    _advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                               wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    _advapi32.GetTokenInformation.restype = wintypes.BOOL
    _advapi32.GetLengthSid.argtypes = [ctypes.c_void_p]
    _advapi32.GetLengthSid.restype = wintypes.DWORD
    _advapi32.IsValidSid.argtypes = [ctypes.c_void_p]
    _advapi32.IsValidSid.restype = wintypes.BOOL
    _advapi32.CopySid.argtypes = [wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
    _advapi32.CopySid.restype = wintypes.BOOL
    _advapi32.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _advapi32.EqualSid.restype = wintypes.BOOL
    _advapi32.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                                ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
                                                ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
                                                ctypes.POINTER(ctypes.c_void_p)]
    _advapi32.GetNamedSecurityInfoW.restype = wintypes.DWORD
    _advapi32.GetSecurityDescriptorControl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.WORD),
                                                       ctypes.POINTER(wintypes.DWORD)]
    _advapi32.GetSecurityDescriptorControl.restype = wintypes.BOOL
    _advapi32.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
                                                    ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
    _advapi32.GetSecurityDescriptorDacl.restype = wintypes.BOOL
    _advapi32.GetAclInformation.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_int]
    _advapi32.GetAclInformation.restype = wintypes.BOOL
    _advapi32.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    _advapi32.GetAce.restype = wintypes.BOOL
    _advapi32.InitializeAcl.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD]
    _advapi32.InitializeAcl.restype = wintypes.BOOL
    _advapi32.AddAccessAllowedAceEx.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                                wintypes.DWORD, ctypes.c_void_p]
    _advapi32.AddAccessAllowedAceEx.restype = wintypes.BOOL
    _advapi32.InitializeSecurityDescriptor.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    _advapi32.InitializeSecurityDescriptor.restype = wintypes.BOOL
    _advapi32.SetSecurityDescriptorOwner.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL]
    _advapi32.SetSecurityDescriptorOwner.restype = wintypes.BOOL
    _advapi32.SetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, wintypes.BOOL, ctypes.c_void_p, wintypes.BOOL]
    _advapi32.SetSecurityDescriptorDacl.restype = wintypes.BOOL
    _advapi32.SetSecurityDescriptorControl.argtypes = [ctypes.c_void_p, wintypes.WORD, wintypes.WORD]
    _advapi32.SetSecurityDescriptorControl.restype = wintypes.BOOL
    _advapi32.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                                ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                                ctypes.c_void_p]
    _advapi32.SetNamedSecurityInfoW.restype = wintypes.DWORD

    def _win_error(message: str) -> PrivateFileError:
        # Never include path, SID, ACL contents, or exception details.
        return PrivateFileError(message)

    def _win32_check_no_reparse_components(path: Path) -> None:
        for component in _path_components(path):
            attrs = _kernel32.GetFileAttributesW(str(component))
            if attrs == _INVALID_FILE_ATTRIBUTES:
                raise _win_error("Windows path component is unavailable")
            if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
                raise _win_error("Windows reparse-point paths are not allowed")

    def _current_user_sid():
        token = wintypes.HANDLE()
        if not _advapi32.OpenProcessToken(_kernel32.GetCurrentProcess(), _TOKEN_QUERY, ctypes.byref(token)):
            raise _win_error("Windows current-user identity is unavailable")
        try:
            needed = wintypes.DWORD()
            _advapi32.GetTokenInformation(token, _TOKEN_USER_CLASS, None, 0, ctypes.byref(needed))
            if not needed.value:
                raise _win_error("Windows current-user identity is unavailable")
            buffer = ctypes.create_string_buffer(needed.value)
            if not _advapi32.GetTokenInformation(token, _TOKEN_USER_CLASS, buffer, needed, ctypes.byref(needed)):
                raise _win_error("Windows current-user identity is unavailable")
            token_user = ctypes.cast(buffer, ctypes.POINTER(_TOKEN_USER)).contents
            sid_length = _advapi32.GetLengthSid(token_user.User.Sid)
            sid_buffer = ctypes.create_string_buffer(sid_length)
            if not _advapi32.CopySid(sid_length, sid_buffer, token_user.User.Sid):
                raise _win_error("Windows current-user identity is unavailable")
            return sid_buffer
        finally:
            _kernel32.CloseHandle(token)

    def _win32_security_descriptor(path: Path):
        owner = ctypes.c_void_p()
        dacl = ctypes.c_void_p()
        descriptor = ctypes.c_void_p()
        result = _advapi32.GetNamedSecurityInfoW(
            str(path), _SE_FILE_OBJECT, _OWNER_SECURITY_INFORMATION | _DACL_SECURITY_INFORMATION,
            ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
        if result != 0 or not descriptor.value:
            raise _win_error("Windows security descriptor is unavailable")
        try:
            control = wintypes.WORD()
            revision = wintypes.DWORD()
            if not _advapi32.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)):
                raise _win_error("Windows security descriptor is malformed")
            present = wintypes.BOOL()
            defaulted = wintypes.BOOL()
            dacl_ptr = ctypes.c_void_p()
            if not _advapi32.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl_ptr), ctypes.byref(defaulted)):
                raise _win_error("Windows security descriptor is malformed")
            return descriptor, owner, dacl_ptr, bool(present.value), bool(control.value & _SE_DACL_PROTECTED)
        except Exception:
            _kernel32.LocalFree(descriptor)
            raise

    def _win32_assert_private(path: Path, *, directory: bool) -> None:
        descriptor, owner, dacl, present, protected = _win32_security_descriptor(path)
        try:
            current = _current_user_sid()
            owner_matches = bool(owner.value and _advapi32.EqualSid(owner, ctypes.cast(current, ctypes.c_void_p)))
            if not present or not dacl.value:
                _validate_acl_policy(owner_matches=owner_matches, dacl_protected=protected,
                                     dacl_present=present, dacl_is_null=not dacl.value,
                                     aces=[], current_sid="current")
            acl_info = _ACL_SIZE_INFORMATION()
            if not _advapi32.GetAclInformation(dacl, ctypes.byref(acl_info), ctypes.sizeof(acl_info), 2):
                raise _win_error("Windows DACL is malformed")
            aces = []
            for index in range(acl_info.AceCount):
                ace = ctypes.c_void_p()
                if not _advapi32.GetAce(dacl, index, ctypes.byref(ace)) or not ace.value:
                    raise _win_error("Windows DACL is malformed")
                ace_type = ctypes.cast(ace, ctypes.POINTER(wintypes.BYTE)).contents.value
                ace_flags = ctypes.cast(ctypes.c_void_p(ace.value + 1), ctypes.POINTER(wintypes.BYTE)).contents.value
                ace_size = ctypes.cast(ctypes.c_void_p(ace.value + 2), ctypes.POINTER(wintypes.WORD)).contents.value
                if ace_type != _ACCESS_ALLOWED_ACE_TYPE:
                    aces.append({"kind": "unsupported", "sid": None, "flags": ace_flags})
                    continue
                if ace_size < 16:
                    raise _win_error("Windows DACL is malformed")
                ace_mask = ctypes.cast(ctypes.c_void_p(ace.value + 4), ctypes.POINTER(wintypes.DWORD)).contents.value
                sid_ptr = ctypes.c_void_p(ace.value + 8)
                subauthority_count = ctypes.cast(ctypes.c_void_p(sid_ptr.value + 1), ctypes.POINTER(wintypes.BYTE)).contents.value
                expected_sid_length = 8 + 4 * subauthority_count
                if expected_sid_length > ace_size - 8:
                    raise _win_error("Windows DACL is malformed")
                if not _advapi32.IsValidSid(sid_ptr):
                    raise _win_error("Windows DACL is malformed")
                sid_length = _advapi32.GetLengthSid(sid_ptr)
                if sid_length != expected_sid_length:
                    raise _win_error("Windows DACL is malformed")
                sid_matches = bool(_advapi32.EqualSid(sid_ptr, ctypes.cast(current, ctypes.c_void_p)))
                aces.append({"kind": "allow", "sid": "current" if sid_matches else "other",
                             "flags": ace_flags, "mask": ace_mask})
            _validate_acl_policy(owner_matches=owner_matches, dacl_protected=protected,
                                 dacl_present=present, dacl_is_null=False,
                                 aces=aces, current_sid="current", directory=directory)
        finally:
            _kernel32.LocalFree(descriptor)

    def _win32_build_security(*, directory: bool = False):
        sid = _current_user_sid()
        sid_size = _advapi32.GetLengthSid(ctypes.cast(sid, ctypes.c_void_p))
        acl_size = 8 + 8 + sid_size
        acl = ctypes.create_string_buffer(acl_size)
        if not _advapi32.InitializeAcl(acl, acl_size, _ACL_REVISION):
            raise _win_error("Windows private ACL creation failed")
        ace_flags = (_OBJECT_INHERIT_ACE | _CONTAINER_INHERIT_ACE) if directory else 0
        if not _advapi32.AddAccessAllowedAceEx(acl, _ACL_REVISION, ace_flags, _GENERIC_ALL, ctypes.cast(sid, ctypes.c_void_p)):
            raise _win_error("Windows private ACL creation failed")
        sd = ctypes.create_string_buffer(128)
        if not _advapi32.InitializeSecurityDescriptor(sd, 1):
            raise _win_error("Windows private descriptor creation failed")
        if not _advapi32.SetSecurityDescriptorOwner(sd, ctypes.cast(sid, ctypes.c_void_p), False):
            raise _win_error("Windows private descriptor creation failed")
        if not _advapi32.SetSecurityDescriptorDacl(sd, True, acl, False):
            raise _win_error("Windows private descriptor creation failed")
        if not _advapi32.SetSecurityDescriptorControl(sd, _SE_DACL_PROTECTED, _SE_DACL_PROTECTED):
            raise _win_error("Windows private descriptor creation failed")
        attributes = _SECURITY_ATTRIBUTES(ctypes.sizeof(_SECURITY_ATTRIBUTES), ctypes.cast(sd, ctypes.c_void_p), False)
        return sid, acl, sd, attributes

    def _win32_create_directory(path: Path) -> None:
        _sid, _acl, _sd, attributes = _win32_build_security(directory=True)
        if not _kernel32.CreateDirectoryW(str(path), ctypes.byref(attributes)):
            error = ctypes.get_last_error()
            if error != 183:  # ERROR_ALREADY_EXISTS
                raise _win_error("Windows private directory creation failed")
        _win32_check_no_reparse_components(path)
        _win32_assert_private(path, directory=True)

    def _win32_create_file(path: Path, data: bytes) -> None:
        _sid, _acl, _sd, attributes = _win32_build_security()
        handle = _kernel32.CreateFileW(str(path), 0x40000000, 0, ctypes.byref(attributes), _CREATE_NEW,
                                       _FILE_ATTRIBUTE_NORMAL | _FILE_FLAG_OPEN_REPARSE_POINT, None)
        if handle == _INVALID_HANDLE_VALUE:
            raise _win_error("Windows private file creation failed")
        try:
            offset = 0
            while offset < len(data):
                written = wintypes.DWORD()
                amount = min(len(data) - offset, 1024 * 1024)
                chunk = data[offset:offset + amount]
                buffer = ctypes.create_string_buffer(chunk)
                if not _kernel32.WriteFile(handle, buffer, amount, ctypes.byref(written), None) or written.value != amount:
                    raise _win_error("Windows private file write failed")
                offset += written.value
            if not _kernel32.FlushFileBuffers(handle):
                raise _win_error("Windows private file flush failed")
        finally:
            _kernel32.CloseHandle(handle)
        _win32_check_no_reparse_components(path)
        _win32_assert_private(path, directory=False)

    def _win32_harden_sqlite_file(path: Path) -> None:
        descriptor, owner, dacl, present, protected = _win32_security_descriptor(path)
        try:
            current = _current_user_sid()
            owner_matches = bool(owner.value and _advapi32.EqualSid(owner, ctypes.cast(current, ctypes.c_void_p)))
            if not owner_matches or not present or not dacl.value:
                raise _win_error("SQLite artifact owner or DACL is not private")
            if protected:
                _win32_assert_private(path, directory=False)
                return
            acl_info = _ACL_SIZE_INFORMATION()
            if not _advapi32.GetAclInformation(dacl, ctypes.byref(acl_info), ctypes.sizeof(acl_info), 2):
                raise _win_error("SQLite artifact DACL is malformed")
            masks = []
            for index in range(acl_info.AceCount):
                ace = ctypes.c_void_p()
                if not _advapi32.GetAce(dacl, index, ctypes.byref(ace)) or not ace.value:
                    raise _win_error("SQLite artifact DACL is malformed")
                ace_type = ctypes.cast(ace, ctypes.POINTER(wintypes.BYTE)).contents.value
                ace_flags = ctypes.cast(ctypes.c_void_p(ace.value + 1), ctypes.POINTER(wintypes.BYTE)).contents.value
                ace_size = ctypes.cast(ctypes.c_void_p(ace.value + 2), ctypes.POINTER(wintypes.WORD)).contents.value
                if ace_type != _ACCESS_ALLOWED_ACE_TYPE or ace_size < 16 or ace_flags & ~_INHERITED_ACE:
                    raise _win_error("SQLite artifact DACL contains unsupported access")
                mask = ctypes.cast(ctypes.c_void_p(ace.value + 4), ctypes.POINTER(wintypes.DWORD)).contents.value
                sid_ptr = ctypes.c_void_p(ace.value + 8)
                subauthority_count = ctypes.cast(ctypes.c_void_p(sid_ptr.value + 1), ctypes.POINTER(wintypes.BYTE)).contents.value
                expected_sid_length = 8 + 4 * subauthority_count
                if expected_sid_length > ace_size - 8:
                    raise _win_error("SQLite artifact DACL is malformed")
                if not _advapi32.IsValidSid(sid_ptr):
                    raise _win_error("SQLite artifact DACL is malformed")
                sid_length = _advapi32.GetLengthSid(sid_ptr)
                if sid_length != expected_sid_length:
                    raise _win_error("SQLite artifact DACL is malformed")
                if not _advapi32.EqualSid(sid_ptr, ctypes.cast(current, ctypes.c_void_p)) or mask <= 0:
                    raise _win_error("SQLite artifact DACL grants another principal access")
                masks.append(mask)
            if not masks:
                raise _win_error("SQLite artifact DACL is empty")
            sid_size = _advapi32.GetLengthSid(ctypes.cast(current, ctypes.c_void_p))
            acl_size = 8 + sum(8 + sid_size for _ in masks)
            acl = ctypes.create_string_buffer(acl_size)
            if not _advapi32.InitializeAcl(acl, acl_size, _ACL_REVISION):
                raise _win_error("SQLite artifact DACL could not be secured")
            for mask in masks:
                if not _advapi32.AddAccessAllowedAceEx(acl, _ACL_REVISION, 0, mask, ctypes.cast(current, ctypes.c_void_p)):
                    raise _win_error("SQLite artifact DACL could not be secured")
            result = _advapi32.SetNamedSecurityInfoW(str(path), _SE_FILE_OBJECT,
                _DACL_SECURITY_INFORMATION | _PROTECTED_DACL_SECURITY_INFORMATION,
                None, None, ctypes.cast(acl, ctypes.c_void_p), None)
            if result != 0:
                raise _win_error("SQLite artifact DACL could not be secured")
        finally:
            _kernel32.LocalFree(descriptor)
        _win32_assert_private(path, directory=False)

else:
    def _win32_check_no_reparse_components(path: Path) -> None:  # pragma: no cover - Windows only
        raise PrivateFileError("Windows security APIs are unavailable")

    def _win32_create_directory(path: Path) -> None:  # pragma: no cover - Windows only
        raise PrivateFileError("Windows security APIs are unavailable")

    def _win32_create_file(path: Path, data: bytes) -> None:  # pragma: no cover - Windows only
        raise PrivateFileError("Windows security APIs are unavailable")

    def _win32_assert_private(path: Path, *, directory: bool) -> None:  # pragma: no cover - Windows only
        raise PrivateFileError("Windows security APIs are unavailable")
