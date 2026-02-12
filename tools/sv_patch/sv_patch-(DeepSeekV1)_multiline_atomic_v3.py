#!/usr/bin/env python3
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import sys
import time
import warnings
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from functools import wraps

# Detectar se estamos no Windows (onde signal.SIGALRM não está disponível)
IS_WINDOWS = sys.platform == "win32"

if not IS_WINDOWS:
    import signal

###############################################################################
# Utils
###############################################################################

class TimeoutException(Exception):
    pass

def timeout(seconds: int = 5):
    """Decorator para timeout em operações regex intensivas - multiplataforma"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if IS_WINDOWS:
                # Windows não suporta signal.SIGALRM
                # Em vez de timeout, confiamos que regex não será complexo demais
                return func(*args, **kwargs)
            else:
                # Unix: usa signal para timeout
                def timeout_handler(signum, frame):
                    raise TimeoutException(f"Operation timed out after {seconds} seconds")
                
                old_handler = signal.signal(signal.SIGALRM, timeout_handler)
                signal.alarm(seconds)
                
                try:
                    result = func(*args, **kwargs)
                finally:
                    signal.alarm(0)
                    signal.signal(signal.SIGALRM, old_handler)
                return result
        return wrapper
    return decorator

def normalize_newlines(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\r", "\n")

def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)

def sha256_text(text: str) -> str:
    return hashlib.sha256(normalize_newlines(text).encode("utf-8")).hexdigest()

def sha256_file(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()

def rel_norm(path: str) -> str:
    """Normalize relative paths to use forward slashes. Empty stays empty (avoids "." bugs)."""
    if path is None:
        return ""
    s = str(path).strip()
    if not s:
        return ""
    return os.path.normpath(s).replace("\\", "/")

def is_path_safe(rel_path: str, root_abs: str) -> bool:
    """Verifica se o caminho não tenta escapar do root (path traversal)"""
    if not rel_path:
        return False
    
    norm_path = os.path.normpath(rel_path)
    
    if ".." in norm_path.split(os.sep):
        abs_path = os.path.abspath(os.path.join(root_abs, norm_path))
        return abs_path.startswith(root_abs)
    
    return True

def is_path_allowed(rel_path: str, allow_prefixes: List[str], root_abs: str) -> bool:
    """Verifica se o caminho está na allowlist E é seguro"""
    if not is_path_safe(rel_path, root_abs):
        return False
    
    rel_path = rel_norm(rel_path)
    for p in allow_prefixes:
        p = rel_norm(p)
        if p == "." or p == "":
            return True
        if rel_path == p:
            return True
        if rel_path.startswith(p.rstrip("/") + "/"):
            return True
    return False

###############################################################################
# DSL Parsing
###############################################################################

@dataclass
class RWCommand:
    op: str
    file: str
    args: List[str]
    opts: Dict[str, str]
    raw: str
    line_no: int

def parse_rw_line(line: str) -> Optional[Tuple[str, str, List[str], Dict[str, str]]]:
    """
    Legacy single-line parser:
      OP | file | arg1 | key=value | ...
    Lines without at least 'OP|file' are ignored.
    """
    line = line.strip()
    if not line or line.startswith("#"):
        return None

    parts = [p.strip() for p in line.split("|")]
    if len(parts) < 2:
        return None

    op = parts[0].strip()
    file = parts[1].strip()
    rest = parts[2:]

    args: List[str] = []
    opts: Dict[str, str] = {}
    for item in rest:
        # Treat as option only if it looks like key=value with no spaces in the key part.
        # This prevents JS like 'const x = 1' from being mis-parsed as an option.
        if re.match(r"^[A-Za-z_][A-Za-z0-9_-]*\s*=", item) and " " not in item.split("=", 1)[0] and not (item.startswith('"') and item.endswith('"')):
            k, v = item.split("=", 1)
            opts[k.strip()] = v.strip()
        else:
            args.append(item)

    return op, file, args, opts


# Ops that may carry a multiline payload as their first arg
MULTILINE_OPS = {
    "CREATE_FILE",
    "REPLACE_BLOCK",
}

# Known ops for detecting the next command line
KNOWN_OPS = {
    "CREATE_FILE",
    "ASSERT_FILE_EXISTS",
    "ASSERT_FILE_NOT_EXISTS",
    "ASSERT_REGEX",
    "INSERT_AFTER_REGEX",
    "INSERT_BEFORE_REGEX",
    "REPLACE_REGEX",
    "DELETE_REGEX",
    "SCAN_FILE",
}

_cmd_line_re = re.compile(r"^\s*([A-Z_]+)\s*\|")

def _is_command_line(line: str) -> bool:
    m = _cmd_line_re.match(line)
    if not m:
        return False
    return m.group(1) in KNOWN_OPS


def load_changes(root_abs: str, rw_path: str) -> List[RWCommand]:
    """
    Backward-compatible RW loader:
    - Supports legacy single-line commands.
    - Adds multiline payload support for ops in MULTILINE_OPS:
        CREATE_FILE | path | <payload...>
      Payload may continue on subsequent lines until the next command line.
    - Adds explicit heredoc:
        CREATE_FILE | path | <<EOF
        ...payload...
        EOF
    """
    abs_path = rw_path if os.path.isabs(rw_path) else os.path.join(root_abs, rw_path)
    text = read_text(abs_path)
    lines = normalize_newlines(text).split("\n")

    cmds: List[RWCommand] = []
    i = 0
    while i < len(lines):
        raw = lines[i]
        parsed = parse_rw_line(raw)
        if not parsed:
            i += 1
            continue

        op, file, args, opts = parsed
        line_no = i + 1

        # If file is empty, skip safely (prevents rel_norm('') -> '.')
        if not str(file).strip():
            i += 1
            continue

        # Multiline payload support (first arg)
        if op in MULTILINE_OPS and args:
            first = args[0].strip()

            # Heredoc: <<TAG (default EOF)
            if first.startswith("<<"):
                tag = first[2:].strip() or "EOF"
                payload_lines = []
                i += 1
                while i < len(lines) and lines[i].strip() != tag:
                    payload_lines.append(lines[i])
                    i += 1
                if i < len(lines) and lines[i].strip() == tag:
                    i += 1
                payload = "\n".join(payload_lines)
                args = [payload] + args[1:]
                cmds.append(RWCommand(op=op, file=file, args=args, opts=opts, raw=raw, line_no=line_no))
                continue

            # Implicit multiline: capture following non-command lines
            payload_lines = []
            j = i + 1
            while j < len(lines) and not _is_command_line(lines[j]):
                payload_lines.append(lines[j])
                j += 1

            if payload_lines:
                payload = (args[0] if args else "") + "\n" + "\n".join(payload_lines)
                args = [payload] + args[1:]
                cmds.append(RWCommand(op=op, file=file, args=args, opts=opts, raw=raw, line_no=line_no))
                i = j
                continue

        cmds.append(RWCommand(op=op, file=file, args=args, opts=opts, raw=raw, line_no=line_no))
        i += 1

    return cmds


###############################################################################
# Pipeline Loading (FIXED)
###############################################################################

def _normalize_scripts_field(scripts_field) -> List[str]:
    if scripts_field is None:
        return []

    if isinstance(scripts_field, str):
        s = scripts_field.strip()
        return [s] if s else []

    if isinstance(scripts_field, dict):
        s = scripts_field.get("script")
        if isinstance(s, str) and s.strip():
            return [s.strip()]
        return []

    if isinstance(scripts_field, list):
        out: List[str] = []
        for item in scripts_field:
            if isinstance(item, str):
                s = item.strip()
                if s:
                    out.append(s)
            elif isinstance(item, dict):
                s = item.get("script")
                if isinstance(s, str) and s.strip():
                    out.append(s.strip())
            else:
                continue
        return out

    return []

def load_pipeline(root: str, pipeline_path: str, *, debug_pipeline: bool = False, verbose: bool = False) -> dict:
    abs_path = pipeline_path if os.path.isabs(pipeline_path) else os.path.join(root, pipeline_path)
    if verbose:
        print(f"[VERBOSE] Carregando pipeline de: {abs_path}")
    
    text = read_text(abs_path)
    data = json.loads(text)

    if "steps" not in data or not isinstance(data["steps"], list) or not data["steps"]:
        raise ValueError("PIPELINE_INVALID steps[] é obrigatório")

    normalized_steps: List[dict] = []
    for i, step in enumerate(data["steps"], start=1):
        if not isinstance(step, dict):
            raise ValueError(f"PIPELINE_INVALID step[{i}] deve ser um objeto")
        name = step.get("name") or f"step-{i}"

        scripts_norm = _normalize_scripts_field(step.get("scripts"))
        if not scripts_norm:
            raise ValueError(f"PIPELINE_INVALID step '{name}' scripts[] é obrigatório (não-vazio)")

        normalized_steps.append({
            "name": str(name),
            "scripts": scripts_norm,
        })

    out = dict(data)
    out["steps"] = normalized_steps

    if debug_pipeline:
        meta = {
            "pipeline_abs_path": os.path.abspath(abs_path),
            "pipeline_bytes": len(text.encode("utf-8")),
            "pipeline_sha256": hashlib.sha256(normalize_newlines(text).encode("utf-8")).hexdigest(),
            "steps": [{"name": s["name"], "scripts_count": len(s["scripts"])} for s in normalized_steps],
        }
        print("[PIPELINE_DEBUG]", json.dumps(meta, indent=2, ensure_ascii=False))

    return out

###############################################################################
# Engine com timeout para regex (multiplataforma)
###############################################################################

def _opt_bool(opts: Dict[str, str], key: str, default: bool = False) -> bool:
    v = opts.get(key)
    if v is None:
        return default
    v = v.strip().lower()
    return v in ("1", "true", "yes", "y", "on")

def _opt_int(opts: Dict[str, str], key: str, default: int) -> int:
    v = opts.get(key)
    if v is None:
        return default
    try:
        return int(v)
    except Exception:
        return default

def _json_unquote(s: str) -> str:
    s = s.strip()
    if not (s.startswith('"') and s.endswith('"')):
        return s
    return json.loads(s)

def _normalize_regex_pattern(p: str) -> str:
    """
    Normaliza padrão regex.
    IMPORTANTE: Todas as operações regex usam flags:
      - re.MULTILINE: ^ e $ funcionam no início/fim de cada linha
      - re.DOTALL: . não inclui newline por padrão (use [\\s\\S] para qualquer char)
    """
    p = p.strip()
    # Valida o regex tentando compilá-lo
    try:
        re.compile(p, flags=re.MULTILINE)
    except re.error as e:
        raise ValueError(f"Regex inválido: {e}")
    return p

@timeout(seconds=10)
def _safe_regex_search(pattern: str, text: str):
    return re.search(_normalize_regex_pattern(pattern), text, flags=re.MULTILINE)

@timeout(seconds=10)
def _safe_regex_sub(pattern: str, repl: str, text: str, count: int = 0):
    return re.subn(_normalize_regex_pattern(pattern), repl, text, count=count, flags=re.MULTILINE)

@timeout(seconds=10)
def _safe_regex_finditer(pattern: str, text: str):
    return list(re.finditer(_normalize_regex_pattern(pattern), text, flags=re.MULTILINE))

def _diff_text(old: str, new: str, file_label: str) -> str:
    old_lines = normalize_newlines(old).splitlines(True)
    new_lines = normalize_newlines(new).splitlines(True)
    d = difflib.unified_diff(old_lines, new_lines, fromfile=file_label, tofile=file_label, lineterm="")
    return "\n".join(d) + ("\n" if old_lines or new_lines else "")

def _apply_replace_block(text: str, start_re: str, end_re: str, block_text: str) -> Tuple[str, int]:
    try:
        start_re = _normalize_regex_pattern(start_re)
        end_re = _normalize_regex_pattern(end_re)
    except ValueError as e:
        # Regex inválido, tratar como erro
        raise e

    try:
        m1 = _safe_regex_search(start_re, text)
    except TimeoutException:
        return text, -1

    if not m1:
        return text, 0

    try:
        m2 = _safe_regex_search(end_re, text[m1.end():])
    except TimeoutException:
        return text, -1

    if not m2:
        return text, 0

    a = m1.start()
    b = m1.end() + m2.end()
    new_text = text[:a] + block_text + text[b:]
    if new_text == text:
        return text, 0
    return new_text, 1

def _apply_insert_before_regex(text: str, regex: str, insert_line: str) -> Tuple[str, int]:
    try:
        regex = _normalize_regex_pattern(regex)
    except ValueError as e:
        raise e
    
    try:
        m = _safe_regex_search(regex, text)
    except TimeoutException:
        return text, -1

    if not m:
        return text, 0
    idx = m.start()
    new_text = text[:idx] + insert_line + "\n" + text[idx:]
    if new_text == text:
        return text, 0
    return new_text, 1

def _apply_insert_after_regex(text: str, regex: str, insert_line: str) -> Tuple[str, int]:
    try:
        regex = _normalize_regex_pattern(regex)
    except ValueError as e:
        raise e
    
    try:
        m = _safe_regex_search(regex, text)
    except TimeoutException:
        return text, -1

    if not m:
        return text, 0
    idx = m.end()
    new_text = text[:idx] + "\n" + insert_line + text[idx:]
    if new_text == text:
        return text, 0
    return new_text, 1

def _apply_replace_regex(text: str, regex: str, repl: str, first_only: bool) -> Tuple[str, int]:
    try:
        regex = _normalize_regex_pattern(regex)
    except ValueError as e:
        raise e
    
    count = 1 if first_only else 0
    try:
        new_text, n = _safe_regex_sub(regex, repl, text, count)
    except TimeoutException:
        return text, -1
    
    if new_text == text:
        return text, 0
    return new_text, 1 if n > 0 else 0

def _apply_delete_regex(text: str, regex: str) -> Tuple[str, int]:
    try:
        regex = _normalize_regex_pattern(regex)
    except ValueError as e:
        raise e
    
    try:
        new_text, n = _safe_regex_sub(regex, "", text)
    except TimeoutException:
        return text, -1
    
    if new_text == text:
        return text, 0
    return new_text, 1 if n > 0 else 0

def _scan_file(text: str, regex: str, max_hits: int, context: int) -> List[dict]:
    try:
        regex = _normalize_regex_pattern(regex)
    except ValueError:
        return []  # Regex inválido, retorna vazio
    
    hits = []
    try:
        matches = _safe_regex_finditer(regex, text)
    except TimeoutException:
        return []
    
    for m in matches:
        start = m.start()
        line_no = text.count("\n", 0, start) + 1
        line_start = text.rfind("\n", 0, start) + 1
        col = start - line_start + 1

        lines = normalize_newlines(text).splitlines()
        idx0 = line_no - 1
        before = lines[max(0, idx0 - context):idx0]
        line = lines[idx0] if 0 <= idx0 < len(lines) else ""
        after = lines[idx0 + 1: idx0 + 1 + context]

        hits.append({
            "line": line_no,
            "col": col,
            "match": m.group(0),
            "context_before": before,
            "context_line": line,
            "context_after": after,
        })
        if len(hits) >= max_hits:
            break
    return hits

###############################################################################
# Runner
###############################################################################

def run_pipeline(
    root_abs: str,
    pipeline: dict,
    plan_only: bool,
    strict: bool,
    backup: bool,
    rollback_on_fail: bool,
    allow_prefixes: List[str],
    max_files: int,
    max_total_write_bytes: int,
    workers: int,
    verbose: bool = False,
) -> dict:
    t0 = time.time()

    report: dict = {
        "root": root_abs,
        "plan_only": plan_only,
        "strict": strict,
        "backup": backup,
        "rollback_on_fail": rollback_on_fail,
        "workers": workers,
        "limits": {
            "max_files": max_files,
            "max_total_write_bytes": max_total_write_bytes,
            "allowlist_prefixes": allow_prefixes,
        },
        "steps": [],
        "errors": [],
        "rollback": None,
        "rejects": [],
        "scans": [],
        "summary_path": None,
        "duration_ms": None,
    }

    report["pipeline"] = {
        "steps": [{"name": s.get("name"), "scripts": list(s.get("scripts", []))} for s in pipeline.get("steps", [])]
    }

    vfs: Dict[str, str] = {}
    changed_files: Dict[str, dict] = {}
    wrote_bytes_total = 0
    touched = 0

    backup_paths: List[Tuple[str, str, bool]] = []
    new_files: List[str] = []

    def _get_file_text(rel_path: str) -> Optional[str]:
        rel_path = rel_norm(rel_path)
        if rel_path in vfs:
            return vfs[rel_path]
        abs_path = os.path.join(root_abs, rel_path)
        if not os.path.exists(abs_path):
            return None
        return read_text(abs_path)

    def _set_file_text(rel_path: str, text: str, is_new: bool = False) -> None:
        nonlocal wrote_bytes_total, touched
        rel_path = rel_norm(rel_path)
        old = _get_file_text(rel_path)
        if old is None:
            old = ""
            if is_new:
                new_files.append(rel_path)
        
        if old == text:
            vfs[rel_path] = text
            return
        
        vfs[rel_path] = text
        abs_path = os.path.join(root_abs, rel_path)
        changed_files.setdefault(rel_path, {
            "file": rel_path,
            "bytes_before": len(old.encode("utf-8")),
            "sha256_before": sha256_text(old) if old else None,
            "is_new": is_new,
        })
        changed_files[rel_path].update({
            "bytes_after": len(text.encode("utf-8")),
            "sha256_after": sha256_text(text),
        })
        touched += 1

    def _write_file(rel_path: str, text: str, is_new: bool = False) -> None:
        # NOTE: wrote_bytes_total is accounted in _set_file_text (delta before/after).
        rel_path = rel_norm(rel_path)
        if not rel_path:
            return
        abs_path = os.path.join(root_abs, rel_path)
        os.makedirs(os.path.dirname(abs_path) or ".", exist_ok=True)

        # Backup (legacy behavior)
        if backup and os.path.exists(abs_path) and not is_new:
            bak = abs_path + ".bak"
            write_text(bak, read_text(abs_path))
            backup_paths.append((abs_path, bak, False))
            if verbose:
                print(f"[VERBOSE] Backup criado: {bak}")

        # Atomic write: write to temp then replace
        tmp_path = f"{abs_path}.svtmp.{os.getpid()}.{int(time.time()*1000)}"
        with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp_path, abs_path)

        if is_new:
            backup_paths.append((abs_path, None, True))
            if verbose:
                print(f"[VERBOSE] Arquivo criado: {abs_path}")

    def _rollback() -> dict:
        rb = {"attempted": True, "files_restored": [], "files_removed": []}
        for orig, bak, is_new in reversed(backup_paths):
            try:
                if is_new:
                    if os.path.exists(orig):
                        os.remove(orig)
                        rb["files_removed"].append(rel_norm(orig))
                        if verbose:
                            print(f"[VERBOSE] Rollback: removido arquivo novo {orig}")
                elif bak and os.path.exists(bak):
                    write_text(orig, read_text(bak))
                    rb["files_restored"].append(rel_norm(orig))
                    if verbose:
                        print(f"[VERBOSE] Rollback: restaurado {orig} de {bak}")
            except Exception as e:
                if verbose:
                    print(f"[VERBOSE] Rollback error em {orig}: {e}")
                continue
        return rb

    steps = pipeline.get("steps", [])
    for step in steps:
        step_name = step.get("name", "unnamed-step")
        scripts = step.get("scripts", [])
        if not isinstance(scripts, list) or not scripts:
            step_entry = {"name": step_name, "scripts": [], "status": "FAILED"}
            report["steps"].append(step_entry)
            report["errors"].append({"step": step_name, "error": "STEP_INVALID scripts[] required (non-empty)"})
            break

        step_entry = {"name": step_name, "scripts": [], "status": "OK"}
        report["steps"].append(step_entry)
        step_errors: List[dict] = []

        for sp in scripts:
            if not isinstance(sp, str) or not sp.strip():
                step_errors.append({"step": step_name, "error": "PIPELINE_INVALID_SCRIPT_ENTRY", "script": sp})
                break
            sp = sp.strip()
            
            sp_abs = sp if os.path.isabs(sp) else os.path.join(root_abs, sp)
            if not os.path.exists(sp_abs):
                step_errors.append({"step": step_name, "script": sp, "error": "SCRIPT_NOT_FOUND", "path": sp_abs})
                break

            cmds = load_changes(root_abs, sp)

            script_entry = {"script": sp, "files": [], "errors": []}
            step_entry["scripts"].append(script_entry)

            per_file_ops: Dict[str, dict] = {}

            for cmd in cmds:
                rel_file = rel_norm(cmd.file)

                if not is_path_allowed(rel_file, allow_prefixes, root_abs):
                    err = {
                        "step": step_name,
                        "script": sp,
                        "file": rel_file,
                        "line": cmd.line_no,
                        "op": cmd.op,
                        "error": "PATH_NOT_ALLOWED_OR_UNSAFE",
                        "raw": cmd.raw,
                    }
                    script_entry["errors"].append(err)
                    step_errors.append(err)
                    continue

                per_file_ops.setdefault(rel_file, {
                    "file": rel_file,
                    "changed": False,
                    "ops": [],
                    "diff": None,
                    "bytes_before": None,
                    "bytes_after": None,
                    "sha256_before": None,
                    "sha256_after": None,
                    "is_new": False,
                })
                file_entry = per_file_ops[rel_file]

                abs_path = os.path.join(root_abs, rel_file)
                file_exists = os.path.exists(abs_path)
                is_dir = os.path.isdir(abs_path)
                cur_text = None if is_dir else _get_file_text(rel_file)

                def op_record(changed: int, **extra):
                    rec = {"line": cmd.line_no, "op": cmd.op, "changed": changed}
                    rec.update(extra)
                    file_entry["ops"].append(rec)

                if cmd.op == "ASSERT_FILE_EXISTS":
                    ok = file_exists or (rel_file in vfs)
                    if not ok:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "ASSERT_FILE_EXISTS_FAILED",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    op_record(0)
                    continue

                if cmd.op == "ASSERT_FILE_NOT_EXISTS":
                    ok = (not file_exists) and (rel_file not in vfs)
                    if not ok:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "ASSERT_FILE_NOT_EXISTS_FAILED",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    op_record(0)
                    continue

                if cmd.op == "SCAN_FILE":
                    if cur_text is None:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "FILE_NOT_FOUND",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    regex = cmd.args[0] if cmd.args else ""
                    max_hits = _opt_int(cmd.opts, "MAX", 20)
                    ctx = _opt_int(cmd.opts, "CONTEXT", 2)
                    try:
                        hits = _scan_file(cur_text, regex, max_hits, ctx)
                    except ValueError as e:
                        # Regex inválido
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    report["scans"].append({
                        "file": rel_file,
                        "line": cmd.line_no,
                        "regex": regex,
                        "max": max_hits,
                        "context": ctx,
                        "hits": hits,
                    })
                    op_record(0, hits=len(hits))
                    continue

                if cmd.op == "ASSERT_REGEX":
                    if cur_text is None:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "FILE_NOT_FOUND",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    regex = cmd.args[0] if cmd.args else ""
                    try:
                        found = _safe_regex_search(_normalize_regex_pattern(regex), cur_text) is not None
                    except TimeoutException:
                        found = False
                        if verbose:
                            print(f"[VERBOSE] Regex timeout em {rel_file}: {regex[:50]}...")
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if not found:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "ASSERT_REGEX_FAILED",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    op_record(0)
                    continue

                if cmd.op == "ASSERT_NOT_REGEX":
                    if cur_text is None:
                        op_record(0)
                        continue
                    regex = cmd.args[0] if cmd.args else ""
                    try:
                        found = _safe_regex_search(_normalize_regex_pattern(regex), cur_text) is not None
                    except TimeoutException:
                        found = False
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if found:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "ASSERT_NOT_REGEX_FAILED",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    op_record(0)
                    continue

                if cmd.op == "ASSERT_REGEX_COUNT":
                    if cur_text is None:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "FILE_NOT_FOUND",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    regex = cmd.args[0] if len(cmd.args) >= 1 else ""
                    expected = int(cmd.args[1]) if len(cmd.args) >= 2 else 0
                    try:
                        matches = _safe_regex_finditer(_normalize_regex_pattern(regex), cur_text)
                        found = len(matches)
                    except TimeoutException:
                        found = 0
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if found != expected:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"ASSERT_REGEX_COUNT_FAILED expected={expected} found={found}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    op_record(0, found=found)
                    continue

                if cmd.op == "CREATE_FILE":
                    content = _json_unquote(cmd.args[0]) if cmd.args else ""
                    if cur_text is None:
                        _set_file_text(rel_file, content, is_new=True)
                        file_entry["changed"] = True
                        file_entry["is_new"] = True
                        op_record(1)
                    else:
                        op_record(0)
                    continue

                if cur_text is None:
                    err = {
                        "step": step_name,
                        "script": sp,
                        "file": rel_file,
                        "line": cmd.line_no,
                        "op": cmd.op,
                        "error": "FILE_NOT_FOUND",
                        "raw": cmd.raw,
                    }
                    script_entry["errors"].append(err)
                    step_errors.append(err)
                    op_record(0)
                    continue

                allow_noop = _opt_bool(cmd.opts, "ALLOW_NOOP", False)

                if cmd.op == "INSERT_BEFORE_REGEX":
                    regex = cmd.args[0] if len(cmd.args) >= 1 else ""
                    insert_line = cmd.args[1] if len(cmd.args) >= 2 else ""
                    try:
                        new_text, changed = _apply_insert_before_regex(cur_text, regex, insert_line)
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if changed == -1:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "REGEX_TIMEOUT",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if strict and changed == 0 and not allow_noop:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "STRICT_FAIL_EXPECTED_CHANGE",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if changed == 1:
                        _set_file_text(rel_file, new_text)
                        file_entry["changed"] = True
                    
                    op_record(changed)
                    continue

                if cmd.op == "INSERT_AFTER_REGEX":
                    regex = cmd.args[0] if len(cmd.args) >= 1 else ""
                    insert_line = cmd.args[1] if len(cmd.args) >= 2 else ""
                    try:
                        new_text, changed = _apply_insert_after_regex(cur_text, regex, insert_line)
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if changed == -1:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "REGEX_TIMEOUT",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if strict and changed == 0 and not allow_noop:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "STRICT_FAIL_EXPECTED_CHANGE",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if changed == 1:
                        _set_file_text(rel_file, new_text)
                        file_entry["changed"] = True
                    
                    op_record(changed)
                    continue

                if cmd.op == "REPLACE_REGEX":
                    regex = cmd.args[0] if len(cmd.args) >= 1 else ""
                    repl = cmd.args[1] if len(cmd.args) >= 2 else ""
                    try:
                        new_text, changed = _apply_replace_regex(cur_text, regex, repl, first_only=False)
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if changed == -1:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "REGEX_TIMEOUT",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if strict and changed == 0 and not allow_noop:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "STRICT_FAIL_EXPECTED_CHANGE",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if changed == 1:
                        _set_file_text(rel_file, new_text)
                        file_entry["changed"] = True
                    
                    op_record(changed)
                    continue

                if cmd.op == "REPLACE_REGEX_FIRST":
                    regex = cmd.args[0] if len(cmd.args) >= 1 else ""
                    repl = cmd.args[1] if len(cmd.args) >= 2 else ""
                    try:
                        new_text, changed = _apply_replace_regex(cur_text, regex, repl, first_only=True)
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if changed == -1:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "REGEX_TIMEOUT",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if strict and changed == 0 and not allow_noop:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "STRICT_FAIL_EXPECTED_CHANGE",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if changed == 1:
                        _set_file_text(rel_file, new_text)
                        file_entry["changed"] = True
                    
                    op_record(changed)
                    continue

                if cmd.op == "DELETE_REGEX":
                    regex = cmd.args[0] if cmd.args else ""
                    try:
                        new_text, changed = _apply_delete_regex(cur_text, regex)
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if changed == -1:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "REGEX_TIMEOUT",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if strict and changed == 0 and not allow_noop:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "STRICT_FAIL_EXPECTED_CHANGE",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if changed == 1:
                        _set_file_text(rel_file, new_text)
                        file_entry["changed"] = True
                    
                    op_record(changed)
                    continue

                if cmd.op == "REPLACE_BLOCK":
                    if len(cmd.args) < 3:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "INVALID_ARGS",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    start_re = cmd.args[0]
                    end_re = cmd.args[1]
                    block_text = _json_unquote(cmd.args[2])
                    try:
                        new_text, changed = _apply_replace_block(cur_text, start_re, end_re, block_text)
                    except ValueError as e:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": f"REGEX_ERROR: {e}",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                        op_record(0)
                        continue
                    
                    if changed == -1:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "REGEX_TIMEOUT",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if strict and changed == 0 and not allow_noop:
                        err = {
                            "step": step_name,
                            "script": sp,
                            "file": rel_file,
                            "line": cmd.line_no,
                            "op": cmd.op,
                            "error": "STRICT_FAIL_EXPECTED_CHANGE",
                            "raw": cmd.raw,
                        }
                        script_entry["errors"].append(err)
                        step_errors.append(err)
                    
                    if changed == 1:
                        _set_file_text(rel_file, new_text)
                        file_entry["changed"] = True
                    
                    op_record(changed)
                    continue

                err = {
                    "step": step_name,
                    "script": sp,
                    "file": rel_file,
                    "line": cmd.line_no,
                    "op": cmd.op,
                    "error": "UNKNOWN_OP",
                    "raw": cmd.raw,
                }
                script_entry["errors"].append(err)
                step_errors.append(err)
                op_record(0)

            for rel_file, fe in per_file_ops.items():
                cur = _get_file_text(rel_file)
                abs_path = os.path.join(root_abs, rel_file)
                before_text = read_text(abs_path) if os.path.exists(abs_path) else ""
                after_text = cur if cur is not None else ""
                
                if fe["changed"]:
                    fe["diff"] = _diff_text(before_text, after_text, rel_file)
                    fe["bytes_before"] = len(before_text.encode("utf-8"))
                    fe["bytes_after"] = len(after_text.encode("utf-8"))
                    fe["sha256_before"] = sha256_text(before_text) if before_text else None
                    fe["sha256_after"] = sha256_text(after_text)
                else:
                    fe["bytes_before"] = len(before_text.encode("utf-8")) if os.path.exists(abs_path) else 0
                    fe["bytes_after"] = fe["bytes_before"]
                    fe["sha256_before"] = sha256_text(before_text) if os.path.exists(abs_path) else None
                    fe["sha256_after"] = fe["sha256_before"]

                script_entry["files"].append(fe)

        if step_errors:
            step_entry["status"] = "FAILED"
            report["errors"].extend(step_errors)
            if rollback_on_fail and not plan_only:
                report["rollback"] = _rollback()
            break

    if not plan_only and not report["errors"]:
        if len(changed_files) > max_files:
            report["errors"].append({"error": "LIMIT_MAX_FILES_EXCEEDED", "max_files": max_files, "found": len(changed_files)})
        if wrote_bytes_total > max_total_write_bytes:
            report["errors"].append({"error": "LIMIT_MAX_TOTAL_WRITE_BYTES_EXCEEDED", "max_total_write_bytes": max_total_write_bytes, "found": wrote_bytes_total})

        if report["errors"]:
            if rollback_on_fail:
                report["rollback"] = _rollback()
        else:
            for rel_path, meta in changed_files.items():
                text = _get_file_text(rel_path) or ""
                _write_file(rel_path, text, meta.get("is_new", False))

    summary_dir = os.path.join(root_abs, "data", "index")
    os.makedirs(summary_dir, exist_ok=True)
    summary_path = os.path.join(summary_dir, "changes-summary.md")
    report["summary_path"] = summary_path

    md = []
    md.append("# Safe-Vibe Patch Summary")
    md.append("")
    md.append(f"- Root: `{root_abs}`")
    md.append(f"- Plan only: `{plan_only}`")
    md.append(f"- Strict: `{strict}`")
    md.append(f"- Backup: `{backup}`")
    md.append(f"- Rollback on fail: `{rollback_on_fail}`")
    md.append(f"- Duration (ms): `{int((time.time() - t0) * 1000)}`")
    md.append("")
    md.append(f"## Status: {'FAILED' if report['errors'] else 'OK'}")
    
    if report["errors"]:
        md.append("")
        md.append("## Errors")
        md.append("")
        for error in report["errors"]:
            md.append(f"- `{error.get('error', 'UNKNOWN')}`: {error.get('file', '')} ({error.get('step', '')})")
    
    md.append("")
    md.append("## Diffs")
    md.append("")
    
    diffs_found = False
    for step in report["steps"]:
        for sc in step.get("scripts", []):
            for fe in sc.get("files", []):
                if fe.get("diff"):
                    diffs_found = True
                    md.append(f"### {fe['file']} {'(NEW)' if fe.get('is_new') else ''}")
                    md.append("")
                    md.append("```diff")
                    md.append(fe["diff"].rstrip("\n"))
                    md.append("```")
                    md.append("")
    
    if not diffs_found:
        md.append("No changes to display.")
    
    write_text(summary_path, "\n".join(md).rstrip("\n") + "\n")
    report["duration_ms"] = int((time.time() - t0) * 1000)
    
    return report

###############################################################################
# CLI
###############################################################################

def main():
    ap = argparse.ArgumentParser(description="Safe-Vibe patch orchestrator")
    ap.add_argument("--root", required=True, help="Project root")
    ap.add_argument("--pipeline", required=True, help="Pipeline JSON")
    ap.add_argument("--debug-pipeline", action="store_true", help="Print pipeline load/normalize diagnostics")
    ap.add_argument("--plan", action="store_true", help="Plan only (no writes)")
    ap.add_argument("--apply", action="store_true", help="Apply changes (write to disk)")
    ap.add_argument("--strict", action="store_true", help="Strict mode (no-op mutations fail unless ALLOW_NOOP=1)")
    ap.add_argument("--backup", action="store_true", help="Write .bak backups on apply")
    ap.add_argument("--rollback-on-fail", action="store_true", help="Attempt rollback on failure (apply only)")
    ap.add_argument("--workers", type=int, default=8, help="Workers (reserved)")
    ap.add_argument("--max-files", type=int, default=500, help="Limit changed files")
    ap.add_argument("--max-total-write-bytes", type=int, default=10_000_000, help="Limit total bytes written")
    ap.add_argument("--allow", action="append", default=[], help="Allowlist prefix (repeatable)")
    ap.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    ap.add_argument("--report", required=True, help="Report JSON output path")

    args = ap.parse_args()

    if not args.plan and not args.apply:
        raise SystemExit("Must specify --plan or --apply")

    root_abs = os.path.abspath(args.root)
    allow_prefixes = args.allow[:] if args.allow else ["."]
    
    if args.verbose:
        print(f"[VERBOSE] Root: {root_abs}")
        print(f"[VERBOSE] Allow prefixes: {allow_prefixes}")
        print(f"[VERBOSE] Mode: {'PLAN' if args.plan else 'APPLY'}")
    
    try:
        pipeline = load_pipeline(root_abs, args.pipeline, debug_pipeline=args.debug_pipeline, verbose=args.verbose)
    except Exception as e:
        print(f"FATAL: Failed to load pipeline: {e}")
        sys.exit(1)

    if args.verbose:
        print(f"[VERBOSE] Pipeline loaded with {len(pipeline.get('steps', []))} steps")

    report = run_pipeline(
        root_abs=root_abs,
        pipeline=pipeline,
        plan_only=bool(args.plan),
        strict=bool(args.strict),
        backup=bool(args.backup),
        rollback_on_fail=bool(args.rollback_on_fail),
        allow_prefixes=allow_prefixes,
        max_files=int(args.max_files),
        max_total_write_bytes=int(args.max_total_write_bytes),
        workers=int(args.workers),
        verbose=args.verbose,
    )

    # CORREÇÃO: Garantir que rollback existe mesmo se não for usado
    if report.get("rollback") is None:
        report["rollback"] = {"attempted": False, "files_restored": [], "files_removed": []}

    write_text(os.path.abspath(args.report), json.dumps(report, indent=2, ensure_ascii=False) + "\n")

    if report.get("errors"):
        print("\nFAILED. Errors:")
        for e in report["errors"]:
            error_msg = e.get("error", "UNKNOWN")
            file = e.get("file", "")
            step = e.get("step", "")
            print(f"- {error_msg} [file: {file}, step: {step}]")
        
        # CORREÇÃO: Verificar se rollback existe antes de acessar
        rollback_info = report.get("rollback", {})
        if rollback_info.get("attempted"):
            print(f"\nRollback attempted: {len(rollback_info.get('files_restored', []))} files restored, "
                  f"{len(rollback_info.get('files_removed', []))} files removed")
        
        raise SystemExit(1)

    print("OK.")
    print(f"Summary: {report['summary_path']}")
    print(f"Report: {os.path.abspath(args.report)}")
    
    if args.verbose:
        changed = sum(1 for step in report["steps"] for sc in step.get("scripts", []) for fe in sc.get("files", []) if fe.get("changed"))
        print(f"[VERBOSE] Changed files: {changed}")
        print(f"[VERBOSE] Duration: {report['duration_ms']}ms")

if __name__ == "__main__":
    main()