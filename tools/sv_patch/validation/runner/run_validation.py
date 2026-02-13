#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
VALIDATION_ROOT = ROOT / "tools" / "sv_patch" / "validation"
RUNNER = ROOT / "tools" / "sv_patch" / "sv_patch-(DeepSeekV1)_multiline_atomic_v3.py"
BASELINES = VALIDATION_ROOT / "baselines" / "reports"
BASELINE_SUMMARIES = VALIDATION_ROOT / "baselines" / "summaries"
ARTIFACTS = VALIDATION_ROOT / "artifacts"
LATEST = ARTIFACTS / "latest"

PIPELINE_PROFILES = {
    "file_ops.pipeline.json": {
        "expected_exit": {"plan": 0, "apply": 0},
        "extra_args": [],
    },
    "regex_ops.pipeline.json": {
        "expected_exit": {"plan": 0, "apply": 0},
        "extra_args": [],
    },
    "multiline.pipeline.json": {
        "expected_exit": {"plan": 0, "apply": 0},
        "extra_args": [],
    },
    "execution_modes.pipeline.json": {
        "expected_exit": {"plan": 1, "apply": 1},
        "extra_args": ["--strict"],
    },
    "safety_limits.pipeline.json": {
        "expected_exit": {"plan": 1, "apply": 1},
        "extra_args": [
            "--strict",
            "--allow",
            "tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp",
            "--max-files",
            "1",
            "--max-total-write-bytes",
            "15",
        ],
    },
    "history_backup.pipeline.json": {
        "expected_exit": {"plan": 1, "apply": 1},
        "extra_args": ["--strict", "--backup", "--rollback-on-fail"],
    },
}


def _discover_pipelines() -> list[Path]:
    return sorted((VALIDATION_ROOT / "pipelines").glob("*.pipeline.json"))


def _run_cmd(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=str(ROOT), text=True, capture_output=True)


def _mode_report_path(pipeline_name: str, mode: str) -> Path:
    return LATEST / "reports" / f"{pipeline_name}.{mode}.report.json"


def _baseline_report_path(pipeline_name: str, mode: str) -> Path:
    return BASELINES / f"{pipeline_name}.{mode}.report.json"


def _baseline_summary_path(pipeline_name: str, mode: str) -> Path:
    return BASELINE_SUMMARIES / f"{pipeline_name}.{mode}.summary.md"


def _normalize_compare_script() -> Path:
    return VALIDATION_ROOT / "runner" / "compare_reports.py"


def run_pipeline(pipeline: Path, mode: str, write_baseline: bool) -> tuple[bool, str]:
    profile = PIPELINE_PROFILES.get(pipeline.name, {"expected_exit": {"plan": 0, "apply": 0}, "extra_args": []})

    scenario = pipeline.name.replace(".pipeline.json", "")
    workspace = ROOT / "tools" / "sv_patch" / "validation" / "artifacts" / "workspaces" / scenario
    shutil.rmtree(workspace, ignore_errors=True)

    report_path = _mode_report_path(pipeline.stem, mode)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    (LATEST / "summaries").mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        str(RUNNER),
        "--root",
        str(ROOT),
        "--pipeline",
        str(pipeline),
        "--report",
        str(report_path),
        f"--{mode}",
    ]
    cmd.extend(profile.get("extra_args", []))

    proc = _run_cmd(cmd)
    expected_exit = profile["expected_exit"][mode]

    if proc.returncode != expected_exit:
        return False, (
            f"{pipeline.name}:{mode} unexpected exit {proc.returncode} expected {expected_exit}\n"
            f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )

    if not report_path.exists():
        return False, f"{pipeline.name}:{mode} missing report {report_path}"

    report = json.loads(report_path.read_text(encoding="utf-8"))
    summary_path = report.get("summary_path")
    if isinstance(summary_path, str) and summary_path:
        src = Path(summary_path)
        if src.exists():
            shutil.copy2(src, LATEST / "summaries" / f"{pipeline.stem}.{mode}.summary.md")

    baseline_report = _baseline_report_path(pipeline.stem, mode)
    if write_baseline:
        baseline_report.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(report_path, baseline_report)
        latest_summary = LATEST / "summaries" / f"{pipeline.stem}.{mode}.summary.md"
        if latest_summary.exists():
            _baseline_summary_path(pipeline.stem, mode).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(latest_summary, _baseline_summary_path(pipeline.stem, mode))
        return True, f"{pipeline.name}:{mode} baseline updated"

    if not baseline_report.exists():
        return False, f"{pipeline.name}:{mode} baseline missing: {baseline_report} (run with --write-baseline)"

    cmp_cmd = [
        sys.executable,
        str(_normalize_compare_script()),
        "--baseline",
        str(baseline_report),
        "--candidate",
        str(report_path),
    ]
    cmp_proc = _run_cmd(cmp_cmd)
    if cmp_proc.returncode != 0:
        return False, f"{pipeline.name}:{mode} regression\n{cmp_proc.stdout}\n{cmp_proc.stderr}"

    return True, f"{pipeline.name}:{mode} ok"


def main() -> int:
    ap = argparse.ArgumentParser(description="Run Safe-Vibe validation harness")
    ap.add_argument("--write-baseline", action="store_true", help="Generate/refresh baseline reports")
    args = ap.parse_args()

    if not RUNNER.exists():
        print(f"Runner not found: {RUNNER}")
        return 2

    shutil.rmtree(LATEST, ignore_errors=True)
    (LATEST / "reports").mkdir(parents=True, exist_ok=True)
    (LATEST / "summaries").mkdir(parents=True, exist_ok=True)

    results: list[tuple[bool, str]] = []
    pipelines = _discover_pipelines()
    for p in pipelines:
        for mode in ("plan", "apply"):
            results.append(run_pipeline(p, mode, args.write_baseline))

    failures = [msg for ok, msg in results if not ok]
    for ok, msg in results:
        print(("PASS" if ok else "FAIL"), msg)

    summary = {
        "total": len(results),
        "failed": len(failures),
        "write_baseline": bool(args.write_baseline),
        "runner": str(RUNNER.relative_to(ROOT)),
    }
    (LATEST / "validation-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
