# Export Schema v1 (Canonical JSON Contract)

This document defines the canonical export JSON contract for Project Manager & SV Patch.

## Contract Identity

- `schema_version`: **"1.0"** (contract-level string identifier)
- `report_type`: **"project-export"** (contract-level string identifier)

> Implementation compatibility note: runtime currently emits numeric `schema_version: 1` and `report_type: "project_report"` for backward compatibility; validator accepts that runtime identity while enforcing all structural/conditional rules below.

## Required Top-Level Fields

Required keys:

- `schema_version`
- `report_type`
- `project` (object)
- `export` (object)
- `files` (array)
- `index.by_path` (object map)

### `project` object

- `project.path` (string absolute path)
- `project.generated_at` (string timestamp)
- `project.generator` (string)
- `project.app_version` (string or null)

### `export` object

- `export.mode` (`"all" | "selected"`)
- `export.profile` object with:
  - `format` (`"txt" | "json"`)
  - `scope` (`"all" | "selected"`)
  - `content_level` (`"compact" | "full"`)
  - `include_tree` (boolean)
  - `include_hashes` (boolean)
  - `include_ignored_summary` (boolean)
  - `sort_mode` (`"alpha" | "dir_first_alpha"`)
- `export.filters.ignored_exts` (array)
- `export.filters.ignored_paths` (array) **only when** `include_ignored_summary=true`

## Conditional Omission Rules

1. If `export.profile.include_tree === false`:
   - top-level `tree` key MUST be omitted.
   - tree build work MUST be skipped.

2. If `export.profile.include_ignored_summary === false`:
   - `export.filters.ignored_paths` MUST be omitted entirely.

3. If `export.profile.include_hashes === false`:
   - no file entry may carry a real SHA-256 string.
   - null/undefined/omitted are allowed.

4. If `export.profile.content_level === "compact"`:
   - file entries MUST NOT include heavy fields:
     - `content`
     - `encoding`
     - `line_count`

## Determinism Requirements

- `files[]` ordering must be stable (path-sorted).
- `index.by_path` must include every exported `files[i].path`.
- When tree exists, tree sorting must obey `export.profile.sort_mode`.

## VALID Example (compact, no tree, no ignored summary)

```json
{
  "schema_version": "1.0",
  "report_type": "project-export",
  "project": { "path": "/repo", "generated_at": "2026-02-14T00:00:00.000Z", "generator": "Project Manager & SV Patch", "app_version": null },
  "export": {
    "mode": "all",
    "profile": { "format": "json", "scope": "all", "content_level": "compact", "include_tree": false, "include_hashes": false, "include_ignored_summary": false, "sort_mode": "alpha" },
    "selected_count": 0,
    "exported_files_count": 1,
    "filters": { "ignored_exts": [".png"] }
  },
  "files": [{ "path": "a.txt", "ext": ".txt", "size_bytes": 2, "mtime_ms": 1, "sha256": null, "content_error": null }],
  "index": { "by_path": { "a.txt": 0 } }
}
```

## VALID Example (full, tree, hashes, ignored summary)

```json
{
  "schema_version": "1.0",
  "report_type": "project-export",
  "project": { "path": "/repo", "generated_at": "2026-02-14T00:00:00.000Z", "generator": "Project Manager & SV Patch", "app_version": null },
  "export": {
    "mode": "selected",
    "profile": { "format": "txt", "scope": "selected", "content_level": "full", "include_tree": true, "include_hashes": true, "include_ignored_summary": true, "sort_mode": "dir_first_alpha" },
    "selected_count": 2,
    "exported_files_count": 1,
    "filters": { "ignored_exts": [".png"], "ignored_paths": ["tmp/cache.txt"] }
  },
  "tree": { "type": "dir", "name": ".", "path": "", "children": [{ "type": "file", "name": "a.txt", "path": "a.txt", "file_index": 0 }] },
  "files": [{ "path": "a.txt", "ext": ".txt", "size_bytes": 2, "mtime_ms": 1, "encoding": "utf-8", "line_count": 1, "sha256": "abc", "content": "hi", "content_error": null }],
  "index": { "by_path": { "a.txt": 0 } }
}
```

## INVALID Example 1 (tree present while include_tree=false)

```json
{
  "export": { "profile": { "include_tree": false } },
  "tree": { "type": "dir", "name": ".", "path": "", "children": [] }
}
```

## INVALID Example 2 (ignored_paths present while include_ignored_summary=false)

```json
{
  "export": {
    "profile": { "include_ignored_summary": false },
    "filters": { "ignored_exts": [], "ignored_paths": ["x"] }
  }
}
```
