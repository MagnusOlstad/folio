"""Offline regression tests for the ready-issue selector."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import select_ready_agent_issue as selector


def make_issue(number: int, created_at: str) -> dict[str, object]:
    return {
        "number": number,
        "title": f"Issue {number}",
        "html_url": f"https://example.test/issues/{number}",
        "created_at": created_at,
        "body": None,
        "labels": [{"name": selector.READY_LABEL}],
    }


class SelectReadyAgentIssueTests(unittest.TestCase):
    def select_single_issue_for_actor(self, login: str) -> dict[str, object] | None:
        issue = make_issue(1, "2026-01-01T00:00:00Z")
        events = [
            {
                "id": 1,
                "event": "labeled",
                "created_at": "2026-01-01T01:00:00Z",
                "label": {"name": selector.READY_LABEL},
                "actor": {"login": login},
            }
        ]

        def fake_run_gh(arguments: list[str]) -> object:
            if arguments[:2] == ["repo", "view"]:
                return {"nameWithOwner": "owner/repo"}
            if "/issues?state=open" in arguments[-1]:
                return [[issue]]
            if "/issues/1/events?" in arguments[-1]:
                return [events]
            self.fail(f"unexpected gh arguments: {arguments}")

        with patch.object(selector, "run_gh", side_effect=fake_run_gh):
            return selector.select_issue()

    def test_each_authorized_labeler_is_accepted_case_insensitively(self) -> None:
        for login in ("MaGnUsOlStAd", "MaGwEsT1"):
            with self.subTest(login=login):
                selected = self.select_single_issue_for_actor(login)
                self.assertIsNotNone(selected)
                assert selected is not None
                self.assertEqual(selected["number"], 1)

    def test_unauthorized_only_labeler_is_rejected(self) -> None:
        self.assertIsNone(self.select_single_issue_for_actor("someone-else"))

    def test_only_latest_ready_label_event_actor_can_authorize_oldest_issue(self) -> None:
        issues = [
            make_issue(1, "2026-01-01T00:00:00Z"),
            make_issue(2, "2026-01-02T00:00:00Z"),
            make_issue(3, "2026-01-03T00:00:00Z"),
        ]
        events_by_issue = {
            1: [
                {
                    "id": 1,
                    "event": "labeled",
                    "created_at": "2026-01-01T01:00:00Z",
                    "label": {"name": selector.READY_LABEL},
                    "actor": {"login": "MagnusOlstad"},
                },
                {
                    "id": 2,
                    "event": "labeled",
                    "created_at": "2026-01-01T02:00:00Z",
                    "label": {"name": selector.READY_LABEL},
                    "actor": {"login": "someone-else"},
                },
            ],
            2: [
                {
                    "id": 3,
                    "event": "labeled",
                    "created_at": "2026-01-02T01:00:00Z",
                    "label": {"name": selector.READY_LABEL},
                    "actor": {"login": "MaGnUsOlStAd"},
                }
            ],
            3: [
                {
                    "id": 4,
                    "event": "labeled",
                    "created_at": "2026-01-03T01:00:00Z",
                    "label": {"name": selector.READY_LABEL},
                    "actor": {"login": "MAGWEST1"},
                }
            ],
        }

        def fake_run_gh(arguments: list[str]) -> object:
            if arguments[:2] == ["repo", "view"]:
                return {"nameWithOwner": "owner/repo"}
            if "/issues?state=open" in arguments[-1]:
                return [issues]
            for number, events in events_by_issue.items():
                if f"/issues/{number}/events?" in arguments[-1]:
                    return [events]
            self.fail(f"unexpected gh arguments: {arguments}")

        with patch.object(selector, "run_gh", side_effect=fake_run_gh):
            selected = selector.select_issue()

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected["number"], 2)


if __name__ == "__main__":
    unittest.main()
