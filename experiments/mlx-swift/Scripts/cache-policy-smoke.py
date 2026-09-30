#!/usr/bin/env python3
"""Check helper error recovery and allocator cleanup between independent notes."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import queue
import subprocess
import sys
import threading


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", required=True, type=pathlib.Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-directory", required=True, type=pathlib.Path)
    parser.add_argument("--cache", type=pathlib.Path)
    parser.add_argument(
        "--fixtures",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parents[1] / "Fixtures/folio-prompts.jsonl",
    )
    args = parser.parse_args()
    if not args.helper.is_file() or not args.model_directory.is_dir():
        parser.error("helper and local model directory must already exist")
    fixture = next(
        json.loads(line)
        for line in args.fixtures.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )
    helper = args.helper.resolve()
    model_directory = args.model_directory.resolve()
    environment = os.environ.copy()
    for key in tuple(environment):
        if key.startswith("DYLD_"):
            del environment[key]
    if args.cache:
        environment["HF_HUB_CACHE"] = str(args.cache.resolve())
    process = subprocess.Popen(
        [
            str(helper),
            "--model",
            args.model,
            "--model-directory",
            str(model_directory),
            "--max-tokens",
            "512",
            "--temperature",
            "0",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        bufsize=1,
        cwd="/private/tmp",
        env=environment,
    )
    assert process.stdin is not None and process.stdout is not None
    output_lines = queue.Queue()

    def read_output() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            output_lines.put(line)
        output_lines.put(None)

    reader = threading.Thread(target=read_output, name="folio-mlx-smoke-stdout", daemon=True)
    reader.start()

    def next_response(context: str) -> dict[str, object]:
        try:
            line = output_lines.get(timeout=300)
        except queue.Empty as error:
            raise RuntimeError(f"timed out waiting for {context}") from error
        if line is None:
            raise RuntimeError(f"helper exited before {context}")
        value = json.loads(line)
        if not isinstance(value, dict):
            raise RuntimeError(f"helper returned a non-object for {context}")
        return value

    try:
        process.stdin.write(json.dumps({"id": "expected-error", "messages": []}) + "\n")
        process.stdin.flush()
        error = next_response("error-cleanup response")
        if "error" not in error:
            raise RuntimeError(f"invalid request did not return an error: {error}")
        require_empty_cache(error.get("metrics", {}), "error response")

        responses = []
        for request_id in ("independent-note-1", "independent-note-2"):
            request = dict(fixture)
            request["id"] = request_id
            process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            process.stdin.flush()
            response = next_response(request_id)
            if response.get("id") != request_id or "error" in response:
                raise RuntimeError(f"invalid response for {request_id}: {response}")
            require_empty_cache(response.get("metrics", {}), request_id)
            responses.append(response)

        process.stdin.close()
        exit_code = process.wait(timeout=15)
        if exit_code != 0:
            raise RuntimeError(f"helper exited with status {exit_code}")
        print(
            json.dumps(
                {
                    "model": args.model,
                    "errorCleanupCacheBytes": error["metrics"]["mlxAfterCleanupCacheBytes"],
                    "requests": [
                        {
                            "id": response["id"],
                            "afterCleanupCacheBytes": response["metrics"]["mlxAfterCleanupCacheBytes"],
                            "generationCacheBytes": response["metrics"]["mlxGenerationCacheBytes"],
                            "rawText": response["text"],
                        }
                        for response in responses
                    ],
                    "processExitCode": exit_code,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 0
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait()


def require_empty_cache(metrics: dict[str, object], context: str) -> None:
    cached = metrics.get("mlxAfterCleanupCacheBytes")
    if not isinstance(cached, int) or cached != 0:
        raise RuntimeError(f"{context} retained allocator cache: {cached!r}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"cache policy smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
