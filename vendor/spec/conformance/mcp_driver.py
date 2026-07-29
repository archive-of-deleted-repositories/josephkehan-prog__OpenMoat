from __future__ import annotations

import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any, TextIO, cast

import yaml
from jsonschema import Draft202012Validator, ValidationError

PROTOCOL_VERSION = "2025-11-25"


class DriverError(RuntimeError):
    pass


def _write_message(stream: TextIO, message: dict[str, object]) -> None:
    stream.write(json.dumps(message, separators=(",", ":")) + "\n")
    stream.flush()


def _read_message(
    process: subprocess.Popen[str],
    identifier: int,
    timeout: float,
) -> dict[str, Any]:
    if process.stdout is None:
        raise DriverError("gateway stdout is unavailable")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            remaining = max(deadline - time.monotonic(), 0)
            if not selector.select(remaining):
                break
            line = process.stdout.readline()
            if not line:
                code = process.poll()
                raise DriverError(f"gateway exited before MCP response (exit {code})")
            try:
                message = json.loads(line)
            except json.JSONDecodeError as error:
                raise DriverError("gateway wrote non-MCP data to stdout") from error
            if message.get("id") == identifier:
                return cast(dict[str, Any], message)
    finally:
        selector.close()
    raise DriverError(f"gateway MCP response timed out after {timeout:.3f}s")


def _request(
    process: subprocess.Popen[str],
    identifier: int,
    method: str,
    params: dict[str, object],
    timeout: float,
) -> dict[str, Any]:
    if process.stdin is None:
        raise DriverError("gateway stdin is unavailable")
    _write_message(
        cast(TextIO, process.stdin),
        {
            "jsonrpc": "2.0",
            "id": identifier,
            "method": method,
            "params": params,
        },
    )
    return _read_message(process, identifier, timeout)


def _initialize(process: subprocess.Popen[str], timeout: float) -> None:
    _request(
        process,
        1,
        "initialize",
        {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": "openmoat-conformance",
                "version": "0.2.0",
            },
        },
        timeout,
    )
    if process.stdin is None:
        raise DriverError("gateway stdin is unavailable")
    _write_message(
        cast(TextIO, process.stdin),
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
    )


def _text_content(result: dict[str, Any]) -> tuple[str, bool]:
    content = result.get("content")
    blocks = cast(list[object], content) if isinstance(content, list) else []
    texts: list[str] = []
    for value in blocks:
        if not isinstance(value, dict):
            continue
        block = cast(dict[str, object], value)
        if block.get("type") == "text":
            texts.append(str(block.get("text", "")))
    return "\n".join(texts), result.get("isError") is True


def _unwrap_nested_result(text: str, is_error: bool) -> tuple[str, bool]:
    try:
        nested = cast(object, json.loads(text))
    except json.JSONDecodeError:
        return text, is_error
    if not isinstance(nested, dict) or "content" not in nested:
        return text, is_error
    nested_text, nested_error = _text_content(cast(dict[str, Any], nested))
    return nested_text, is_error or nested_error


def _error_code(message: str) -> str:
    lowered = message.casefold()
    if "circuit" in lowered or "cooling down" in lowered or "locked out" in lowered:
        return "CIRCUIT_OPEN"
    if "timeout" in lowered or "timed out" in lowered:
        return "TIMEOUT"
    if "quarantin" in lowered:
        return "QUARANTINED"
    if "outside" in lowered and ("root" in lowered or "cwd" in lowered):
        return "PATH_OUTSIDE_ROOT"
    if "pool" in lowered and ("limit" in lowered or "full" in lowered):
        return "POOL_LIMIT"
    if "denied" in lowered or "unauthor" in lowered:
        return "UNAUTHORIZED"
    if (
        "process" in lowered
        or "exited" in lowered
        or "closed" in lowered
        or "not connected" in lowered
    ):
        return "PROCESS_FAILED"
    return "PROTOCOL_ERROR"


def _normalize_tool_response(message: dict[str, Any]) -> dict[str, object]:
    error = message.get("error")
    if isinstance(error, dict):
        detail = str(cast(dict[str, object], error).get("message", ""))
        return {"ok": False, "error": {"code": _error_code(detail)}}
    result = message.get("result")
    if not isinstance(result, dict):
        return {"ok": False, "error": {"code": "PROTOCOL_ERROR"}}
    text, is_error = _text_content(cast(dict[str, Any], result))
    text, is_error = _unwrap_nested_result(text, is_error)
    if is_error:
        return {"ok": False, "error": {"code": _error_code(text)}}
    return {"ok": True, "text": text}


