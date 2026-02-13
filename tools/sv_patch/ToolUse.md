# ToolUse.md — Safe-Vibe Runner Operational Guide

> **Filename note:** Kept as `ToolUse.md` (default requested). A semantically stronger name could be `RunnerUsageContract.md`, but no rename is applied to preserve compatibility with your instruction.

## 1. TOOL OVERVIEW

The runner (`sv_patch-(DeepSeekV1)_multiline_atomic_v3.py`) is a pipeline-driven patch orchestrator for applying structured text/file edits from `.rw` scripts under strict safety controls.

Its role is to:
- Load a JSON pipeline with ordered steps/scripts.
- Parse `.rw` DSL commands (including multiline payloads).
- Stage mutations in an in-memory VFS.
- Validate limits/safety before disk writes.
- Commit changes with atomic per-file replace semantics.
- Emit execution reports and optional history lineage.

Philosophy: deterministic, idempotent-oriented patch execution with explicit no-op policy (`STRICT + ALLOW_NOOP`) and path/allowlist safety boundaries.

---

## 2. CURRENT ARCHITECTURE SUMMARY

### DSL `.rw` execution model
- Scripts are loaded line-by-line via `load_changes`.
- Commands parse as `OP | file | ...` with escaped pipe support.
- Each command is normalized/validated, then executed in pipeline order.

### VFS staging layer
- In-memory structures:
  - `vfs: Dict[str, str]` (staged file contents)
  - `deleted_files: set` (logical deletes)
  - `changed_files: Dict[str, dict]` (final commit metadata)
- Helpers:
  - `_get_file_text` reads from staged/deleted/disk view.
  - `_set_file_text` stages content + mutation metadata.
  - `_delete_file_text` stages logical deletion.

### Atomic disk commit
- Apply happens only after execution succeeds and limits pass.
- Write flow for each changed file:
  - temp file `*.svtmp...`
  - `os.replace(tmp, abs_path)`
- Deletes happen through `_delete_file`.

### Plan vs Apply
- `--plan`: full parse/validation/simulation/reporting, no disk mutation.
- `--apply`: performs final delete/write commit if no blocking errors.

### Backup + History lineage integration
- Enabled only when `--backup` and apply mode.
- Creates `data/history/runs/<yyyy>/<mm>/<dd>/<run_id>/...`.
- Produces `manifest.json`, per-file backups, diffs, artifacts.
- Maintains `runs.jsonl` and `by-path.jsonl` indexes.

### Execution pipeline structure
- Pipeline JSON requires non-empty `steps[]`; each step requires non-empty `scripts`.
- Steps execute in order; first failed step stops remaining execution.

### Reporting (`sv-report.json`)
- CLI always writes JSON report to `--report` path.
- Includes pipeline metadata, step/script/file entries, errors, scans, rollback, limits, history metadata.

### Limits + allowlist system
- Path-level gate: `is_path_allowed` (`is_path_safe` + allow prefixes).
- Apply-time limits:
  - max changed files (`--max-files`)
  - max total write bytes (`--max-total-write-bytes`)

---

## 3. DSL COMMAND REFERENCE (CURRENT IMPLEMENTATION ONLY)

> General DSL shape: `OP | file | arg1 | arg2 | KEY=VALUE ...`
>
> Global option behavior:
> - Options are parsed as `key=value` tokens by parser.
> - Runtime option lookup is case-insensitive.
> - `ALLOW_NOOP` is interpreted via boolean parser (`1,true,yes,y,on`).

### Assertions

#### `ASSERT_FILE_EXISTS`
- **Syntax:** `ASSERT_FILE_EXISTS | path`
- **Behavior:** Fails if file not present in current staged view.
- **Idempotency:** Always read-only.
- **Errors:** `ASSERT_FILE_EXISTS_FAILED`.
- **Strict/ALLOW_NOOP:** Not applicable.
- **Example:** `ASSERT_FILE_EXISTS | src/app.py`

#### `ASSERT_FILE_NOT_EXISTS`
- **Syntax:** `ASSERT_FILE_NOT_EXISTS | path`
- **Behavior:** Fails if file exists.
- **Errors:** `ASSERT_FILE_NOT_EXISTS_FAILED`.
- **Example:** `ASSERT_FILE_NOT_EXISTS | build/tmp.txt`

