#!/usr/bin/env python3
"""Run applicable official MCP server scenarios through the stdio bridge."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import TextIO, cast

TOOL = "@modelcontextprotocol/conformance@0.1.11"
SCENARIOS = ("server-initialize", "ping", "tools-list")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", action="append", required=True)
    parser.add_argument("--file", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    npx = shutil.which("npx")
    if npx is None:
        raise SystemExit("npx is required for official MCP conformance")
    adapter = Path(__file__).with_name("http_adapter.py")
    with tempfile.TemporaryDirectory(prefix="openmoat-official-mcp-") as directory:
        for scenario in SCENARIOS:
            process = subprocess.Popen(  # noqa: S603 - caller selects implementation binary
                [
                    sys.executable,
                    str(adapter),
                    "--",
                    *args.binary,
                    "--file",
                    str(args.file.resolve()),
                    "serve",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                if process.stdout is None:
                    raise SystemExit("adapter stdout is unavailable")
                ready = json.loads(cast(TextIO, process.stdout).readline())
                url = str(ready["url"])
                subprocess.run(  # noqa: S603 - pinned official package
                    [
                        npx,
                        "-y",
                        TOOL,
                        "server",
                        "--url",
                        url,
                        "--scenario",
                        scenario,
                    ],
                    cwd=directory,
                    check=True,
                )
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1)
    print(f"official MCP conformance: {len(SCENARIOS)}/{len(SCENARIOS)} applicable")


if __name__ == "__main__":
    main()
