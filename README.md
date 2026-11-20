# forge-agent

A VS Code extension that acts as a client for a local **TrueFoundry Forge** server.

The extension opens a sidebar chat connected to a Forge agent session, embeds an MCP server so the agent can read, search, and edit workspace files, and shows a hunk-by-hunk diff review panel before every change is written to disk.

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                   VS Code Extension                    │
│                                                        │
│  ┌────────────────────────┐  ┌──────────────────────┐  │
│  │   Sidebar Chat Panel   │  │  Hunk Review Panel   │  │
│  │  (SSE streaming UI)    │  │  (accept / reject)   │  │
│  └───────────┬────────────┘  └──────────┬───────────┘  │
│              │  HTTP REST / SSE          │  Approvals   │
└──────────────┼───────────────────────────┼─────────────┘
               │                           │
               ▼                           ▼
┌────────────────────────────────────────────────────────┐
│            TrueFoundry Forge Server                    │
│            (default: http://localhost:8790)            │
│                                                        │
│   Sessions API → Agent Runner → Configured LLM         │
│                        │                              │
│                        │  MCP JSON-RPC                │
└────────────────────────┼───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│          Embedded MCP Server (forge-editor)            │
│          http://127.0.0.1:3334/mcp                     │
│                                                        │
│  read_file · search_workspace · list_files             │
│  propose_edit · run_command                            │
└────────────────────────────────────────────────────────┘
```

**How the pieces connect:**

1. The **sidebar chat panel** creates a TrueForge session (`POST /api/v1/sessions`) and streams turns (`POST /api/v1/sessions/{id}/turns`). It never connects to an LLM provider directly.
2. The Forge server invokes the agent's tools over **MCP JSON-RPC**. The extension hosts that MCP server locally at `http://127.0.0.1:3334/mcp`.
3. When the agent calls `propose_edit`, the extension opens a **hunk review panel**. Files are only written to disk after the user accepts hunks in that panel.

---

## Hackathon Requirements Met

| Requirement | Implementation |
|---|---|
| VS Code extension as TrueForge client | `src/extension.ts` — sidebar webview + MCP server |
| All agent messages through TrueForge HTTP API | `POST /api/v1/sessions` and `/api/v1/sessions/{id}/turns` only |
| Workspace tools over MCP | `read_file`, `search_workspace`, `list_files`, `propose_edit`, `run_command` |
| Proposal-and-review before edits land | Hunk review panel; disk write requires user acceptance |
| Agent definition included in repository | `agent.json` at the repository root |
| Streaming, cancellation, error handling | SSE event loop, `POST …/cancel`, error banners |
| Tests and setup documentation | 84-test automated suite; this README |

---

## Features

### Chat Panel & Session Lifecycle

- **Sidebar webview** — accessible via the Forge Agent icon in the Activity Bar.
- **Strict TrueForge protocol** — all model turns go through Forge; no direct LLM calls.
- **SSE streaming** — `model.message.delta` tokens are merged and rendered as they arrive.
- **Tool call display** — active tool calls appear as concise lines (`propose_edit <path>`, `run_command <cmd>`); introspection tools are shown dimmed.
- **Turn cancellation** — `POST /api/v1/sessions/{id}/cancel` stops a running turn without locking the editor.
- **Session continuity** — history is kept across turns; `+ New chat` resets the session and clears exploration counters.

### MCP Tools (`forge-editor`)

| Tool | Description |
|---|---|
| `read_file(path, startLine?, endLine?)` | Reads a workspace file with line numbers. Max 20,000 characters. Rejects paths outside the workspace root. |
| `search_workspace(query, maxResults?)` | Plain-text search. Skips `node_modules`, `.git`, `.venv`, `out`. Max 50 results. |
| `list_files(subdirectory?)` | File-tree listing. Skips the same ignored directories. Max 200 entries. |
| `propose_edit(path, old_text?, new_text?, edits?, summary?)` | Proposes a workspace edit for user review. Accepts a single replacement or a batch `edits` array. Enforces uniqueness of `old_text`. Writes to disk only after the user accepts. |
| `run_command(command, timeoutSeconds?)` | Runs a shell command in the workspace. Requires modal approval from the user. Auto-activates a `.venv` Python environment if present. Blocked until at least one edit has been approved and applied. |

### Proposal & Diff Review Pipeline

- **Hunk-by-hunk review panel** — opened whenever the agent calls `propose_edit`.
- **Line count badges** — `+N added` / `-N deleted` on every hunk.
- **Structural deletion detection** — flags hunks that delete loop bodies, function definitions, conditionals, or class blocks, even when the deleted line count is small or when lines added exceed lines deleted. Flagged hunks are **unchecked by default**.
- **Explicit confirmation** — accepting a flagged hunk requires a browser-level confirmation dialog before the approval is dispatched to Forge.
- **Selective application** — only the hunks the user checks are applied; the rest are denied.
- **Snapshot-based undo** — a full pre-edit snapshot is taken before each write. `Forge Agent: Undo last applied change` restores it in one click.

### Model Fallback & Switching

- **Automatic fallback on HTTP 429** — when Forge reports a rate-limit or quota error the extension switches the agent's model via `PUT /api/v1/agents/{id}`, preserves the existing session, and retries with a compact continuation message rather than replaying the original prompt. A `user.tool_approval` payload that has already been consumed is **never** replayed.
- **Successive failover** — works through the `forgeAgent.fallbackModels` list in order, subject to a bounded retry limit, so failover cannot loop indefinitely.
- **Manual model switching** — `Forge Agent: Switch Model` in the Command Palette fetches the live model list from `/api/v1/models` and applies the choice via the same `PUT` path.

### Enforced Exploration Budgets

Budget caps are enforced inside the MCP tool handlers, not just in agent instructions:

| Tool | Cap | Resets on |
|---|---|---|
| `search_workspace` | 3 distinct queries per task | New chat |
| `read_file` | 4 reads before the first `propose_edit`; uncapped after | New chat |
| `list_files` | 1 call per task | New chat |

Duplicate queries and reads return cached results without consuming budget. Counters survive model failover within the same session because the TrueForge session ID does not change.

### Selection Editing

`Forge Agent: Edit Selection` (`Ctrl+Alt+K` or editor context menu) — select text in any editor, enter instructions, and send a targeted turn to Forge Agent scoped to that selection.

---

## Agent Definition

`agent.json` at the repository root is the **canonical agent definition**. It contains:

- The agent name (`editor-test`) and default model.
- System instructions covering exploration limits, the proposal-first workflow, the user approval protocol, and verification rules.
- MCP server registration (`forge-editor`) with tool lists and approval-required annotations.
- Forge configuration (`iteration_limit`, context management, etc.).

`scripts/sync-agent.js` reads `agent.json` and upserts it on the running Forge server via its REST API. Run `npm run sync-agent` after any change to `agent.json` to keep the server in sync.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `forgeAgent.baseUrl` | `http://localhost:8790` | Base URL of the local TrueForge server. |
| `forgeAgent.agentName` | `editor-test` | Agent name to use for sessions. Must match the name in `agent.json`. |
| `forgeAgent.autoFallback` | `true` | Automatically switch models on HTTP 429. |
| `forgeAgent.fallbackModels` | see `package.json` | Ordered list of TrueForge model identifiers to try when fallback triggers. Defaults to the models configured during development; update this to match the models available on your Forge server. |

---

## Setup

### Prerequisites

- **Node.js** v18 or later
- **VS Code** v1.85 or later
- A **local TrueFoundry Forge server** reachable at `http://localhost:8790` (or the URL you set in `forgeAgent.baseUrl`), with at least one LLM model configured and a provider that supports tool/function calling.

### Step 1 — Install dependencies and compile

```bash
npm install
npm run compile
```

### Step 2 — Register the agent definition

Upload `agent.json` to your running Forge server:

```bash
npm run sync-agent
```

The script connects to `forgeAgent.baseUrl` (default `http://localhost:8790`), finds or creates an agent named `editor-test`, and updates its manifest. Run this again any time `agent.json` changes.

### Step 3 — Verify the model

After syncing, confirm the agent's model is available on your Forge server. The default in `agent.json` is `google-gemini/gemini-3-5-flash-lite`; update `agent.json` and re-run `npm run sync-agent` if that model is not configured on your instance.

### Step 4 — Run the automated tests

```bash
npm test
```

This runs an 84-test suite that covers diff generation, hunk safety analysis, EOL normalisation, structural deletion detection, proposal hash verification, model fallback orchestration, approval replay prevention, successive failover, and exploration budget enforcement. All tests are automated unit/integration tests exercising the extension's TypeScript helpers. They do not require a live Forge server or VS Code instance.

### Step 5 — Launch the extension

1. Open this repository folder in VS Code.
2. Press `F5` to open the **Extension Development Host**.
3. In the host window, open a workspace folder (e.g. a Python project you want the agent to edit).
4. Click the **Forge Agent** icon in the Activity Bar to open the chat sidebar.
5. Type a message and confirm the agent responds via your local Forge server.

---

## Commands (Command Palette)

| Command | Description |
|---|---|
| `Forge Agent: Edit Selection` | Send the selected code with instructions to the agent (`Ctrl+Alt+K`). |
| `Forge Agent: Switch Model` | Fetch available models from Forge and switch the active agent model. |
| `Forge Agent: New Chat` | Start a fresh session and clear exploration counters. |
| `Forge Agent: Undo last applied change` | Restore the pre-edit file snapshot from the most recent approved edit. |

---

## Development Notes

- **Antigravity (Google DeepMind)** was used as a development-time coding assistant for auditing, refactoring, and test orchestration. It is not an npm dependency or part of the runtime.
- **TypeScript** sources are in `src/`. Compiled output goes to `out/`. The test entry point is `out/editPipeline.test.js`.
- The extension's MCP server is stateless across VS Code restarts but maintains per-session exploration counters while a session is active.
