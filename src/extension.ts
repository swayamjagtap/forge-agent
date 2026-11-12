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

function createServer(outputChannel: vscode.OutputChannel): McpServer {
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
                  continue; // Skip very large files
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

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Forge Agent');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Forge Agent activating...');

  const helloCommand = vscode.commands.registerCommand('forge-agent.hello', () => {
    vscode.window.showInformationMessage('Hello from Forge Agent');
  });
  context.subscriptions.push(helloCommand);

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

      const server = createServer(outputChannel);
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
      const server = createServer(outputChannel);
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
