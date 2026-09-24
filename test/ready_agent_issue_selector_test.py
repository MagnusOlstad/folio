"""Focused unit tests for scripts/select_ready_agent_issue.py.

All gh invocations are mocked; this file never contacts GitHub.
"""

from __future__ import annotations

import importlib.util
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from subprocess import CompletedProcess
import unittest
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).parent.parent / "scripts" / "select_ready_agent_issue.py"
SPEC = importlib.util.spec_from_file_location("ready_agent_issue_selector", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
SELECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SELECTOR)


def issue(number: int, created_at: str, *, labels: list[object] | None = None, pull_request: bool = False, author: str = "someone") -> dict[str, object]:
    result: dict[str, object] = {
        "number": number,
        "title": f"Issue {number}",
        "html_url": f"https://github.com/MagnusOlstad/folio/issues/{number}",
        "body": f"Body {number}",
        "created_at": created_at,
        "labels": labels if labels is not None else [{"name": "ready for agent"}],
        "user": {"login": author},
    }
    if pull_request:
        result["pull_request"] = {"url": "https://api.github.com/pr"}
    return result


def event(created_at: str, login: str, *, event_id: int = 1, kind: str = "labeled") -> dict[str, object]:
    return {
        "id": event_id,
        "event": kind,
        "created_at": created_at,
        "label": {"name": "ready for agent"},
        "actor": {"login": login},
    }


class FakeGh:
    def __init__(self, pages: dict[int, object], issues: object, *, failure: tuple[str, int, str] | None = None):
        self.pages = pages
        self.issues = issues
        self.failure = failure
        self.commands: list[list[str]] = []

    def __call__(self, command: list[str], **_: object) -> CompletedProcess[str]:
        self.commands.append(command)
        joined = " ".join(command)
        if self.failure is not None and self.failure[0] in joined:
            return CompletedProcess(command, self.failure[1], "", self.failure[2])
        if command[1:4] == ["repo", "view", "--json"]:
            return CompletedProcess(command, 0, json.dumps({"nameWithOwner": "MagnusOlstad/folio"}), "")
        if "/issues?" in joined:
            return CompletedProcess(command, 0, json.dumps(self.issues), "")
        number = int(next(part for part in command[-1].split("/") if part.isdigit()))
        return CompletedProcess(command, 0, json.dumps(self.pages[number]), "")


class ReadyAgentIssueSelectorTests(unittest.TestCase):
    def select(self, fake: FakeGh) -> dict[str, object] | None:
        with patch.object(SELECTOR.subprocess, "run", fake):
            return SELECTOR.select_issue()

    def test_no_match_produces_no_selection(self) -> None:
        fake = FakeGh({}, [[issue(1, "2025-01-01T00:00:00Z", labels=[])]])
        self.assertIsNone(self.select(fake))
        self.assertEqual(len(fake.commands), 2)

    def test_no_match_writes_no_stdout(self) -> None:
        fake = FakeGh({}, [[issue(1, "2025-01-01T00:00:00Z", labels=[])]])
        stdout = io.StringIO()
        with patch.object(SELECTOR.subprocess, "run", fake), redirect_stdout(stdout):
            self.assertEqual(SELECTOR.main(), 0)
        self.assertEqual(stdout.getvalue(), "")

    def test_issue_author_does_not_affect_eligibility(self) -> None:
        fake = FakeGh({4: [[event("2025-01-02T00:00:00Z", "mAgNuSoLsTaD")]]}, [[issue(4, "2025-01-01T00:00:00Z", author="another-user")]])
        self.assertEqual(self.select(fake)["number"], 4)

    def test_wrong_label_actor_is_not_eligible(self) -> None:
        fake = FakeGh({5: [[event("2025-01-02T00:00:00Z", "other-user")]]}, [[issue(5, "2025-01-01T00:00:00Z")]])
        self.assertIsNone(self.select(fake))

    def test_selects_oldest_eligible_issue_then_number(self) -> None:
        fake = FakeGh({
            9: [[event("2025-02-01T00:00:00Z", "MagnusOlstad")]],
            2: [[event("2025-02-01T00:00:00Z", "MagnusOlstad")]],
            3: [[event("2025-02-01T00:00:00Z", "MagnusOlstad")]],
        }, [[
            issue(9, "2025-01-03T00:00:00Z"),
            issue(3, "2025-01-01T00:00:00Z"),
            issue(2, "2025-01-01T00:00:00Z"),
        ]])
        self.assertEqual(self.select(fake)["number"], 2)

    def test_pull_requests_are_excluded(self) -> None:
        fake = FakeGh({7: [[event("2025-01-02T00:00:00Z", "MagnusOlstad")]]}, [[issue(7, "2025-01-01T00:00:00Z", pull_request=True)]])
        self.assertIsNone(self.select(fake))
        self.assertEqual(len(fake.commands), 2)

    def test_remove_and_readd_uses_the_latest_label_actor_across_pages(self) -> None:
        fake = FakeGh({8: [
            [event("2025-01-01T00:00:00Z", "someone-else", event_id=1)],
            [
                event("2025-01-02T00:00:00Z", "someone-else", event_id=2, kind="unlabeled"),
                event("2025-01-03T00:00:00Z", "MagnusOlstad", event_id=3),
            ],
        ]}, [[issue(8, "2025-01-01T00:00:00Z")]])
        self.assertEqual(self.select(fake)["number"], 8)
        event_command = fake.commands[-1]
        self.assertEqual(event_command[1:6], ["api", "--method", "GET", "--paginate", "--slurp"])

    def test_latest_reapplied_labeler_must_match(self) -> None:
        fake = FakeGh({6: [
            [event("2025-01-01T00:00:00Z", "MagnusOlstad", event_id=1)],
            [
                event("2025-01-02T00:00:00Z", "MagnusOlstad", event_id=2, kind="unlabeled"),
                event("2025-01-03T00:00:00Z", "someone-else", event_id=3),
            ],
        ]}, [[issue(6, "2025-01-01T00:00:00Z")]])
        self.assertIsNone(self.select(fake))

    def test_api_failure_is_nonzero_and_written_to_stderr(self) -> None:
        fake = FakeGh({}, [], failure=("/issues?", 1, "not authenticated"))
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.object(SELECTOR.subprocess, "run", fake), redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(SELECTOR.main(), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("not authenticated", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
