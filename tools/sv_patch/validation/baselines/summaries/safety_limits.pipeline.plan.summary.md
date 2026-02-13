# Safe-Vibe Patch Summary

- Root: `/workspace/Project-Manager-SV-Patch`
- Plan only: `True`
- Strict: `True`
- Backup: `False`
- Rollback on fail: `False`
- Duration (ms): `1`

## Status: FAILED

## Errors

- `PATH_NOT_ALLOWED_OR_UNSAFE`: ../outside.txt (safety-and-limit-contract)
- `PATH_NOT_ALLOWED_OR_UNSAFE`: tools/sv_patch/validation/artifacts/workspaces/safety_limits/denied/file.txt (safety-and-limit-contract)

## Diffs

### tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/a.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/a.txt
+++ tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/a.txt
@@ -0,0 +1 @@
+a
```

### tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/b.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/b.txt
+++ tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/b.txt
@@ -0,0 +1 @@
+b
```

### tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/bytes.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/bytes.txt
+++ tools/sv_patch/validation/artifacts/workspaces/safety_limits/tmp/bytes.txt
@@ -0,0 +1 @@
+1234567890ABCDEFGHIJ
```
