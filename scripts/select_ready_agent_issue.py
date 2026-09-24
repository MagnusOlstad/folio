#!/usr/bin/env python3
"""Select the oldest open GitHub issue ready for an agent.

The script relies on the authenticated ``gh`` CLI for repository and API access.
It deliberately writes nothing when no eligible issue exists, so callers can
distinguish an empty queue from an API failure by checking the exit status.
"""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any, Sequence


READY_LABEL = "ready for agent"
READY_LABELER = "magnusolstad"


class SelectorError(RuntimeError):
    """An operational or malformed-response error from GitHub."""


def run_gh(arguments: Sequence[str]) -> Any:
    """Run gh and decode its JSON response, turning all failures into errors."""
    command = ["gh", *arguments]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        raise SelectorError(f"unable to run gh: {error}") from error

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no error details"
        raise SelectorError(f"gh command failed ({result.returncode}): {detail}")

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SelectorError(f"gh returned invalid JSON: {error.msg}") from error


def paginated_items(response: Any, resource: str) -> list[dict[str, Any]]:
    """Flatten the array-of-pages emitted by `gh api --paginate --slurp`."""
    if not isinstance(response, list) or any(not isinstance(page, list) for page in response):
        raise SelectorError(f"unexpected paginated {resource} response from GitHub")

    items = [item for page in response for item in page]
    if any(not isinstance(item, dict) for item in items):
        raise SelectorError(f"unexpected {resource} item from GitHub")
    return items


def has_ready_label(issue: dict[str, Any]) -> bool:
    labels = issue.get("labels")
    if not isinstance(labels, list):
        raise SelectorError("unexpected issue labels response from GitHub")
    return any(
        (isinstance(label, dict) and label.get("name") == READY_LABEL)
        or label == READY_LABEL
        for label in labels
    )


def label_event_key(event: dict[str, Any]) -> tuple[str, int]:
    created_at = event.get("created_at")
    if not isinstance(created_at, str):
        raise SelectorError("matching label event has no created_at timestamp")

    event_id = event.get("id", 0)
    try:
        numeric_id = int(event_id)
    except (TypeError, ValueError):
        numeric_id = 0
    return created_at, numeric_id


def latest_ready_label_event(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    matching_events = [
        event
        for event in events
        if event.get("event") == "labeled"
        and isinstance(event.get("label"), dict)
        and event["label"].get("name") == READY_LABEL
    ]
    if not matching_events:
        return None
    return max(matching_events, key=label_event_key)


def issue_context(issue: dict[str, Any]) -> dict[str, Any]:
    number = issue.get("number")
    title = issue.get("title")
    url = issue.get("html_url")
    created_at = issue.get("created_at")
    if not isinstance(number, int) or not isinstance(title, str) or not isinstance(url, str) or not isinstance(created_at, str):
        raise SelectorError("eligible issue is missing required identity fields")
    return {
        "number": number,
        "title": title,
        "url": url,
        "body": issue.get("body"),
        "createdAt": created_at,
    }


def select_issue() -> dict[str, Any] | None:
    repository = run_gh(["repo", "view", "--json", "nameWithOwner"])
    name_with_owner = repository.get("nameWithOwner") if isinstance(repository, dict) else None
    if not isinstance(name_with_owner, str) or "/" not in name_with_owner:
        raise SelectorError("gh did not return a repository nameWithOwner")

    issues_response = run_gh([
        "api", "--method", "GET", "--paginate", "--slurp",
        f"/repos/{name_with_owner}/issues?state=open&per_page=100",
    ])
    issues = paginated_items(issues_response, "issues")
    candidates: list[dict[str, Any]] = []

    for issue in issues:
        # The REST issues endpoint includes pull requests, which are never tickets.
        if "pull_request" in issue or not has_ready_label(issue):
            continue

        number = issue.get("number")
        if not isinstance(number, int):
            raise SelectorError("ready issue has no numeric issue number")
        events_response = run_gh([
            "api", "--method", "GET", "--paginate", "--slurp",
            f"/repos/{name_with_owner}/issues/{number}/events?per_page=100",
        ])
        event = latest_ready_label_event(paginated_items(events_response, f"events for issue {number}"))
        actor = event.get("actor") if event is not None else None
        login = actor.get("login") if isinstance(actor, dict) else None
        if isinstance(login, str) and login.casefold() == READY_LABELER:
            candidates.append(issue_context(issue))

    if not candidates:
        return None
    return min(candidates, key=lambda issue: (issue["createdAt"], issue["number"]))


def main() -> int:
    try:
        selected = select_issue()
    except SelectorError as error:
        print(f"select_ready_agent_issue: {error}", file=sys.stderr)
        return 1

    if selected is not None:
        print(json.dumps(selected, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