#### `ASSERT_REGEX`
- **Syntax:** `ASSERT_REGEX | path | <regex>`
- **Behavior:** Fails if regex does not match file content.
- **Errors:** `FILE_NOT_FOUND`, `REGEX_ERROR: ...`, `ASSERT_REGEX_FAILED`.
- **Example:** `ASSERT_REGEX | src/app.py | ^def main\(`

#### `ASSERT_NOT_REGEX`
- **Syntax:** `ASSERT_NOT_REGEX | path | <regex>`
- **Behavior:** Passes for missing file; fails if regex matches existing file.
- **Errors:** `REGEX_ERROR: ...`, `ASSERT_NOT_REGEX_FAILED`.
- **Example:** `ASSERT_NOT_REGEX | src/app.py | TODO`

#### `ASSERT_REGEX_COUNT`
- **Syntax:** `ASSERT_REGEX_COUNT | path | <regex> | <int>`
- **Behavior:** Requires exact match count.
- **Errors:** `FILE_NOT_FOUND`, `INVALID_ARGS expected integer count`, `REGEX_ERROR: ...`, `ASSERT_REGEX_COUNT_FAILED ...`.
- **Example:** `ASSERT_REGEX_COUNT | src/app.py | import\s+os | 1`

### Mutation Commands

#### `CREATE_FILE`
- **Syntax:** `CREATE_FILE | path | <content>`
- **Behavior:** Creates only if missing; existing file is no-op.
- **Idempotency:** Naturally idempotent.
- **Strict/ALLOW_NOOP:** No strict-fail branch here.
- **Example:** `CREATE_FILE | docs/note.txt | Hello`

#### `WRITE_FILE`
- **Syntax:** `WRITE_FILE | path | <content>`
- **Behavior:** Requires existing file; replaces whole content.
- **Errors:** `FILE_NOT_FOUND`.
- **Idempotency:** If content equal, no change.
- **Example:** `WRITE_FILE | config.ini | enabled=true`

#### `UPSERT_FILE`
- **Syntax:** `UPSERT_FILE | path | <content>`
- **Behavior:** Create if missing, overwrite if existing.
- **Idempotency:** No-op if content already equal.
- **Example:** `UPSERT_FILE | state/version.txt | 3`

#### `INSERT_BEFORE_REGEX`
- **Syntax:** `INSERT_BEFORE_REGEX | path | <regex> | <insert_text> | [ALLOW_NOOP=...]`
- **Behavior:** Inserts `<insert_text> + "\n"` before first match.
- **Errors:** `FILE_NOT_FOUND`, `REGEX_ERROR`, `REGEX_TIMEOUT`.
- **Strict:** If no match/no change and strict + not ALLOW_NOOP, emits `STRICT_FAIL_EXPECTED_CHANGE`.
- **Example:** `INSERT_BEFORE_REGEX | src/app.py | ^def main\( | # boot`

#### `INSERT_AFTER_REGEX`
- **Syntax:** `INSERT_AFTER_REGEX | path | <regex> | <insert_text> | [ALLOW_NOOP=...]`
- **Behavior:** Inserts `"\n" + <insert_text>` after first match.
- **Errors/Strict:** Same pattern as above.
- **Example:** `INSERT_AFTER_REGEX | src/app.py | ^import os$ | import re`

#### `REPLACE_REGEX`
- **Syntax:** `REPLACE_REGEX | path | <regex> | <replacement> | [ALLOW_NOOP=...]`
- **Behavior:** Regex replace all matches.
- **Errors:** `FILE_NOT_FOUND`, `REGEX_ERROR`, `REGEX_TIMEOUT`.
- **Strict:** no-change + strict + !ALLOW_NOOP => `STRICT_FAIL_EXPECTED_CHANGE`.
- **Example:** `REPLACE_REGEX | src/app.py | foo\(\) | bar()`

#### `REPLACE_REGEX_FIRST`
- **Syntax:** `REPLACE_REGEX_FIRST | path | <regex> | <replacement> | [ALLOW_NOOP=...]`
- **Behavior:** Regex replace first match only.
- **Strict/Errors:** same as `REPLACE_REGEX`.
- **Example:** `REPLACE_REGEX_FIRST | src/app.py | VERSION=\d+ | VERSION=2`

#### `DELETE_REGEX`
- **Syntax:** `DELETE_REGEX | path | <regex> | [ALLOW_NOOP=...]`
- **Behavior:** Removes all matches.
- **Strict/Errors:** same pattern (`REGEX_ERROR`, `REGEX_TIMEOUT`, strict no-change fail).
- **Example:** `DELETE_REGEX | src/app.py | #\s*DEBUG.*`

