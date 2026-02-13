# Safe-Vibe Patch Summary

- Root: `/workspace/Project-Manager-SV-Patch`
- Plan only: `False`
- Strict: `False`
- Backup: `False`
- Rollback on fail: `False`
- Duration (ms): `2`

## Status: OK

## Diffs

### tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/heredoc.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/heredoc.txt
+++ tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/heredoc.txt
@@ -0,0 +1,2 @@
+line-a

+line-b
```

### tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/heredoc.txt 

```diff
--- tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/heredoc.txt
+++ tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/heredoc.txt
@@ -0,0 +1,3 @@
+top

+middle

+bottom
```

### tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/block_payload.txt (NEW)

```diff
--- tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/block_payload.txt
+++ tools/sv_patch/validation/artifacts/workspaces/multiline/tmp/block_payload.txt
@@ -0,0 +1,4 @@
+AA

+new-1

+new-2

+ZZ
```
