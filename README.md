# forge-agent

A Visual Studio Code extension built in TypeScript featuring:
1. **Chat Panel (Sidebar Webview)** connected to TrueForge server via streaming HTTP API.
2. **Embedded MCP Server** listening on `http://127.0.0.1:3334/mcp` providing workspace inspection tools.

## Features

### 1. Chat Panel
- **Sidebar Webview**: Accessible via the Forge Agent icon in the Activity Bar.
- **TrueForge Integration**: Communicates with TrueForge server at `http://localhost:8790` (configurable via `forgeAgent.baseUrl`).
- **Streaming Turns**: Streams Server-Sent Events (SSE) and merges `model.message.delta` into `model.message` by `id`.
- **Tool Call Indicators**: Displays each tool invocation as a small italic line in the chat (e.g. `Calling search_workspace`).
- **Session Continuity**: Reuses the active session for follow-up questions.
- **New Chat**: Starts a fresh session at any time.
- **Stop Turn**: Cancel a running turn asynchronously via `POST /api/v1/sessions/{id}/cancel` without freezing the editor.
- **Approval Notice**: Displays `Approval needed (not implemented yet)` when a turn emits `tool.approval_required`.
- **Resilient Error Handling**: Shows red error banners in the chat panel if the server is unreachable or reports an error without crashing.

### 2. Configuration Settings
- `forgeAgent.baseUrl`: Base URL of the TrueForge server (default: `http://localhost:8790`).
- `forgeAgent.agentName`: Name of the agent to use (default: `editor-test`).

### 3. Embedded MCP Server
- Listens on `http://127.0.0.1:3334/mcp` using Streamable HTTP transport.
- Tools provided:
  - `read_file(path, startLine?, endLine?)`: Reads workspace files with line numbers (capped at 20,000 characters).
  - `search_workspace(query, maxResults?)`: Plain-text search skipping `node_modules`, `.git`, `.venv`, and `out` (capped at 50 results).
  - `list_files(subdirectory?)`: Lists files in workspace or subfolder skipping ignored folders (capped at 200 entries).
- Logs all tool calls to the `"Forge Agent"` output channel.

## Testing

1. Press `F5` in VS Code to launch the **Extension Development Host**.
2. Click the **Forge Agent** icon in the Activity Bar to open the Chat Panel.
3. Send a message such as `"What tools do you have?"` or `"Search the workspace for forge-agent"`.
4. Observe:
   - Tool calls displayed as `Calling <tool_name>` in the chat.
   - Streaming assistant response text rendered as deltas arrive.
   - Stop button visible while running; clicking it cancels the turn and shows `Cancelled`.
   - Clicking `+ New chat` resets the conversation.
