#!/usr/bin/env python3
"""Run the pinned offline GLiNER2.5 Multi reference cases against folio-mlx."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


MODEL = "fastino/gliner2.5-multi-v1"
MODEL_REVISION = "7b005274e82da37dcf1f5fd9d6a2ef413c6a004c"
FIXTURE = Path(__file__).parents[1] / "Tests/FolioMLXEntitiesTests/Fixtures/gliner25-reference-parity.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", required=True, type=Path, help="built folio-mlx executable")
    parser.add_argument("--model-directory", required=True, type=Path, help="installed pinned checkpoint")
    args = parser.parse_args()
    fixture = json.loads(FIXTURE.read_text())
    if fixture["model"] != MODEL or fixture["modelRevision"] != MODEL_REVISION:
        raise SystemExit("parity fixture model pin does not match this runner")

    requests = []
    for case in fixture["cases"]:
        requests.append({
            "id": case["id"],
            "operation": "extract_entities",
            "text": case["text"],
            "schemaVersion": case["schemaVersion"],
            "labels": case["labels"],
            "maxTokens": case["maxTokens"],
            "scoreThreshold": 0.5,
        })
    requests.append({"id": "parity-shutdown", "operation": "shutdown"})
    command = [str(args.helper), "--task", "entities", "--model", MODEL,
               "--revision", MODEL_REVISION, "--model-directory", str(args.model_directory)]
    result = subprocess.run(command, input="\n".join(map(json.dumps, requests)) + "\n",
                            text=True, capture_output=True, check=False)
    if result.returncode:
        sys.stderr.write(result.stderr)
        sys.stderr.write(result.stdout)
        return result.returncode

    rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    by_id = {row.get("id"): row for row in rows if row.get("id")}
    tolerance = fixture["scoreAbsoluteTolerance"]
    total = 0
    max_delta = 0.0
    for case in fixture["cases"]:
        row = by_id.get(case["id"])
        if row is None:
            raise SystemExit(f"helper returned no result for {case['id']}")
        expected = case["expected"]["mentions"]
        actual = row.get("mentions", [])
        key = lambda item: (item["startUtf16"], item["endUtf16"], item["type"], item["text"])
        expected_by_key = {key(item): item for item in expected}
        actual_by_key = {key(item): item for item in actual}
        if expected_by_key.keys() != actual_by_key.keys():
            missing = sorted(expected_by_key.keys() - actual_by_key.keys())
            extra = sorted(actual_by_key.keys() - expected_by_key.keys())
            raise SystemExit(f"{case['id']}: mention mismatch; missing={missing}, extra={extra}")
        for mention_key, expected_item in expected_by_key.items():
            delta = abs(expected_item["score"] - actual_by_key[mention_key]["score"])
            max_delta = max(max_delta, delta)
            if delta > tolerance:
                raise SystemExit(f"{case['id']}: score delta {delta:.9g} exceeds {tolerance}")
        if row.get("tokenCount") != len(case["expected"]["inputIds"]):
            raise SystemExit(f"{case['id']}: input token count differs from reference fixture")
        total += len(expected)
        print(f"{case['id']}: {len(expected)} exact mentions")
    print(f"PASS: {len(fixture['cases'])} cases, {total} exact mentions, max score delta {max_delta:.9g}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
