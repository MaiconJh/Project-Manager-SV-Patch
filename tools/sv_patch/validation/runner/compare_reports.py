#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

DYNAMIC_KEYS = {
    "duration_ms",
    "summary_path",
    "started_at",
    "finished_at",
    "run_id",
    "change_id",
    "parent_run_id",
    "run_path",
    "manifest_path",
    "report_path",
}


def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in DYNAMIC_KEYS:
                continue
            if k == "artifacts" and isinstance(v, dict):
                # artifact paths are dynamic by run
                continue
            out[k] = _normalize(v)
        return out
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def compare_reports(baseline: Path, candidate: Path) -> tuple[bool, str]:
    b = json.loads(baseline.read_text(encoding="utf-8"))
    c = json.loads(candidate.read_text(encoding="utf-8"))

    nb = _normalize(b)
    nc = _normalize(c)

    if nb == nc:
        return True, "MATCH"

    return False, json.dumps({"baseline": nb, "candidate": nc}, indent=2, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser(description="Compare runner reports with normalization")
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--candidate", required=True)
    args = ap.parse_args()

    ok, detail = compare_reports(Path(args.baseline), Path(args.candidate))
    if ok:
        print("MATCH")
        return 0

    print("MISMATCH")
    print(detail)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
