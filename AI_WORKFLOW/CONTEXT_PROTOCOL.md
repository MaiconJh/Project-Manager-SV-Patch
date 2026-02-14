# Context Protocol

Purpose: maintain lightweight semantic memory across sessions.

## Required Anchor Header

All future file modifications should include this minimal header at the top of modified files:

```text
@context:
@scope:
@affects:
@mode:
@note:
```

## Anchor Rules

- Keep entries short and semantic.
- Use keywords, not prose.
- Describe only the most recent change block in the file.
- Do not add long changelog text in anchors.
- Preserve existing anchors; only extend when needed.

## Pre-Operation Procedure (Mandatory)

Before implementing changes:

1. Read `AI_WORKFLOW/CONTEXT_INDEX.md`.
2. Read this protocol file.
3. Search repository for existing `@context:` anchors.
4. Reuse existing context identifiers when change overlaps.
5. Add new identifier only when feature is truly unrelated.

## Context Continuity Rules

- If affected area already has context: extend semantically.
- Avoid redundant context IDs.
- Keep architectural continuity across sessions.

## Safety Rules

- Do not remove existing `@context` anchors.
- Do not rewrite historical context intent.
- Only append or minimally extend context registry.
- Keep changes diff-safe.

## Example

```text
@context: export-profile
@scope: core
@affects: buildExportModel
@mode: profile-driven
@note: canonical export profile introduced
```
