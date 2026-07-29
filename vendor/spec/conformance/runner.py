from __future__ import annotations

import argparse
import json
import os
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from conformance.mcp_driver import run_mcp_case

VOLATILE_KEYS = frozenset({"elapsed_ms", "latency_ms", "pid", "started_at", "timestamp"})


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    passed: bool
    expected: object
    actual: object
    message: str

    def as_json(self) -> dict[str, object]:
        return {
            "case": self.case_id,
            "passed": self.passed,
            "expected": self.expected,
            "actual": self.actual,
            "message": self.message,
        }


def normalize(value: object) -> object:
    if isinstance(value, dict):
        mapping = cast(dict[str, object], value)
        return {
            key: normalize(item)
            for key, item in sorted(mapping.items())
            if key not in VOLATILE_KEYS
        }
    if isinstance(value, list):
        return [normalize(item) for item in cast(list[object], value)]
    return value


def matches_expected(expected: object, actual: object) -> bool:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        expected_mapping = cast(dict[str, object], expected)
        actual_mapping = cast(dict[str, object], actual)
        return all(
            key in actual_mapping and matches_expected(value, actual_mapping[key])
            for key, value in expected_mapping.items()
        )
    if isinstance(expected, list):
        expected_items = cast(list[object], expected)
        if not isinstance(actual, list):
            return False
        actual_items = cast(list[object], actual)
        if len(expected_items) != len(actual_items):
            return False
        return all(
            matches_expected(expected_item, actual_item)
            for expected_item, actual_item in zip(
                expected_items, actual_items, strict=True
            )
        )
    return expected == actual


def _redact(message: str, case: dict[str, Any]) -> str:
    secrets = {
        value
        for value in os.environ.values()
        if value and len(value) >= 8
    }
    secrets.update(str(value) for value in case.get("redact", []) if value)
    result = message
    for secret in sorted(secrets, key=len, reverse=True):
        result = result.replace(secret, "[REDACTED]")
    return result


def run_case(binary: Sequence[str], case_path: Path, timeout: float = 10.0) -> CaseResult:
    case = json.loads(case_path.read_text(encoding="utf-8"))
    driver = case.get("driver", "contract")
    if driver == "cli":
        fixture = case_path.parent.parent / str(case["input"]["fixture"])
        command = [*binary, "--file", str(fixture), "validate", "--json"]
    elif driver == "contract":
        command = [*binary, "conformance", "--case", str(case_path), "--json"]
    elif driver == "mcp":
        expected = normalize(case["expected"])
        try:
            actual, diagnostic = run_mcp_case(binary, case, case_path, timeout)
        except (OSError, RuntimeError) as error:
            return CaseResult(
                str(case["id"]),
                False,
                expected,
                {},
                _redact(str(error), case),
            )
        normalized = normalize(actual)
        passed = matches_expected(expected, normalized)
        message = "" if passed else _redact(diagnostic.strip() or "result mismatch", case)
        return CaseResult(str(case["id"]), passed, expected, normalized, message)
    else:
        expected = normalize(case["expected"])
        return CaseResult(
            str(case["id"]),
            False,
            expected,
            {},
            f"unsupported conformance driver: {driver}",
        )
    try:
        completed = subprocess.run(  # noqa: S603 - the user explicitly selects the binary
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=os.environ.copy(),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return CaseResult(
            str(case["id"]),
            False,
            normalize(case["expected"]),
            {},
            _redact(str(exc), case),
        )
    try:
        actual = json.loads(completed.stdout)
    except json.JSONDecodeError:
        actual = {"exitCode": completed.returncode, "stderr": completed.stderr.strip()}
    expected = normalize(case["expected"])
    normalized = normalize(actual)
    expected_exit = (
        0
        if driver == "contract" or bool(case["expected"].get("ok"))
        else 1
    )
    passed = completed.returncode == expected_exit and matches_expected(expected, normalized)
    message = "" if passed else _redact(completed.stderr.strip() or "result mismatch", case)
    return CaseResult(str(case["id"]), passed, expected, normalized, message)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run OpenMoat conformance cases")
    parser.add_argument("--binary", action="append", required=True, help="binary and arguments")
    parser.add_argument("--case", type=Path, action="append", required=True)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--json", action="store_true")
    return parser


def main() -> int:
    args = _parser().parse_args()
    results = [run_case(args.binary, case, args.timeout) for case in args.case]
    payload: dict[str, object] = {
        "passed": all(result.passed for result in results),
        "results": [result.as_json() for result in results],
    }
    print(json.dumps(payload, sort_keys=True) if args.json else _human(payload))
    return 0 if payload["passed"] else 1


def _human(payload: dict[str, object]) -> str:
    results = cast(list[dict[str, object]], payload["results"])
    lines = [f"OpenMoat conformance: {'PASS' if payload['passed'] else 'FAIL'}"]
    for result in results:
        lines.append(f"- {result['case']}: {'PASS' if result['passed'] else 'FAIL'}")
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
