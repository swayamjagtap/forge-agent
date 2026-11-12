# forge-agent

A minimal Visual Studio Code extension built in TypeScript with an embedded MCP (Model Context Protocol) server.

## Features

- **Forge Agent: Hello**: Displays an information message saying `"Hello from Forge Agent"`.
- **Embedded MCP Server**: Automatically activates on `onStartupFinished` and listens on `http://127.0.0.1:3334/mcp` using the Streamable HTTP transport.
  - `read_file(path, startLine?, endLine?)`: Reads a file from the workspace, rejecting paths outside workspace. Returns text with line numbers, capped at 20,000 characters.
  - `search_workspace(query, maxResults?)`: Plain-text search across workspace files, skipping `node_modules`, `.git`, `.venv`, and `out`. Returns file path, line number, and matching line, capped at 50 results.
  - `list_files(subdirectory?)`: Lists files in the workspace or subfolder, skipping the same directories, capped at 200 entries.
- **Output Channel**: Logs all tool invocations and server events to the VS Code Output Channel named `"Forge Agent"`.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [VS Code](https://code.visualstudio.com/)

### Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Compile TypeScript:
   ```bash
   npm run compile
   ```
   Or run the TypeScript compiler in watch mode:
   ```bash
   npm run watch
   ```

3. Press `F5` in VS Code to open an **Extension Development Host** window with the extension loaded.

4. Open the Output panel in VS Code (`View -> Output`) and select `"Forge Agent"` from the dropdown. You will see:
   ```
   Forge Agent activating...
   MCP server listening on http://127.0.0.1:3334/mcp
   ```

5. Test the MCP server with any MCP client or curl (see instructions below).
