const path = require("path");

const COLORS = {
  bg: "#0d1117",
  surface: "#161b22",
  card: "#0d1117",
  card2: "#161b22",
  fg: "#c9d1d9",
  fg2: "#8b949e",
  border: "#30363d",
  border2: "#3c444d",
  accent: "#1f6feb",
  danger: "#f85149",
  success: "#3fb950",
};

const DEFAULT_IGNORE_EXTS = new Set([
  ".pyc", ".bin", ".sqlite", ".db", ".zip", ".tar", ".gz", ".7z",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
]);

const DEFAULT_IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__"
]);

function safeRel(from, to) {
  try { return path.relative(from, to); } catch { return to; }
}

function formatCount(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0";
  return x.toLocaleString("pt-BR");
}

function nowTime() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

module.exports = {
  COLORS,
  DEFAULT_IGNORE_EXTS,
  DEFAULT_IGNORE_DIRS,
  safeRel,
  formatCount,
  nowTime,
};