#### `REPLACE_BLOCK`
- **Syntax:** `REPLACE_BLOCK | path | <start_regex> | <end_regex> | <block_text> | [ALLOW_NOOP=...]`
- **Behavior:** Replaces region from first start match through first end match after it.
- **Errors:** `FILE_NOT_FOUND`, `INVALID_ARGS`, `REGEX_ERROR`, `REGEX_TIMEOUT`.
- **Strict:** unchanged block search result + strict + !ALLOW_NOOP => strict fail.
- **Example:** `REPLACE_BLOCK | README.md | ^BEGIN$ | ^END$ | New block`

#### `PATCH_REGEX` (alias command)
- **Syntax:** `PATCH_REGEX | path | ... | MODE=<replace|insert_before|insert_after|delete> | [FIRST=1]`
- **Behavior:** Canonicalized at runtime into:
  - `REPLACE_REGEX` / `REPLACE_REGEX_FIRST`
  - `INSERT_BEFORE_REGEX`
  - `INSERT_AFTER_REGEX`
  - `DELETE_REGEX`
- **Errors:** invalid mode/args generate `INVALID_ARGS ...` from canonicalization stage.
- **Example:** `PATCH_REGEX | src/a.py | foo | bar | MODE=replace | FIRST=1`

### File Operations

#### `DELETE_FILE`
- **Syntax:** `DELETE_FILE | path | [ALLOW_NOOP=0|1]`
- **Behavior:** Stages file deletion.
- **Errors:**
  - `DIRECTORY_NOT_SUPPORTED` for directories.
  - In strict mode, missing target + `ALLOW_NOOP` false => `STRICT_FAIL_EXPECTED_CHANGE`.
- **Idempotency:** Deleting already-missing file is a no-op unless strict policy forbids it.
- **Example:** `DELETE_FILE | tmp/out.txt | ALLOW_NOOP=1`

#### `MOVE_FILE`
- **Syntax:** `MOVE_FILE | src | dst | [OVERWRITE=0|1] | [ALLOW_NOOP=0|1]`
- **Behavior:**
  - Validates both source and destination paths.
  - Copies content into `dst` (staged) then deletes `src` (staged).
  - `src == dst` is treated as explicit no-op (no deletion).
- **Errors:** `FILE_NOT_FOUND`, `DIRECTORY_NOT_SUPPORTED`, `DESTINATION_IS_DIRECTORY`, `DESTINATION_EXISTS`.
- **Strict:** no effective change + strict + !ALLOW_NOOP => `STRICT_FAIL_EXPECTED_CHANGE`.
- **Overwrite:** required when destination exists and differs path.
- **Example:** `MOVE_FILE | src/a.txt | src/b.txt | OVERWRITE=1`

#### `COPY_FILE`
- **Syntax:** `COPY_FILE | src | dst | [OVERWRITE=0|1] | [ALLOW_NOOP=0|1]`
- **Behavior:**
  - Validates paths; copies source content to destination.
  - `src == dst` is explicit no-op.
- **Errors:** `FILE_NOT_FOUND`, `DIRECTORY_NOT_SUPPORTED`, `DESTINATION_IS_DIRECTORY`, `DESTINATION_EXISTS`.
- **Strict:** no-change + strict + !ALLOW_NOOP => strict fail.
- **Overwrite:** required if destination exists at different path.
- **Example:** `COPY_FILE | src/a.txt | src/copy.txt | OVERWRITE=1`

---

## 4. MULTILINE PAYLOAD RULES

### Heredoc
Use `<<TAG` (or `<<` defaulting to `EOF`):

```rw
CREATE_FILE | notes.txt | <<EOF
line 1
line 2
EOF
```

### Command-specific payload positions
- `CREATE_FILE`, `WRITE_FILE`, `UPSERT_FILE`: payload argument index `0`.
- `REPLACE_BLOCK`: payload argument index `2` (`start_re`, `end_re`, then block).

### Boundary detection (implicit multiline)
For multiline-capable ops, subsequent lines are consumed until the next line that matches `^\s*([A-Za-z_]+)\s*\|` **and** whose op is in `KNOWN_OPS`.

