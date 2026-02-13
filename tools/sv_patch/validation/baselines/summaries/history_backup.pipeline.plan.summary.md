# Safe-Vibe Patch Summary

- Root: `/workspace/Project-Manager-SV-Patch`
- Plan only: `True`
- Strict: `True`
- Backup: `True`
- Rollback on fail: `True`
- Duration (ms): `2`

## Status: FAILED

## Errors

- `ASSERT_REGEX_FAILED`: tools/sv_patch/validation/artifacts/workspaces/history_backup/tmp/rollback.txt (history-backup-contract)

## Diffs

### tools/sv_patch/validation/artifacts/workspaces/history_backup/tmp/keep.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/history_backup/tmp/keep.txt
+++ tools/sv_patch/validation/artifacts/workspaces/history_backup/tmp/keep.txt
@@ -0,0 +1 @@
+keep-v2
```

### tools/sv_patch/validation/artifacts/workspaces/history_backup/tmp/rollback.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/history_backup/tmp/rollback.txt
+++ tools/sv_patch/validation/artifacts/workspaces/history_backup/tmp/rollback.txt
@@ -0,0 +1 @@
+changed-before-fail
```