def _tool_call(
    process: subprocess.Popen[str],
    identifier: int,
    tool: str,
    arguments: dict[str, object],
    timeout: float,
    cwd: str | None = None,
) -> dict[str, object]:
    gateway_arguments: dict[str, object] = {
        "server": "fixture",
        "tool": tool,
        "arguments": arguments,
    }
    if cwd is not None:
        gateway_arguments["cwd"] = cwd
    return _gateway_tool_call(
        process,
        identifier,
        "tool_call",
        gateway_arguments,
        timeout,
    )


def _gateway_tool_call(
    process: subprocess.Popen[str],
    identifier: int,
    name: str,
    arguments: dict[str, object],
    timeout: float,
) -> dict[str, object]:
    response = _request(
        process,
        identifier,
        "tools/call",
        {"name": name, "arguments": arguments},
        timeout,
    )
    return _normalize_tool_response(response)


def _fixture_path(case_path: Path) -> Path:
    candidate = (
        case_path.parent.parent / "fixtures" / "mcp" / "fixture_server.py"
    ).resolve()
    if not candidate.is_file():
        raise DriverError(f"MCP fixture server is missing: {candidate}")
    return candidate


def _moatfile(
    case: dict[str, Any],
    case_path: Path,
    root: Path,
    marker: str,
) -> tuple[Path, dict[str, Path]]:
    input_value = cast(dict[str, object], case.get("input", {}))
    server_value = dict(
        cast(dict[str, object], input_value.get("server", {}))
    )
    mode = str(server_value.pop("mode", "normal"))
    allowed = root / "allowed"
    outside = root / "outside"
    allowed.mkdir()
    outside.mkdir()
    working: list[Path] = []
    raw_working_count = input_value.get("workingDirectories", 0)
    working_count = raw_working_count if isinstance(raw_working_count, int) else 0
    for index in range(max(working_count, 3)):
        directory = allowed / f"project-{index}"
        directory.mkdir()
        working.append(directory)
    escape = allowed / "escape"
    escape.symlink_to(outside, target_is_directory=True)

    server: dict[str, object] = {
        "command": sys.executable,
        "args": [
            str(_fixture_path(case_path)),
            "--mode",
            mode,
            "--marker",
            marker,
        ],
        "env": server_value.pop("env", {}),
        "cwd": str(working[0]),
        "cwdRoots": [str(allowed)],
        "capabilities": ["public-read"],
        "zone": "default",
        "trust": "trusted",
        "startupTimeoutMs": 1000,
        "callTimeoutMs": 1000,
        "limits": {
            "failureThreshold": 3,
            "resetAfterMs": 1000,
            "maxConcurrentCalls": 2,
        },
    }
    server.update(server_value)
    gateway = {
        "callers": {
            "openmoat-conformance": {
                "allow": ["fixture:*"],
                "deny": [],
                "zone": "default",
            }
        },
        "zones": {"default": {"allowMixedRisk": False}},
        "limits": input_value.get(
            "gatewayLimits",
            {"maxPools": 8, "maxPoolsPerServer": 4, "idleTimeoutMs": 1000},
        ),
        "servers": {"fixture": server},
    }
    document = {
        "apiVersion": "openmoat.dev/v1",
        "kind": "Moatfile",
        "features": {},
        "paths": {"state": str(root / "state")},
        "targets": {},
        "gateway": gateway,
    }
    file = root / "Moatfile"
    file.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
    tools_dir = root / "state" / "mcp-tools"
    tools_dir.mkdir(parents=True)
    tools_dir.joinpath("fixture.md").write_text(
        """# MCP tool catalog — fixture

### fixture › echo

[untrusted metadata; server=fixture; trust=trusted]
Return the supplied value.

### fixture › process_identity

[untrusted metadata; server=fixture; trust=trusted]
Return the server process and working directory.
""",
        encoding="utf-8",
    )
    return file, {
        "allowed": allowed,
        "outside": outside,
        "escape": escape,
        **{f"working-{index}": value for index, value in enumerate(working)},
    }


