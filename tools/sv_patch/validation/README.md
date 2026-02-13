# Safe-Vibe Runner Contract Validation Framework

This directory is a behavioral contract harness for the Runner implementation at:

`tools/sv_patch/sv_patch-(DeepSeekV1)_multiline_atomic_v3.py`

## Runtime Source of Truth (Enforced)

All contract execution is performed only through the runner above. No alternate implementations, wrappers, or mock simulators define behavior.

If documentation and runtime differ, runtime output from that file is authoritative.

## Validation Philosophy

- Contract definitions live in `.rw` scripts.
- Pipelines orchestrate deterministic scenario groups.
- Baseline reports lock expected behavior.
- New runs are compared against baselines with normalization of dynamic metadata.

## Directory Layout

- `pipelines/`: orchestration files (`*.pipeline.json`)
- `scripts/`: DSL contract scenarios (`*.rw`) grouped by domain
- `baselines/reports/`: baseline `sv-report.json` snapshots per pipeline+mode
- `baselines/summaries/`: baseline markdown summaries
- `runner/run_validation.py`: executes plan/apply suites
- `runner/compare_reports.py`: normalized comparison engine
- `artifacts/latest/`: latest execution outputs

## Running the Suite

From repository root:

```bash
python tools/sv_patch/validation/runner/run_validation.py
```

- Exit code `0`: no regression
- Exit code `1`: behavioral drift detected

To (re)create baselines:

```bash
python tools/sv_patch/validation/runner/run_validation.py --write-baseline
```

## CI Integration

Use exactly:

```bash
python tools/sv_patch/validation/runner/run_validation.py
```

and fail pipeline on non-zero exit code.

## Adding New Contract Tests

1. Add one or more `.rw` files under the relevant `scripts/<domain>/` folder.
2. Follow naming convention: `<scenario>_<expected_behavior>.rw`.
3. Add script path(s) to a pipeline in `pipelines/`.
4. Refresh baselines with `--write-baseline`.
5. Commit scripts, pipeline edits, and baseline updates together.

## DSL Script Guidelines (AAA Pattern)

Inside each `.rw`:

- **Arrange:** create deterministic state (`UPSERT_FILE`/assertions)
- **Act:** invoke operation(s) under test
- **Assert:** verify final contract state

Prefer idempotent scripts that converge on repeated apply runs.

## Notes on Normalization

`compare_reports.py` ignores dynamic metadata such as run identifiers, timestamps, duration, and artifact paths, but compares operation outcomes, diffs, changed flags, and error contracts.
