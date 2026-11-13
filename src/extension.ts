import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.venv', 'out']);
const MAX_READ_CHARS = 20000;
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_ENTRIES = 200;

let httpServer: http.Server | undefined;
const transports = new Map<string, StreamableHTTPServerTransport>();

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open.');
  }
  return folders[0].uri.fsPath;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveWorkspacePath(filePath: string, workspaceRoot: string): string {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.join(workspaceRoot, filePath));

  if (!isPathInside(workspaceRoot, resolved)) {
    throw new Error(`Path is outside workspace: ${filePath}`);
  }

  if (fs.existsSync(resolved)) {
    try {
      const realRoot = fs.realpathSync.native ? fs.realpathSync.native(workspaceRoot) : fs.realpathSync(workspaceRoot);
      const realTarget = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
      if (!isPathInside(realRoot, realTarget)) {
        throw new Error(`Path resolves outside workspace: ${filePath}`);
      }
    } catch {
      // If realpath resolution fails, rely on normalized path check above
    }
  }

  return resolved;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function createMcpServer(outputChannel: vscode.OutputChannel): McpServer {
  const server = new McpServer({
    name: 'forge-agent',
    version: '0.0.1'
  });

  // 1. read_file(path, startLine?, endLine?)
  server.registerTool(
    'read_file',
    {
      description: 'Read a file from the first open workspace folder. Rejects paths outside the workspace. Returns text with line numbers capped at 20,000 characters.',
      inputSchema: {
        path: z.string().describe('File path relative to the workspace folder'),
        startLine: z.number().int().positive().optional().describe('1-based start line number (inclusive)'),
        endLine: z.number().int().positive().optional().describe('1-based end line number (inclusive)')
      }
    },
    async (args) => {
      outputChannel.appendLine(`[${new Date().toISOString()}] Tool called: read_file with arguments: ${JSON.stringify(args)}`);

      try {
        const root = getWorkspaceRoot();
        const targetPath = resolveWorkspacePath(args.path, root);

        if (!fs.existsSync(targetPath)) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: File not found: ${args.path}` }]
          };
        }

        const stat = await fs.promises.stat(targetPath);
        if (!stat.isFile()) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: Path is not a file: ${args.path}` }]
          };
        }

        const content = await fs.promises.readFile(targetPath, 'utf-8');
        const lines = content.split(/\r?\n/);
        const totalLines = lines.length;

        const start = args.startLine ? Math.max(1, args.startLine) : 1;
        const end = args.endLine ? Math.min(totalLines, args.endLine) : totalLines;

        if (start > totalLines || start > end) {
          return {
            content: [{ type: 'text', text: '' }]
          };
        }

        const formattedLines: string[] = [];
        for (let i = start; i <= end; i++) {
          formattedLines.push(`${i}: ${lines[i - 1]}`);
        }

        let output = formattedLines.join('\n');
        if (output.length > MAX_READ_CHARS) {
          output = output.slice(0, MAX_READ_CHARS);
        }

        return {
          content: [{ type: 'text', text: output }]
        };
      } catch (err: any) {
        outputChannel.appendLine(`[${new Date().toISOString()}] Error in read_file: ${err.message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }]
        };
      }
    }
  );

  // 2. search_workspace(query, maxResults?)
  server.registerTool(
    'search_workspace',
    {
      description: 'Plain-text search across workspace files, skipping node_modules, .git, .venv and out. Returns file path, line number and matching line capped at 50 results.',
      inputSchema: {
        query: z.string().describe('Plain-text search query string'),
        maxResults: z.number().int().positive().optional().describe('Maximum results to return (capped at 50)')
      }
    },
    async (args) => {
      outputChannel.appendLine(`[${new Date().toISOString()}] Tool called: search_workspace with arguments: ${JSON.stringify(args)}`);

      try {
        const root = getWorkspaceRoot();
        const limit = Math.min(Math.max(1, args.maxResults ?? MAX_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
        const matches: string[] = [];

        if (!args.query) {
          return {
            content: [{ type: 'text', text: 'Error: Empty search query.' }]
          };
        }

        const lowerQuery = args.query.toLowerCase();

        async function searchDir(dir: string): Promise<boolean> {
          let entries: fs.Dirent[];
          try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            return false;
          }

          for (const entry of entries) {
            if (matches.length >= limit) {
              return true;
            }

            if (entry.isDirectory()) {
              if (!SKIPPED_DIRS.has(entry.name)) {
                const stopped = await searchDir(path.join(dir, entry.name));
                if (stopped) {
                  return true;
                }
              }
            } else if (entry.isFile()) {
              const fullPath = path.join(dir, entry.name);
              try {
                const stat = await fs.promises.stat(fullPath);
                if (stat.size > 5 * 1024 * 1024) {
                  continue;
                }

                const buffer = await fs.promises.readFile(fullPath);
                if (isBinaryBuffer(buffer)) {
                  continue;
                }

                const fileText = buffer.toString('utf-8');
                const lines = fileText.split(/\r?\n/);
                const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i];
                  if (line.toLowerCase().includes(lowerQuery)) {
                    matches.push(`${relPath}:${i + 1}: ${line}`);
                    if (matches.length >= limit) {
                      return true;
                    }
                  }
                }
              } catch {
                // Ignore unreadable files
              }
            }
          }
          return false;
        }

        await searchDir(root);

        const resultText = matches.length > 0 ? matches.join('\n') : `No matches found for "${args.query}".`;
        return {
          content: [{ type: 'text', text: resultText }]
        };
      } catch (err: any) {
        outputChannel.appendLine(`[${new Date().toISOString()}] Error in search_workspace: ${err.message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }]
        };
      }
    }
  );

  // 3. list_files(subdirectory?)
  server.registerTool(
    'list_files',
    {
      description: 'List files in the workspace or a subfolder, skipping node_modules, .git, .venv and out. Capped at 200 entries.',
      inputSchema: {
        subdirectory: z.string().optional().describe('Optional subdirectory relative to the workspace root')
      }
    },
    async (args) => {
      outputChannel.appendLine(`[${new Date().toISOString()}] Tool called: list_files with arguments: ${JSON.stringify(args)}`);

      try {
        const root = getWorkspaceRoot();
        const startDir = args.subdirectory
          ? resolveWorkspacePath(args.subdirectory, root)
          : root;

        if (!fs.existsSync(startDir)) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: Subdirectory not found: ${args.subdirectory}` }]
          };
        }

        const startStat = await fs.promises.stat(startDir);
        if (!startStat.isDirectory()) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: Path is not a directory: ${args.subdirectory}` }]
          };
        }

        const files: string[] = [];

        async function walk(dir: string): Promise<boolean> {
          let entries: fs.Dirent[];
          try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            return false;
          }

          entries.sort((a, b) => a.name.localeCompare(b.name));

          for (const entry of entries) {
            if (files.length >= MAX_LIST_ENTRIES) {
              return true;
            }

            if (entry.isDirectory()) {
              if (!SKIPPED_DIRS.has(entry.name)) {
                const stopped = await walk(path.join(dir, entry.name));
                if (stopped) {
                  return true;
                }
              }
            } else if (entry.isFile()) {
              const fullPath = path.join(dir, entry.name);
              const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
              files.push(relPath);
              if (files.length >= MAX_LIST_ENTRIES) {
                return true;
              }
            }
          }
          return false;
        }

        await walk(startDir);

        const resultText = files.length > 0 ? files.join('\n') : 'No files found.';
        return {
          content: [{ type: 'text', text: resultText }]
        };
      } catch (err: any) {
        outputChannel.appendLine(`[${new Date().toISOString()}] Error in list_files: ${err.message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }]
        };
      }
    }
  );

  return server;
}

export class ForgeChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forge-agent.chatView';
  private _view?: vscode.WebviewView;
  private _sessionId?: string;
  private _isRunning: boolean = false;
  private _history: Array<{ type: string; [key: string]: any }> = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _outputChannel: vscode.OutputChannel
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this._handleSendMessage(data.text);
          break;
        case 'cancel':
          await this._handleCancel();
          break;
        case 'newChat':
          await this._handleNewChat();
          break;
        case 'ready':
          this._syncState();
          break;
      }
    });
  }

  private _postToWebview(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _syncState() {
    this._postToWebview({
      type: 'restoreState',
      history: this._history,
      isRunning: this._isRunning
    });
  }

  private async _handleSendMessage(text: string) {
    if (this._isRunning || !text.trim()) {
      return;
    }

    const config = vscode.workspace.getConfiguration('forgeAgent');
    const baseUrl = config.get<string>('baseUrl', 'http://localhost:8790').replace(/\/+$/, '');
    const agentName = config.get<string>('agentName', 'editor-test');

    this._isRunning = true;
    this._postToWebview({ type: 'state', isRunning: true });

    const userMsg = { type: 'userMessage', text };
    this._history.push(userMsg);
    this._postToWebview(userMsg);

    try {
      // 1. Create session if we don't have one
      if (!this._sessionId) {
        this._outputChannel.appendLine(`[Forge Agent Chat] Creating session for agent "${agentName}" at ${baseUrl}...`);
        let sessionRes: Response;
        try {
          sessionRes = await fetch(`${baseUrl}/api/v1/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: { name: agentName } })
          });
        } catch (netErr: any) {
          throw new Error(`Unable to connect to TrueForge server at ${baseUrl}: ${netErr.message}`);
        }

        if (!sessionRes.ok) {
          const errBody = await sessionRes.text();
          throw new Error(`Failed to create session (${sessionRes.status}): ${errBody || sessionRes.statusText}`);
        }

        const sessionJson = (await sessionRes.json()) as { data?: { id?: string } };
        if (!sessionJson?.data?.id) {
          throw new Error(`Server returned invalid session response: ${JSON.stringify(sessionJson)}`);
        }
        this._sessionId = sessionJson.data.id;
        this._outputChannel.appendLine(`[Forge Agent Chat] Session created: ${this._sessionId}`);
      }

      // 2. Start turn with streaming
      this._outputChannel.appendLine(`[Forge Agent Chat] Starting streaming turn in session ${this._sessionId}...`);
      let turnRes: Response;
      try {
        turnRes = await fetch(`${baseUrl}/api/v1/sessions/${this._sessionId}/turns`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
          },
          body: JSON.stringify({
            input: [{ type: 'user.message', content: text }],
            stream: true
          })
        });
      } catch (netErr: any) {
        throw new Error(`Unable to start turn at ${baseUrl}: ${netErr.message}`);
      }

      if (!turnRes.ok) {
        const errBody = await turnRes.text();
        throw new Error(`Failed to execute turn (${turnRes.status}): ${errBody || turnRes.statusText}`);
      }

      if (!turnRes.body) {
        throw new Error('Server returned empty response body for turn.');
      }

      // 3. Process Server-Sent Events stream asynchronously
      const reader = turnRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const seenToolCalls = new Set<string>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            continue;
          }

          const dataStr = trimmed.slice(5).trim();
          if (!dataStr) {
            continue;
          }

          let event: any;
          try {
            event = JSON.parse(dataStr);
          } catch {
            continue;
          }

          switch (event.type) {
            case 'model.message': {
              const id = event.id;
              let initialText = '';
              if (typeof event.content === 'string') {
                initialText = event.content;
              } else if (Array.isArray(event.content)) {
                initialText = event.content.map((p: any) => p.text || '').join('');
              }

              const startMsg = { type: 'modelMessageStart', id, initialContent: initialText };
              this._history.push(startMsg);
              this._postToWebview(startMsg);

              if (Array.isArray(event.tool_calls)) {
                for (const tc of event.tool_calls) {
                  const toolName = tc.function?.name || tc.tool_info?.name;
                  const toolKey = tc.id || `${id}-${tc.index ?? 0}-${toolName}`;
                  if (toolName && !seenToolCalls.has(toolKey)) {
                    seenToolCalls.add(toolKey);
                    const toolMsg = { type: 'toolCall', toolName };
                    this._history.push(toolMsg);
                    this._postToWebview(toolMsg);
                  }
                }
              }
              break;
            }

            case 'model.message.delta': {
              const id = event.id;
              if (typeof event.content === 'string' && event.content.length > 0) {
                const deltaMsg = { type: 'modelMessageDelta', id, delta: event.content };
                this._history.push(deltaMsg);
                this._postToWebview(deltaMsg);
              }

              if (Array.isArray(event.tool_calls)) {
                for (const tc of event.tool_calls) {
                  const toolName = tc.function?.name || tc.tool_info?.name;
                  const toolKey = tc.id || `${id}-${tc.index ?? 0}-${toolName}`;
                  if (toolName && !seenToolCalls.has(toolKey)) {
                    seenToolCalls.add(toolKey);
                    const toolMsg = { type: 'toolCall', toolName };
                    this._history.push(toolMsg);
                    this._postToWebview(toolMsg);
                  }
                }
              }
              break;
            }

            case 'tool.approval_required': {
              const approvalMsg = { type: 'approvalRequired' };
              this._history.push(approvalMsg);
              this._postToWebview(approvalMsg);
              break;
            }

            case 'turn.done': {
              if (event.state?.status === 'cancelled') {
                const cancelMsg = { type: 'cancelled' };
                this._history.push(cancelMsg);
                this._postToWebview(cancelMsg);
              }
              break;
            }
          }
        }
      }
    } catch (err: any) {
      this._outputChannel.appendLine(`[Forge Agent Chat] Error: ${err.message}`);
      const errorMsg = { type: 'error', message: err.message };
      this._history.push(errorMsg);
      this._postToWebview(errorMsg);
    } finally {
      this._isRunning = false;
      this._postToWebview({ type: 'state', isRunning: false });
    }
  }

  private async _handleCancel() {
    if (!this._sessionId || !this._isRunning) {
      return;
    }

    const config = vscode.workspace.getConfiguration('forgeAgent');
    const baseUrl = config.get<string>('baseUrl', 'http://localhost:8790').replace(/\/+$/, '');

    this._outputChannel.appendLine(`[Forge Agent Chat] Cancelling running turn in session ${this._sessionId}...`);

    try {
      await fetch(`${baseUrl}/api/v1/sessions/${this._sessionId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    } catch (err: any) {
      this._outputChannel.appendLine(`[Forge Agent Chat] Cancel request error: ${err.message}`);
    }

    this._isRunning = false;
    const cancelMsg = { type: 'cancelled' };
    this._history.push(cancelMsg);
    this._postToWebview(cancelMsg);
    this._postToWebview({ type: 'state', isRunning: false });
  }

  private async _handleNewChat() {
    if (this._isRunning && this._sessionId) {
      await this._handleCancel();
    }
    this._sessionId = undefined;
    this._isRunning = false;
    this._history = [];
    this._postToWebview({ type: 'resetChat' });
    this._outputChannel.appendLine('[Forge Agent Chat] New chat session started.');
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-sideBar-background, #1e1e1e);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, #2d2d2d);
      background: var(--vscode-sideBar-background, #1e1e1e);
      flex-shrink: 0;
    }
    .top-bar .title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarTitle-foreground, #bbbbbb);
    }
    .btn-new-chat {
      background: transparent;
      border: 1px solid var(--vscode-button-secondaryBorder, #3a3d41);
      color: var(--vscode-foreground, #cccccc);
      cursor: pointer;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 3px;
    }
    .btn-new-chat:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
    }
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .empty-state {
      margin: auto;
      text-align: center;
      color: var(--vscode-descriptionForeground, #858585);
      font-size: 12px;
      padding: 20px;
      line-height: 1.5;
    }
    .message {
      display: flex;
      flex-direction: column;
      max-width: 95%;
      word-break: break-word;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .message.user {
      align-self: flex-end;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      padding: 8px 12px;
      border-radius: 10px 10px 2px 10px;
    }
    .message.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
      color: var(--vscode-foreground, #cccccc);
      padding: 8px 12px;
      border-radius: 10px 10px 10px 2px;
    }
    .tool-call-line {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
      font-style: italic;
      padding: 2px 4px;
    }
    .approval-notice {
      font-size: 12px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      background: rgba(204, 167, 0, 0.1);
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      padding: 6px 10px;
      border-radius: 4px;
    }
    .cancelled-notice {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #858585);
      font-style: italic;
      padding: 2px 4px;
    }
    .error-notice {
      color: var(--vscode-errorForeground, #f14c4c);
      background: rgba(241, 76, 76, 0.1);
      border: 1px solid var(--vscode-errorForeground, #f14c4c);
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 12px;
      word-break: break-word;
    }
    .input-section {
      padding: 8px 12px 12px 12px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, #2d2d2d);
      background: var(--vscode-sideBar-background, #1e1e1e);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }
    .input-section textarea {
      width: 100%;
      min-height: 52px;
      max-height: 140px;
      resize: none;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px;
      padding: 8px;
      font-family: inherit;
      font-size: inherit;
      outline: none;
    }
    .input-section textarea:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .btn-row {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .btn {
      padding: 5px 14px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-send {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }
    .btn-send:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .btn-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-stop {
      background: var(--vscode-errorForeground, #f14c4c);
      color: #ffffff;
    }
    .btn-stop:hover {
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <span class="title">Forge Agent</span>
    <button id="newChatBtn" class="btn-new-chat">+ New chat</button>
  </div>
  <div id="messagesContainer" class="messages-container">
    <div id="emptyState" class="empty-state">
      Ask Forge Agent to inspect files, search the workspace, or help with code.
    </div>
  </div>
  <div class="input-section">
    <textarea id="promptInput" placeholder="Message Forge Agent... (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="btn-row">
      <button id="stopBtn" class="btn btn-stop" style="display: none;">Stop</button>
      <button id="sendBtn" class="btn btn-send">Send</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesContainer = document.getElementById('messagesContainer');
    const emptyState = document.getElementById('emptyState');
    const promptInput = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    const newChatBtn = document.getElementById('newChatBtn');

    const modelMessages = new Map();
    let hasMessages = false;
    let lastItemIsCancelled = false;

    function hideEmptyState() {
      if (!hasMessages) {
        hasMessages = true;
        if (emptyState) {
          emptyState.style.display = 'none';
        }
      }
    }

    function scrollToBottom() {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function sendPrompt() {
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      lastItemIsCancelled = false;
      vscode.postMessage({ type: 'sendMessage', text });
    }

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    });

    sendBtn.addEventListener('click', sendPrompt);

    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    newChatBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'newChat' });
    });

    window.addEventListener('message', (event) => {
      const data = event.data;
      switch (data.type) {
        case 'userMessage': {
          hideEmptyState();
          lastItemIsCancelled = false;
          const div = document.createElement('div');
          div.className = 'message user';
          div.textContent = data.text;
          messagesContainer.appendChild(div);
          scrollToBottom();
          break;
        }

        case 'modelMessageStart': {
          hideEmptyState();
          lastItemIsCancelled = false;
          if (!modelMessages.has(data.id)) {
            const div = document.createElement('div');
            div.className = 'message assistant';
            div.textContent = data.initialContent || '';
            div.dataset.messageId = data.id;
            messagesContainer.appendChild(div);
            modelMessages.set(data.id, div);
            scrollToBottom();
          }
          break;
        }

        case 'modelMessageDelta': {
          hideEmptyState();
          lastItemIsCancelled = false;
          let div = modelMessages.get(data.id);
          if (!div) {
            div = document.createElement('div');
            div.className = 'message assistant';
            div.dataset.messageId = data.id;
            messagesContainer.appendChild(div);
            modelMessages.set(data.id, div);
          }
          div.textContent += data.delta;
          scrollToBottom();
          break;
        }

        case 'toolCall': {
          hideEmptyState();
          lastItemIsCancelled = false;
          const div = document.createElement('div');
          div.className = 'tool-call-line';
          div.textContent = 'Calling ' + data.toolName;
          messagesContainer.appendChild(div);
          scrollToBottom();
          break;
        }

        case 'approvalRequired': {
          hideEmptyState();
          lastItemIsCancelled = false;
          const div = document.createElement('div');
          div.className = 'approval-notice';
          div.textContent = 'Approval needed (not implemented yet)';
          messagesContainer.appendChild(div);
          scrollToBottom();
          break;
        }

        case 'cancelled': {
          if (!lastItemIsCancelled) {
            hideEmptyState();
            lastItemIsCancelled = true;
            const div = document.createElement('div');
            div.className = 'cancelled-notice';
            div.textContent = 'Cancelled';
            messagesContainer.appendChild(div);
            scrollToBottom();
          }
          break;
        }

        case 'error': {
          hideEmptyState();
          lastItemIsCancelled = false;
          const div = document.createElement('div');
          div.className = 'error-notice';
          div.textContent = data.message;
          messagesContainer.appendChild(div);
          scrollToBottom();
          break;
        }

        case 'state': {
          if (data.isRunning) {
            sendBtn.style.display = 'none';
            stopBtn.style.display = 'inline-flex';
          } else {
            sendBtn.style.display = 'inline-flex';
            stopBtn.style.display = 'none';
          }
          break;
        }

        case 'resetChat': {
          messagesContainer.innerHTML = '<div id="emptyState" class="empty-state">Ask Forge Agent to inspect files, search the workspace, or help with code.</div>';
          modelMessages.clear();
          hasMessages = false;
          lastItemIsCancelled = false;
          sendBtn.style.display = 'inline-flex';
          stopBtn.style.display = 'none';
          break;
        }

        case 'restoreState': {
          messagesContainer.innerHTML = '<div id="emptyState" class="empty-state">Ask Forge Agent to inspect files, search the workspace, or help with code.</div>';
          modelMessages.clear();
          hasMessages = false;
          lastItemIsCancelled = false;

          if (Array.isArray(data.history)) {
            for (const item of data.history) {
              window.dispatchEvent(new MessageEvent('message', { data: item }));
            }
          }
          if (data.isRunning) {
            sendBtn.style.display = 'none';
            stopBtn.style.display = 'inline-flex';
          } else {
            sendBtn.style.display = 'inline-flex';
            stopBtn.style.display = 'none';
          }
          break;
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Forge Agent');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Forge Agent activating...');

  // Register command "Forge Agent: Hello"
  const helloCommand = vscode.commands.registerCommand('forge-agent.hello', () => {
    vscode.window.showInformationMessage('Hello from Forge Agent');
  });
  context.subscriptions.push(helloCommand);

  // Register Sidebar Chat Webview Provider
  const chatProvider = new ForgeChatViewProvider(context.extensionUri, outputChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ForgeChatViewProvider.viewType, chatProvider)
  );

  // Embedded MCP Server setup
  const app = createMcpExpressApp();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const server = createMcpServer(outputChannel);
      await server.connect(transport);
    } else if (sessionId) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null
      });
      return;
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      const server = createMcpServer(outputChannel);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null
      });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(404).send('Session not found');
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  const PORT = 3334;
  const HOST = '127.0.0.1';

  httpServer = app.listen(PORT, HOST, () => {
    outputChannel.appendLine(`MCP server listening on http://${HOST}:${PORT}/mcp`);
  });

  httpServer.on('error', (err: any) => {
    outputChannel.appendLine(`MCP server error: ${err.message}`);
  });

  context.subscriptions.push({
    dispose: () => {
      if (httpServer) {
        httpServer.close();
        httpServer = undefined;
      }
    }
  });
}

export function deactivate() {
  if (httpServer) {
    httpServer.close();
    httpServer = undefined;
  }
}