def _marker_pids(marker: str) -> list[int]:
    completed = subprocess.run(  # noqa: S603 - fixed system process listing
        ["/bin/ps", "-axo", "pid=,command="],
        check=True,
        capture_output=True,
        text=True,
    )
    pids: list[int] = []
    for line in completed.stdout.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) == 2 and marker in fields[1]:
            pids.append(int(fields[0]))
    return pids


def _cleanup_marker_processes(marker: str) -> int:
    pids = _marker_pids(marker)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return len(pids)


def _close_process(process: subprocess.Popen[str], timeout: float) -> None:
    if process.stdin is not None and not process.stdin.closed:
        process.stdin.close()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=1)


def _caller_binding(process: subprocess.Popen[str], timeout: float) -> dict[str, object]:
    response = _request(process, 2, "tools/list", {}, timeout)
    result = response.get("result")
    result_mapping = cast(dict[str, object], result) if isinstance(result, dict) else {}
    raw_tools = result_mapping.get("tools", [])
    tools = cast(list[object], raw_tools) if isinstance(raw_tools, list) else []
    tool_call: dict[str, object] = {}
    for value in tools:
        if not isinstance(value, dict):
            continue
        candidate = cast(dict[str, object], value)
        if candidate.get("name") == "tool_call":
            tool_call = candidate
            break
    raw_schema = tool_call.get("inputSchema", {})
    schema = cast(dict[str, object], raw_schema) if isinstance(raw_schema, dict) else {}
    raw_properties = schema.get("properties", {})
    properties = (
        cast(dict[str, object], raw_properties)
        if isinstance(raw_properties, dict)
        else {}
    )
    return {
        "ok": True,
        "callerArgument": "caller" in properties,
    }


def _metadata_result(process: subprocess.Popen[str], timeout: float) -> dict[str, object]:
    response = _request(
        process,
        2,
        "tools/call",
        {
            "name": "tool_describe",
            "arguments": {"server": "fixture", "tool": "poisoned_tool"},
        },
        timeout,
    )
    normalized = _normalize_tool_response(response)
    text = str(normalized.get("text", ""))
    return {
        "ok": normalized.get("ok") is True,
        "controlCharacters": "\x1b" in text,
        "lengthWithinLimit": len(text) <= 4096,
        "provenance": "fixture" in text.casefold() and "untrusted" in text.casefold(),
    }


def _json_text(result: dict[str, object]) -> object:
    text = str(result.get("text", ""))
    try:
        return cast(object, json.loads(text))
    except json.JSONDecodeError:
        return {}


def _lazy_spawn(
    process: subprocess.Popen[str],
    timeout: float,
    marker: str,
) -> dict[str, object]:
    before = len(_marker_pids(marker))
    result = _tool_call(process, 2, "echo", {"value": "spawned"}, timeout)
    after = len(_marker_pids(marker))
    return {
        "ok": result.get("ok") is True,
        "before": before,
        "after": after,
    }


def _reuse_isolation(
    process: subprocess.Popen[str],
    paths: dict[str, Path],
    timeout: float,
) -> dict[str, object]:
    first = _tool_call(
        process,
        2,
        "process_identity",
        {},
        timeout,
        str(paths["working-0"]),
    )
    warm = _tool_call(
        process,
        3,
        "process_identity",
        {},
        timeout,
        str(paths["working-0"]),
    )
    isolated = _tool_call(
        process,
        4,
        "process_identity",
        {},
        timeout,
        str(paths["working-1"]),
    )
    first_value = _json_text(first)
    warm_value = _json_text(warm)
    isolated_value = _json_text(isolated)
    first_map = cast(dict[str, object], first_value) if isinstance(first_value, dict) else {}
    warm_map = cast(dict[str, object], warm_value) if isinstance(warm_value, dict) else {}
    isolated_map = (
        cast(dict[str, object], isolated_value)
        if isinstance(isolated_value, dict)
        else {}
    )
    return {
        "ok": all(result.get("ok") is True for result in (first, warm, isolated)),
        "warmReuse": first_map.get("pid") == warm_map.get("pid"),
        "cwdIsolation": (
            first_map.get("pid") != isolated_map.get("pid")
            and first_map.get("cwd") == str(paths["working-0"])
            and isolated_map.get("cwd") == str(paths["working-1"])
        ),
    }


