# Safe-Vibe Patch Summary

- Root: `/workspace/Project-Manager-SV-Patch`
- Plan only: `False`
- Strict: `True`
- Backup: `False`
- Rollback on fail: `False`
- Duration (ms): `1`

## Status: FAILED

## Errors

- `STRICT_FAIL_EXPECTED_CHANGE`: tools/sv_patch/validation/artifacts/workspaces/execution_modes/tmp/strict.txt (execution-modes-contract)

## Diffs

### tools/sv_patch/validation/artifacts/workspaces/execution_modes/tmp/plan_apply.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/execution_modes/tmp/plan_apply.txt
+++ tools/sv_patch/validation/artifacts/workspaces/execution_modes/tmp/plan_apply.txt
@@ -0,0 +1 @@
+from-pipeline
```

### tools/sv_patch/validation/artifacts/workspaces/execution_modes/tmp/strict.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/execution_modes/tmp/strict.txt
+++ tools/sv_patch/validation/artifacts/workspaces/execution_modes/tmp/strict.txt
@@ -0,0 +1 @@
+fixed
```
