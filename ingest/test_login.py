import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ingest


class NonTty(io.StringIO):
    def isatty(self):
        return False


class Tty(io.StringIO):
    def isatty(self):
        return True


class StubClient:
    def __init__(self, calls, *args, **kwargs):
        self.calls = calls
        self.calls.append(("create", args, kwargs))

    def login(self, tokenstore):
        self.calls.append(("login", tokenstore))


class StubCursor:
    def fetchone(self):
        return (True,)


class StubConnection:
    def __init__(self):
        self.calls = []
        self.closed = False

    def execute(self, query, values):
        self.calls.append((query, values))
        return StubCursor()

    def commit(self):
        self.calls.append(("commit",))

    def rollback(self):
        self.calls.append(("rollback",))

    def close(self):
        self.closed = True


class LoginTest(unittest.TestCase):
    def test_non_tty_without_cache_fails_before_client_login(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            tokenstore = Path(temp) / ".garth"
            with self.assertRaisesRegex(ingest.GarminReauthRequired, "re-authorise"):
                ingest.login(
                    client_factory=lambda *a, **k: StubClient(calls, *a, **k),
                    tokenstore=tokenstore,
                    stdin=NonTty(),
                )
        self.assertEqual(calls, [])

    def test_cached_session_resumes_without_credentials(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            tokenstore = Path(temp) / ".garth"
            tokenstore.mkdir()
            client = ingest.login(
                client_factory=lambda *a, **k: StubClient(calls, *a, **k),
                tokenstore=tokenstore,
                stdin=NonTty(),
            )
        self.assertIsInstance(client, StubClient)
        self.assertEqual(calls[0][1], ())
        self.assertEqual(calls[1], ("login", str(tokenstore)))

    def test_interactive_full_login_passes_tokenstore_to_library(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"GARMIN_EMAIL": "runner@example.com", "GARMIN_PASSWORD": "secret"}):
            tokenstore = Path(temp) / ".garth"
            ingest.login(
                client_factory=lambda *a, **k: StubClient(calls, *a, **k),
                tokenstore=tokenstore,
                stdin=Tty(),
            )
        self.assertEqual(calls[0][1], ("runner@example.com", "secret"))
        self.assertEqual(calls[1], ("login", str(tokenstore)))

    def test_main_records_failed_state_when_login_fails(self):
        connection = StubConnection()
        with patch.object(ingest, "load_dotenv"), \
                patch.object(ingest.psycopg, "connect", return_value=connection), \
                patch.object(ingest, "login", side_effect=ingest.GarminReauthRequired("expired")):
            with self.assertRaises(SystemExit) as stopped:
                ingest.main()
        self.assertEqual(stopped.exception.code, 1)
        insert = next(call for call in connection.calls if "INSERT INTO ingest_state" in call[0])
        self.assertFalse(insert[1][2])
        self.assertEqual(insert[1][3], "1 error(s): Garmin login expired: re-authorise")
        self.assertTrue(connection.closed)


if __name__ == "__main__":
    unittest.main()
