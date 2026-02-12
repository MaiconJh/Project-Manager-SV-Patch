# Project Manager & SV Patch

Project Manager & SV Patch is a desktop IDE-like tool designed for
structured patch orchestration, project visualization, and controlled
file editing using Safe-Vibe Patch pipelines.

It provides a stable environment for applying, auditing, and managing
structured file modifications in local projects.

------------------------------------------------------------------------

## ✨ Features

-   📁 Project folder visualization (IDE-style file tree)
-   📝 Integrated file viewer and editor
-   🔄 Structured `.rw` patch execution
-   🧪 Plan / Apply execution modes
-   📊 Automatic report generation (`sv-report.json`)
-   📋 Execution logs and pipeline tracking
-   🔍 Diff inspection and change auditing
-   🔔 Visual feedback (toasts, states, execution indicators)
-   👁 Markdown and raw file view modes
-   🖥 Fullscreen file editing support
-   ♻ Auto-refresh project watcher

------------------------------------------------------------------------

## 🧠 Philosophy

This tool prioritizes:

-   Safe execution
-   Controlled file modifications
-   Structured patch workflows
-   Minimalist IDE-inspired interface
-   Diff-safe incremental evolution

It is designed for developers who need reliability and clarity when
applying automated or structured modifications to real projects.

------------------------------------------------------------------------

## 🛠 Tech Stack

-   Electron
-   Node.js
-   JavaScript
-   Custom CSS Design System
-   Python-based Safe-Vibe Patch engine

------------------------------------------------------------------------

## 🚀 Usage

1.  Open a project folder.
2.  Select a runner toolset (SV Patch).
3.  Pick one or more `.rw` scripts.
4.  **Save the pipeline configuration before executing** (required
    step).
5.  Run in **Plan** mode to preview changes.
6.  Run in **Apply** mode to execute modifications.
7.  Inspect logs and reports.

------------------------------------------------------------------------

## 📦 Project Structure

    Project-Manager-SV-Patch/
    ├ package.json
    ├ ui.html
    ├ ui.js
    ├ ui.css
    ├ core.js
    ├ app.js
    ├ config.js
    ├ tools/
    ├ data/
    └ docs/

------------------------------------------------------------------------

## ⚠ Important Note

When selecting `.rw` scripts, the pipeline must be saved before running
Plan or Apply. Running execution without saving the pipeline will result
in an error.

------------------------------------------------------------------------

## ⚠ Disclaimer

This tool performs real file modifications. Always use Plan mode before
applying changes to critical projects.

------------------------------------------------------------------------

## 📄 License

MIT (or specify your chosen license)