def _failure_recovery(
    process: subprocess.Popen[str],
    timeout: float,
) -> dict[str, object]:
    failed = _tool_call(process, 2, "crash_process", {}, timeout)
    error = failed.get("error")
    error_map = cast(dict[str, object], error) if isinstance(error, dict) else {}
    recovered = _tool_call(
        process,
        3,
        "echo",
        {"value": "recovered"},
        timeout,
    )
    return {
        "ok": recovered.get("ok") is True,
        "firstError": error_map.get("code", ""),
        "recovered": recovered.get("text") == "recovered",
    }


def _tool_routing(
    process: subprocess.Popen[str],
    timeout: float,
) -> dict[str, object]:
    first = _gateway_tool_call(
        process,
        2,
        "tool_search",
        {"query": "echo", "k": 5},
        timeout,
    )
    second = _gateway_tool_call(
        process,
        3,
        "tool_search",
        {"query": "echo", "k": 5},
        timeout,
    )
    described = _gateway_tool_call(
        process,
        4,
        "tool_describe",
        {"server": "fixture", "tool": "echo"},
        timeout,
    )
    called = _tool_call(
        process,
        5,
        "echo",
        {"value": "route-ok"},
        timeout,
    )
    first_text = str(first.get("text", ""))
    described_text = str(described.get("text", ""))
    return {
        "ok": all(
            result.get("ok") is True
            for result in (first, second, described, called)
        ),
        "search": "echo" in first_text.casefold(),
        "deterministic": first_text == str(second.get("text", "")),
        "describe": (
            "echo" in described_text.casefold()
            and "fixture" in described_text.casefold()
        ),
        "call": called.get("text") == "route-ok",
    }


def _health_report(
    process: subprocess.Popen[str],
    case_path: Path,
    timeout: float,
) -> dict[str, object]:
    _tool_call(process, 2, "echo", {"value": "health"}, timeout)
    response = _gateway_tool_call(process, 3, "moat_health", {}, timeout)
    health = _json_text(response)
    health_map = cast(dict[str, object], health) if isinstance(health, dict) else {}
    servers = health_map.get("servers")
    server_map = cast(dict[str, object], servers) if isinstance(servers, dict) else {}
    fixture = server_map.get("fixture")
    fixture_map = cast(dict[str, object], fixture) if isinstance(fixture, dict) else {}
    schema = cast(
        dict[str, Any],
        json.loads(
        (
            case_path.parent.parent / "schemas" / "health-v1.schema.json"
        ).read_text(encoding="utf-8")
        ),
    )
    schema_valid = True
    try:
        health_validator: Any = Draft202012Validator(schema)
        health_validator.validate(health)
    except ValidationError:
        schema_valid = False
    return {
        "ok": response.get("ok") is True,
        "schemaValid": schema_valid,
        "childStatus": (
            fixture_map.get("status") == "ready"
            and isinstance(fixture_map.get("children"), int)
            and cast(int, fixture_map["children"]) >= 1
        ),
        "latency": isinstance(fixture_map.get("latencyMs"), (int, float)),
        "failures": isinstance(fixture_map.get("failures"), int),
    }


def _execute_operation(
    process: subprocess.Popen[str],
    case: dict[str, Any],
    case_path: Path,
    paths: dict[str, Path],
    marker: str,
    timeout: float,
) -> dict[str, object]:
    operation = str(case["operation"])
    input_value = cast(dict[str, Any], case.get("input", {}))
    arguments = cast(dict[str, object], input_value.get("arguments", {}))
    tool = str(input_value.get("tool", "echo"))
    if operation == "caller_binding":
        return _caller_binding(process, timeout)
    if operation == "lazy_spawn":
        return _lazy_spawn(process, timeout, marker)
    if operation == "reuse_isolation":
        return _reuse_isolation(process, paths, timeout)
    if operation == "failure_recovery":
        return _failure_recovery(process, timeout)
    if operation == "tool_routing":
        return _tool_routing(process, timeout)
    if operation == "health_report":
        return _health_report(process, case_path, timeout)
    if operation == "metadata_poisoning":
        return _metadata_result(process, timeout)
    if operation == "cwd_root_escape":
        return _tool_call(
            process,
            2,
            tool,
            arguments,
            timeout,
            str(paths["escape"]),
        )
    if operation == "pool_limit":
        result: dict[str, object] = {"ok": True}
        count = int(input_value.get("workingDirectories", 3))
        for index in range(count):
            result = _tool_call(
                process,
                index + 2,
                tool,
                arguments,
                timeout,
                str(paths[f"working-{index}"]),
            )
        return result
    if operation == "partial_startup_cleanup":
        _tool_call(process, 2, tool, arguments, timeout)
        time.sleep(0.2)
        return {
            "ok": True,
            "childrenRemaining": len(_marker_pids(marker)),
        }
    result = _tool_call(process, 2, tool, arguments, timeout)
    if operation == "timeout" and result.get("error") == {"code": "TIMEOUT"}:
        followup = _tool_call(process, 3, tool, arguments, timeout)
        result["circuit"] = (
            "open"
            if followup.get("error") == {"code": "CIRCUIT_OPEN"}
            else "closed"
        )
    return result