### Escaping rules
- `\|` keeps literal `|`.
- `\\` keeps literal `\`.

### Common mistakes
- Forgetting heredoc terminator (`EOF`) causes over-capture.
- Putting text that looks like `OP | ...` in implicit mode can prematurely end payload.
- Using multiline payload on ops outside `MULTILINE_OPS` has no special capture behavior.

---

## 5. EXECUTION MODES

### Plan Mode (`--plan`)
- Runs full parse/normalization/validation/operation simulation.
- Produces report/summary outputs.
- Does not write file mutations to project files.
- Useful for regression checking and strict/no-op policy verification.

### Apply Mode (`--apply`)
- Executes same pipeline logic.
- If there are no blocking errors and limits pass, commits staged changes to disk.
- Uses atomic temp+replace for writes.
- Can use backup/history and rollback-on-fail controls.

---

## 6. BACKUP + HISTORY SYSTEM

History activates when:
- `--backup` is true, and
- mode is apply (not plan).

### Key identifiers
- `run_id`: unique run stamp + random-hash suffix.
- `change_id`: deterministic hash of root/pipeline/strict/allowlist.
- `parent_run_id`: read from last `runs.jsonl` record if present.

### Storage layout
Under `data/history/runs/<yyyy>/<mm>/<dd>/<run_id>/`:
- `before/` pre-change backups (`*.bak`)
- `patches/` per-file unified diffs (`*.diff`)
- `artifacts/` (`sv-report.json`, `changes-summary.md`)
- `manifest.json`

### Indexes
- `data/history/index/runs.jsonl`
- `data/history/index/by-path.jsonl` (only when run status is `OK`)

### Rollback behavior
- `--rollback-on-fail` attempts restoration from `backup_paths` in reverse order.
- Restores overwritten files from backup and removes newly created files.

---

## 7. REPORT FORMAT EXPLANATION

Primary report object includes:
- Runtime flags (`plan_only`, `strict`, `backup`, limits, etc.)
- `pipeline.steps` snapshot
- `steps[]` with per-script and per-file operation tracking
- `errors[]`
- `rollback` status/details
- `scans[]` results (`SCAN_FILE`)
- `summary_path`, `duration_ms`
- `history` metadata

### Step/script/file entries
- Per script:
  - `files[]` entries with `changed`, `ops[]`, `diff`, byte/hash before/after, `is_new`, `is_deleted`.
- `ops[]` include command line/op/change and optional extras (e.g., destination path/hits).

### Diff representation
- Unified diff generated by `_diff_text` from disk-before vs staged-after.
- Also materialized to history `patches/*.diff` when history active.

### History metadata in report
When enabled, includes:
- `run_id`, `change_id`, run/manifest paths
- final `status` (`OK`, `FAILED_ROLLED_BACK`, `FAILED_NO_ROLLBACK`)
- artifact paths

---

## 8. SAFETY MODEL

### Path restrictions
- Rejects empty, absolute, and drive-qualified paths.
- Rejects traversal escaping project root via `commonpath` check.

### Allowlist
- Paths must match configured allow prefixes (`--allow`, repeatable).
- Default allowlist is `.` (entire root) when no `--allow` provided.

### Limits
- `--max-files`: maximum number of changed paths.
- `--max-total-write-bytes`: sum of final staged content bytes across changed files.

### Atomic guarantees
- Per-file atomic write via temp + `os.replace`.
- Mutations are staged first; commit happens only after all checks pass.

### Strict mode philosophy
- In strict mode, mutation commands that produce no effective change are failures unless `ALLOW_NOOP=1`.

---

## 9. IDMPOTENCY CONTRACT

(Idempotency contract section requested as “IDMPOTENCY”; kept here with corrected explanation.)

Idempotency in this runner means repeated execution of the same pipeline should converge to the same final state without unintended drift.

How it is implemented:
- Mutation staging compares old/new content before flagging changes.
- File create/upsert/replace operations avoid unnecessary writes when content unchanged.
- `MOVE_FILE`/`COPY_FILE` self-target (`src==dst`) are explicit no-ops.
- Strict mode forces explicit acknowledgement of expected no-op via `ALLOW_NOOP=1`.

When `ALLOW_NOOP` is needed:
- Any mutation expected to sometimes not change state (e.g., regex already applied, delete already absent, copy to same content) under `--strict`.

Best practice:
- Keep `--strict` enabled in CI-like validation.
- Add `ALLOW_NOOP=1` only where no-op is an expected steady-state outcome.

---

## 10. PIPELINE / SCRIPT ORGANIZATION

### Step structure
Each pipeline step is an object with:
- `name` (optional; auto-generated if missing)
- `scripts` (required; normalized to list of script paths)

### Script ordering
- Commands execute in source order.
- Scripts execute in listed order within a step.
- Steps execute in listed order.

### Recommended structuring patterns
- Keep scripts small and cohesive (one logical concern per script).
- Start with assertions to establish expected baseline.
- Follow with deterministic mutations.
- End with assertions to validate final state.

### Modular patch design
- Prefer multiple scripts across steps over one monolith for readability and safer rollback diagnosis.

---

## 11. COMMON FAILURE SCENARIOS

### 1) Self-target MOVE/COPY misuse
- **Symptom:** previously risked unintended behavior; now explicit no-op.
- **Fix:** still treat as logical no-op; add `ALLOW_NOOP=1` under strict if intentional.

### 2) Regex drift
- **Symptom:** no match -> strict failure (`STRICT_FAIL_EXPECTED_CHANGE`).
- **Fix:** harden patterns; add pre-assertions or `ALLOW_NOOP=1` where convergence is expected.

### 3) Missing `ALLOW_NOOP` in strict mode
- **Symptom:** stable reruns fail despite correct end-state.
- **Fix:** annotate expected-convergence operations with `ALLOW_NOOP=1`.

### 4) Allowlist violations
- **Symptom:** `PATH_NOT_ALLOWED_OR_UNSAFE`.
- **Fix:** correct target path or expand `--allow` policy intentionally.

### 5) Multiline boundary errors
- **Symptom:** payload captures too much/too little.
- **Fix:** prefer heredoc for large payloads; ensure terminator and avoid accidental command-like lines.

---

## 12. BEST PRACTICES

- Use `--plan` first for every new patch set.
- Use assertions defensively before/after mutation blocks.
- Keep regex patterns explicit and minimally ambiguous.
- Use `OVERWRITE=1` only when replacement is deliberate and reviewed.
- Keep strict mode on in automation; whitelist no-op intentionally with `ALLOW_NOOP=1`.
- Version patch sets in small, auditable scripts.

---

## 13. CONTRIBUTOR NOTES

### Extending DSL safely
- Add new op to `KNOWN_OPS` and `COMMAND_MIN_ARGS`.
- Extend parser/canonicalization only if needed.
- Keep dispatch changes localized and reuse existing VFS helpers.

### Backward compatibility
- Preserve legacy aliases handled by `_canonicalize_command`.
- Avoid changing parse semantics (`_split_rw_fields`, multiline boundaries) without explicit migration.

### Diff-safe patch philosophy
- Prefer minimal edits; avoid broad refactors in critical execution path.

### Architectural invariants to preserve
- Path safety + allowlist enforcement before execution.
- Stage-in-memory-first model.
- Limit checks before apply.
- Atomic per-file writes.
- Consistent report/error schema.

---


## Contract Validation Framework

A permanent contract suite is available under `tools/sv_patch/validation/`.

### Validation philosophy
- Behavioral contracts are defined in `.rw` scripts and orchestrated by `.pipeline.json` files.
- Validation executes both `--plan` and `--apply` for each pipeline.
- Baseline reports are compared to fresh reports to detect runtime drift.

### Single runtime source of truth
All contract runs invoke exactly:

`tools/sv_patch/sv_patch-(DeepSeekV1)_multiline_atomic_v3.py`

No alternate runner implementation is used for behavior validation.

### Run commands

```bash
python tools/sv_patch/validation/runner/run_validation.py
```

To refresh baselines:

```bash
python tools/sv_patch/validation/runner/run_validation.py --write-baseline
```

### Baseline enforcement
- Baselines live in `tools/sv_patch/validation/baselines/reports/`.
- Report comparison ignores dynamic metadata (`run_id`, timestamps, durations, artifact paths).
- Contract comparison validates behavioral outputs: errors, changed flags, operation records, and diffs.

## CLI QUICK REFERENCE

```bash
python tools/sv_patch/sv_patch-(DeepSeekV1)_multiline_atomic_v3.py \
  --root <repo_root> \
  --pipeline <pipeline.json> \
  --plan|--apply \
  --strict \
  --backup \
  --rollback-on-fail \
  --max-files 500 \
  --max-total-write-bytes 10000000 \
  --allow . \
  --report data/index/sv-report.json
```

- Exactly one of `--plan` / `--apply` must be set.
- `--workers` exists but is currently reserved.
