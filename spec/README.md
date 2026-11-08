# spec/ — target design (not built-work docs)

These files are the target spec for this project. They describe what we intend to build, not what is
already built. Do not edit them to match the code; re-fetch them from the site to update.

- Source: https://pi-durable-agents-0rrc3e.artifactcafe.dev/ (review: https://artifact.cafe/a/pi-durable-agents-0rrc3e)
- Version: 64, fetched 2026-11-07
- Each `*.md` file is the site's own markdown export of that page (`/v64/<page>.md`), saved byte-for-byte.
  Links inside the pages still point to the site's `*.html` names.
- `overview.md` is the site's index page. On the site it only redirects to Requirements; the project
  overview text is the "Overview" section of `requirements.md`.
- `changelog.md` is empty on the site.
- `diagrams/` holds the 10 inline SVG diagrams that the markdown export leaves out, copied unchanged from the
  HTML pages. One (`architecture-6-task-lifecycle.svg`) needed an `xmlns` attribute to open as a standalone
  file. Several diagrams use the site's CSS classes, so their colors and fonts may differ when opened alone.

| File | Page |
|---|---|
| `overview.md` | Index (redirect to Requirements) |
| `requirements.md` | Foundations / Requirements |
| `capacity.md` | Foundations / Capacity |
| `architecture.md` | Design / Architecture |
| `interfaces-and-storage.md` | Design / Interfaces and Storage |
| `agent-execution.md` | Design / Agent Execution |
| `deployment.md` | Operations / Deployment |
| `evaluation.md` | Operations / Evaluation |
| `build-plan.md` | Build plan |
| `changelog.md` | Changelog |
