#!/usr/bin/env python3
"""Run the same compact Folio fixture set through one warm native helper."""

from __future__ import annotations

import argparse
import json
import pathlib
import queue
import re
import subprocess
import sys
import threading
import time
from typing import Any


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not rows:
        raise ValueError(f"fixture file is empty: {path}")
    ids = [row["id"] for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("fixture IDs must be unique")
    return rows


def quality_smoke(fixture: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    validation = fixture.get("validation", {})
    text = response.get("text", "")
    result: dict[str, Any] = {"kind": validation.get("kind")}
    if validation.get("kind") == "classification":
        raw = text.strip()
        match = re.search(r"```json\s*(.*?)\s*```", raw, re.IGNORECASE | re.DOTALL)
        fenced = match is not None
        candidate = match.group(1).strip() if match else raw
        prose_outside_json = bool(match and (raw[:match.start()].strip() or raw[match.end():].strip()))
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError as exc:
            result["jsonValid"] = False
            result["jsonBodyValid"] = False
            result["jsonError"] = str(exc)
            return result
        result["markdownJsonFence"] = fenced
        result["proseOutsideJson"] = prose_outside_json
        result["jsonValid"] = not fenced and candidate == raw
        result["jsonBodyValid"] = True
        concept = parsed.get("concept") if isinstance(parsed, dict) else None
        required = {"kind", "path", "title", "type", "description", "tags"}
        valid = (
            isinstance(parsed, dict)
            and set(parsed) == {"concept"}
            and isinstance(concept, dict)
            and set(concept) == required
            and isinstance(concept.get("kind"), str)
            and concept.get("kind") in {"note", "todo", "daily"}
            and isinstance(concept.get("path"), list)
            and 1 <= len(concept.get("path", [])) <= 5
            and all(isinstance(item, str) for item in concept.get("path", []))
            and isinstance(concept.get("title"), str)
            and isinstance(concept.get("type"), str)
            and isinstance(concept.get("description"), str)
            and isinstance(concept.get("tags"), list)
            and all(isinstance(item, str) for item in concept.get("tags", []))
            and len(concept.get("tags", [])) <= 6
        )
        result["schemaValid"] = bool(valid)
        if not isinstance(concept, dict):
            return result
        kind = concept.get("kind")
        path = concept.get("path")
        result["kindMatch"] = isinstance(kind, str) and kind == validation.get("expectedKind")
        result["pathMatch"] = isinstance(path, list) and path == validation.get("expectedPath")
        if not all(
            isinstance(concept.get(field), str)
            for field in ("title", "type", "description")
        ) or not isinstance(concept.get("tags"), list) or not all(
            isinstance(tag, str) for tag in concept.get("tags", [])
        ):
            return result
        filing = "\n".join(
            [concept["title"], concept["type"], concept["description"], *concept["tags"]]
        ).casefold()
        result["requiredTextPresent"] = {
            term: term.casefold() in filing
            for term in validation.get("mustPreserve", [])
        }
        result["mustIgnoreTextPresent"] = {
            term: term.casefold() in filing
            for term in validation.get("mustIgnore", [])
        }
        result["mustNotAssertTextPresent"] = {
            term: term.casefold() in filing
            for term in validation.get("mustNotAssert", [])
        }
        result["forbiddenTextPresent"] = {
            term: term.casefold() in filing
            for term in validation.get("mustNotAssert", [])
        }
        result["language"] = validation.get("language")
        return result
    if validation.get("kind") == "grounded-qa":
        citation = validation.get("citation", "")
        result["citationPresent"] = citation in text
        result["citationInline"] = any(
            citation in line
            and "citation:" not in line.casefold()
            and line.replace(citation, "").strip(" `*\t")
            for line in text.splitlines()
        )
        result["requiredTextPresent"] = {
            term: term.casefold() in text.casefold()
            for term in validation.get("mustPreserve", [])
        }
        return result
    result["unscored"] = True
    return result


def write_results(path: pathlib.Path, records: list[dict[str, Any]]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for record in records:
            stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", required=True, type=pathlib.Path)
    parser.add_argument("--model", required=True, help="HF repository ID, used for reporting and EOS selection")
    parser.add_argument("--model-directory", required=True, type=pathlib.Path, help="Already downloaded local HF snapshot; no hub requests are made")
    parser.add_argument("--cache", type=pathlib.Path, help="Optional HF cache directory for helper environment")
    parser.add_argument("--fixtures", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / "Fixtures/folio-prompts.jsonl")
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument("--repeats", type=int, default=1, help="number of measured passes after the warm-up")
    parser.add_argument("--system-suffix", default="", help="append one controlled instruction to the existing system prompt")
    parser.add_argument("--classification-only", action="store_true", help="run only classification fixtures (useful for controlled filing prompt variants)")
    args = parser.parse_args()

    if args.repeats < 1:
        parser.error("--repeats must be positive")
    fixtures = read_jsonl(args.fixtures)
    if args.classification_only:
        fixtures = [row for row in fixtures if row.get("validation", {}).get("kind") == "classification"]
        if not fixtures:
            parser.error("--classification-only selected no fixtures")
    if not args.helper.is_file() or not args.model_directory.is_dir():
        parser.error("helper and local model directory must already exist")
    args.helper = args.helper.resolve()
    args.model_directory = args.model_directory.resolve()
    if args.cache:
        args.cache = args.cache.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(args.helper), "--model", args.model,
        "--model-directory", str(args.model_directory),
        "--max-tokens", str(args.max_tokens),
        "--temperature", str(args.temperature),
    ]
    import os

    env = os.environ.copy()
    for key in list(env):
        if key.startswith("DYLD_"):
            del env[key]
    if args.cache:
        env["HF_HUB_CACHE"] = str(args.cache)
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        bufsize=1,
        cwd="/private/tmp",
        env=env,
    )
    records: list[dict[str, Any]] = []
    stdout_lines: queue.Queue = queue.Queue()

    def read_stdout() -> None:
        assert process.stdout is not None
        for output_line in process.stdout:
            stdout_lines.put(output_line)
        stdout_lines.put(None)

    def next_stdout_line(label: str) -> str:
        try:
            output_line = stdout_lines.get(timeout=300)
        except queue.Empty as exc:
            raise RuntimeError(f"timed out waiting for {label} response") from exc
        if output_line is None:
            raise RuntimeError(f"helper exited before {label} response")
        return output_line

    reader = threading.Thread(target=read_stdout, name="folio-mlx-stdout", daemon=True)
    reader.start()
    try:
        assert process.stdin is not None and process.stdout is not None
        # One untimed warm-up exercises generation before the recorded fixture set.
        first = dict(fixtures[0])
        if args.system_suffix:
            first["messages"] = [dict(message) for message in first["messages"]]
            first["messages"][0]["content"] += "\n" + args.system_suffix
        process.stdin.write(json.dumps(first, ensure_ascii=False) + "\n")
        process.stdin.flush()
        warmup = next_stdout_line("warm-up")
        warmup_response = json.loads(warmup)
        if warmup_response.get("id") != first["id"] or "error" in warmup_response:
            raise RuntimeError(f"invalid warm-up response: {warmup_response}")

        for repeat in range(1, args.repeats + 1):
            for fixture in fixtures:
                request = dict(fixture)
                if args.system_suffix:
                    request["messages"] = [dict(message) for message in fixture["messages"]]
                    request["messages"][0]["content"] += "\n" + args.system_suffix
                request["maxTokens"] = args.max_tokens
                request["temperature"] = args.temperature
                request["noThinking"] = True
                sent_at = time.monotonic()
                process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
                process.stdin.flush()
                line = next_stdout_line(fixture["id"])
                response = json.loads(line)
                if response.get("id") != fixture["id"]:
                    raise RuntimeError(f"response ID mismatch for {fixture['id']}: {response.get('id')}")
                if "error" in response:
                    raise RuntimeError(f"helper error for {fixture['id']}: {response['error']}")
                records.append({
                    "fixtureId": fixture["id"],
                    "repeat": repeat,
                    "model": args.model,
                    "modelSnapshotRevision": args.model_directory.name,
                    "cachePolicy": "clear-after-every-request",
                    "promptVariant": "system-suffix" if args.system_suffix else "baseline",
                    "systemSuffix": args.system_suffix,
                    "elapsedWallSeconds": time.monotonic() - sent_at,
                    "metrics": response.get("metrics", {}),
                    "smokeChecks": quality_smoke(fixture, response),
                    "rawText": response.get("text", ""),
                })
                write_results(args.output, records)
        process.stdin.close()
        exit_code = process.wait(timeout=15)
        if exit_code != 0:
            raise RuntimeError(f"helper exited with status {exit_code}")
    finally:
        if records:
            write_results(args.output, records)
        if process.poll() is None:
            process.kill()
            process.wait()

    print(json.dumps({
        "model": args.model,
        "fixtureCount": len(fixtures),
        "repeats": args.repeats,
        "generationCount": len(records),
        "wallSecondsIncludingWarmup": time.monotonic() - started,
        "results": str(args.output),
        "note": "smoke checks are not a semantic quality score; review rawText manually",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"benchmark error: {error}", file=sys.stderr)
        raise SystemExit(1)
