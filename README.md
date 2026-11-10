# Autodos

A task board where you and your AI coding agents work together. Tell the Lead what you want; it splits the work into todos, assigns them to agents (Claude Code, Codex), runs them in parallel in their own git worktrees, checks and cross-reviews every change, and stops where the decision is yours.

The app lives in [`app/`](app/): web app, desktop app (Tauri), MCP server and the worker for other machines. Start with [`app/README.md`](app/README.md).

```bash
cd app
npm install
npm run build && npm start   # http://localhost:4747
```
