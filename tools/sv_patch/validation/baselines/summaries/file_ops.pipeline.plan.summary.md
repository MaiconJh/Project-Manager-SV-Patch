# Safe-Vibe Patch Summary

- Root: `/workspace/Project-Manager-SV-Patch`
- Plan only: `True`
- Strict: `False`
- Backup: `False`
- Rollback on fail: `False`
- Duration (ms): `2`

## Status: OK

## Diffs

### tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/self.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/self.txt
+++ tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/self.txt
@@ -0,0 +1 @@
+stable-content
```

### tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/source.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/source.txt
+++ tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/source.txt
@@ -0,0 +1 @@
+payload-v2
```

### tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/dest.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/dest.txt
+++ tools/sv_patch/validation/artifacts/workspaces/file_ops/tmp/dest.txt
@@ -0,0 +1 @@
+payload-v2
```