def _spawn_gateway(
    binary: Sequence[str],
    file: Path,
    environment: dict[str, str],
    stderr: TextIO,
    *,
    orphan_parent: bool,
) -> subprocess.Popen[str]:
    command = [*binary, "--file", str(file), "serve"]
    if orphan_parent:
        launcher = (
            "import subprocess,sys;"
            "subprocess.Popen(sys.argv[1:],stdin=sys.stdin,stdout=sys.stdout,"
            "stderr=sys.stderr);"
        )
        command = [sys.executable, "-c", launcher, *command]
    return subprocess.Popen(  # noqa: S603 - caller selects implementation binary
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=stderr,
        text=True,
        bufsize=1,
        env=environment,
    )


def run_mcp_case(
    binary: Sequence[str],
    case: dict[str, Any],
    case_path: Path,
    timeout: float,
) -> tuple[dict[str, object], str]:
    marker = f"openmoat-conformance-{uuid.uuid4().hex}"
    input_value = cast(dict[str, Any], case.get("input", {}))
    environment = os.environ.copy()
    environment.update(
        {
            str(name): str(value)
            for name, value in cast(
                dict[str, object], input_value.get("gatewayEnvironment", {})
            ).items()
        }
    )
    with tempfile.TemporaryDirectory(prefix="openmoat-conformance-") as directory:
        root = Path(directory)
        file, paths = _moatfile(case, case_path, root, marker)
        with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as stderr:
            operation = str(case["operation"])
            process = _spawn_gateway(
                binary,
                file,
                environment,
                stderr,
                orphan_parent=operation == "orphan_cleanup",
            )
            actual: dict[str, object]
            try:
                _initialize(process, min(timeout, 5))
                if operation in {"signal_cleanup", "orphan_cleanup"}:
                    call = _tool_call(
                        process,
                        2,
                        "echo",
                        {"value": "ready"},
                        timeout,
                    )
                    if operation == "signal_cleanup":
                        process.send_signal(signal.SIGTERM)
                        process.wait(timeout=min(timeout, 3))
                    else:
                        deadline = time.monotonic() + min(max(timeout, 6), 10)
                        while _marker_pids(marker) and time.monotonic() < deadline:
                            time.sleep(0.1)
                    time.sleep(0.1)
                    actual = {
                        "ok": call.get("ok") is True,
                        "childrenRemaining": len(_marker_pids(marker)),
                    }
                else:
                    actual = _execute_operation(
                        process,
                        case,
                        case_path,
                        paths,
                        marker,
                        timeout,
                    )
            except (DriverError, BrokenPipeError, OSError) as error:
                actual = {
                    "ok": False,
                    "error": {"code": _error_code(str(error))},
                }
            finally:
                if operation != "signal_cleanup":
                    _close_process(process, min(timeout, 3))
            time.sleep(0.05)
            children_remaining = _cleanup_marker_processes(marker)
            if case["operation"] == "shutdown":
                actual = {"ok": True, "childrenRemaining": children_remaining}
            stderr.seek(0)
            diagnostic = stderr.read()

    redactions = [str(value) for value in case.get("redact", [])]
    leaked = any(secret and secret in json.dumps(actual) + diagnostic for secret in redactions)
    if case["operation"] == "secret_redaction":
        actual["leaked"] = leaked
    return actual, diagnostic
