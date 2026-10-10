import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "private_files", Path(__file__).parents[2] / "scripts" / "private-files.py")
private_files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(private_files)


class AclPolicyTests(unittest.TestCase):
    def validate(self, **overrides):
        values = {
            "owner_matches": True,
            "dacl_protected": True,
            "dacl_present": True,
            "dacl_is_null": False,
            "aces": [{"kind": "allow", "sid": "user", "flags": 0, "mask": 1}],
            "current_sid": "user",
        }
        values.update(overrides)
        private_files._validate_acl_policy(**values)

    def test_accepts_only_protected_current_user_acl(self):
        self.validate()

    def test_explicit_directory_inheritance_flags_are_allowed_only_for_directories(self):
        aces = [{"kind": "allow", "sid": "user", "flags": 0x03, "mask": 1}]
        self.validate(aces=aces, directory=True)
        with self.assertRaises(private_files.PrivateFileError):
            self.validate(aces=aces)

    def test_rejects_non_owner_including_different_admin_account(self):
        with self.assertRaises(private_files.PrivateFileError):
            self.validate(owner_matches=False)

    def test_rejects_inherited_unprotected_null_or_missing_dacl(self):
        for key, value in (("dacl_protected", False), ("dacl_present", False), ("dacl_is_null", True)):
            with self.subTest(key=key), self.assertRaises(private_files.PrivateFileError):
                self.validate(**{key: value})

    def test_rejects_broad_inherited_deny_and_unknown_aces(self):
        bad_aces = [
            [{"kind": "allow", "sid": "everyone", "flags": 0}],
            [{"kind": "allow", "sid": "user", "flags": 16}],
            [{"kind": "allow", "sid": "user", "flags": 0, "mask": 0}],
            [{"kind": "deny", "sid": "user", "flags": 0}],
            [{"kind": "object", "sid": "user", "flags": 0}],
            [],
        ]
        for aces in bad_aces:
            with self.subTest(aces=aces), self.assertRaises(private_files.PrivateFileError):
                self.validate(aces=aces)


class PosixPrivateFilesTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX mode-bit behavior is not a Windows security test")
    def test_directory_file_creation_and_atomic_replace_are_private(self):
        with tempfile.TemporaryDirectory() as temp:
            private_dir = private_files.ensure_private_directory(Path(temp) / "nested" / "private")
            self.assertEqual(stat.S_IMODE(private_dir.stat().st_mode), 0o700)
            target = private_files.create_private_file(private_dir / "secret", b"first")
            self.assertEqual(target.read_bytes(), b"first")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(private_files.atomic_write_private(target, b"second"), target)
            self.assertEqual(target.read_bytes(), b"second")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    @unittest.skipIf(os.name == "nt", "POSIX SQLite mode-bit behavior is not a Windows ACL test")
    def test_sqlite_artifacts_are_private(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as temp:
            private_dir = private_files.ensure_private_directory(Path(temp) / "sqlite")
            database = private_dir / "state.sqlite3"
            private_files.ensure_private_sqlite_database(database)
            db = sqlite3.connect(database)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE records (value TEXT)")
            db.execute("INSERT INTO records VALUES ('private')")
            private_files.secure_sqlite_artifacts(database)
            db.commit()
            private_files.secure_sqlite_artifacts(database)
            db.close()
            private_files.secure_sqlite_artifacts(database)
            for artifact in (database, Path(str(database) + "-wal"), Path(str(database) + "-shm"),
                             Path(str(database) + "-journal")):
                if artifact.exists():
                    self.assertEqual(stat.S_IMODE(artifact.stat().st_mode), 0o600)

    @unittest.skipIf(os.name == "nt", "Windows reparse-point checks use native attributes")
    def test_symlink_components_and_wrong_modes_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            secure = root / "secure"
            secure.mkdir(mode=0o700)
            private_files.assert_private_directory(secure)
            secure.chmod(0o755)
            with self.assertRaises(private_files.PrivateFileError):
                private_files.assert_private_directory(secure)
            secure.chmod(0o700)
            secret = secure / "secret"
            secret.write_bytes(b"secret")
            secret.chmod(0o600)
            private_files.assert_private_file(secret)
            secret.chmod(0o644)
            with self.assertRaises(private_files.PrivateFileError):
                private_files.assert_private_file(secret)
            with self.assertRaises(FileExistsError):
                private_files.create_private_file(secret, b"must not replace")
            secret.chmod(0o600)
            link = root / "linked"
            link.symlink_to(secure, target_is_directory=True)
            with self.assertRaises(private_files.PrivateFileError):
                private_files.assert_private_file(link / "secret")


@unittest.skipUnless(os.name == "nt", "native Windows ACL integration; run as the personal producer user")
class WindowsPrivateFilesIntegrationTests(unittest.TestCase):
    def test_protected_creation_and_foreign_or_inherited_dacl_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            created = private_files.ensure_private_directory(root / "private-outbox")
            self.assertEqual(private_files.assert_private_directory(created), created)
            secret = private_files.create_private_file(created / "token.dat", b"test-only")
            self.assertEqual(private_files.assert_private_file(secret), secret)
            self.assertEqual(secret.read_bytes(), b"test-only")

            import sqlite3
            database = created / "private.sqlite3"
            private_files.ensure_private_sqlite_database(database)
            db = sqlite3.connect(database)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE records (value TEXT)")
            db.execute("INSERT INTO records VALUES ('private')")
            private_files.secure_sqlite_artifacts(database)
            db.commit()
            private_files.secure_sqlite_artifacts(database)
            db.close()
            private_files.secure_sqlite_artifacts(database)
            for artifact in (database, Path(str(database) + "-wal"), Path(str(database) + "-shm"),
                             Path(str(database) + "-journal")):
                if artifact.exists():
                    private_files.assert_private_file(artifact)

            # A normal inherited temp child is intentionally not tightened;
            # the helper must reject it rather than chmod or repair its ACL.
            inherited = root / "inherited"
            inherited.mkdir()
            with self.assertRaises(private_files.PrivateFileError):
                private_files.assert_private_directory(inherited)

    def test_reparse_point_path_is_rejected(self):
        import subprocess

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = private_files.ensure_private_directory(root / "private-target")
            link = root / "private-junction"
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                                   capture_output=True, text=True, check=False)
            if result.returncode != 0:
                self.skipTest("junction creation is unavailable in this Windows context")
            with self.assertRaises(private_files.PrivateFileError):
                private_files.assert_private_directory(link)


if __name__ == "__main__":
    unittest.main()
