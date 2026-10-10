# Private producer files on Windows

`scripts/private-files.py` is a standard-library adapter for secure local
producer storage. The result bridge, sender and completion capture load it with
`importlib.util.spec_from_file_location`. It does not activate or install the
T3 worker.

## Security policy

On POSIX, private files are regular files with mode `0600`, private directories
have mode `0700`, and every path component is checked with `lstat` to reject
symlinks. Directory creation may tighten an existing POSIX directory to `0700`,
matching the bridge's established behavior.

On Windows, mode bits and `chmod(0600)` are not treated as privacy controls.
The helper obtains the current process token SID and checks the Windows owner
and DACL for each requested private file or directory. The owner must be the
current user; the DACL must be present, non-null and protected from inheritance.
Files accept only explicit current-user allow ACEs with no inheritance flags.
Directories also accept explicit current-user ACEs with object/container
inheritance flags, so descendants inherit only the current user's access. The
inherited ACE flag itself is never accepted by normal file or directory
validation. Deny, unsupported, broad-principal and malformed ACEs fail closed.
The helper does not add SYSTEM or administrator access. A path owned by a
distinct administrator account is rejected. Existing configuration, token and
user-managed file ACLs are never repaired or weakened. The helper does not
change accounts, elevate privileges or print paths, SIDs, ACL contents or file
content in errors.

Windows path traversal checks use `GetFileAttributesW` on every absolute path
prefix and reject the reparse-point attribute, including symlinks and junctions.
New directories receive a protected current-user DACL whose explicit ACE has
object and container inheritance flags. New files receive a protected
current-user DACL with no inheritance flags. Atomic replacement is permitted
only after checking the destination's private parent directory and any
existing destination. The temporary and destination remain in that directory.

## SQLite artifacts

The bridge and capture adapter establish their private directory before SQLite
opens. A new main database is precreated with a protected file ACL. SQLite may
create WAL, SHM and rollback-journal files itself. The helper checks each
artifact's owner and every existing ACE, refuses any foreign principal or
unsupported ACE, then converts inherited current-user allow ACEs to explicit
protected ACEs with the same access masks. The directory's protected
current-user-only DACL bounds access while SQLite creates a sidecar. Existing
foreign-owner/config/token files are never repaired. POSIX SQLite artifacts
retain mode `0600`.

The capture adapter's configured T3 metadata database remains read-only and is
only checked for a regular non-reparse path. Capture does not change its ACL,
mode or contents.

## Durability and tests

The helper flushes bytes of a newly created file with `FlushFileBuffers` on
Windows and `fsync` on POSIX. `scripts/t3-results.py` performs directory fsync
only on POSIX. Windows does not provide the POSIX pattern of opening a
directory with `os.open(..., O_DIRECTORY)` and calling `fsync` on that
descriptor. Same-directory `os.replace` is used for atomic name replacement,
but no portable directory metadata durability barrier after power loss is
claimed on Windows.

The tests are in `tests/producer/test_private_files.py`. Policy and POSIX tests
run on any platform. Native Windows tests explicitly skip elsewhere and must
be run on Windows under the personal producer account. They verify protected
creation, rejection of an ordinary inherited directory, SQLite WAL sidecar ACL
hardening and junction rejection (the junction case skips if that Windows
context cannot create one). The Windows run is still required to verify the
native owner/DACL calls. Linux results do not establish Windows host
installation, protected-token installation, service activation or runtime
delivery.
