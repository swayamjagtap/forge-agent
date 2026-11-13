import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import * as diff from 'diff';
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

export interface ProposedEditItem {
  old_text: string;
  new_text: string;
}

export interface ProposalDecision {
  path: string;
  acceptedHunks: Set<number>;
  totalHunks: number;
}

export interface FileSnapshot {
  path: string;
  content: string | null;
}

export interface PendingReviewProposal {
  toolCallId: string;
  threadId: string;
  path: string;
  summary: string;
  originalContent: string;
  proposedContent: string;
  edits: ProposedEditItem[];
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
}

const pendingDecisions = new Map<string, ProposalDecision>();
let lastAppliedSnapshots: FileSnapshot[] = [];
let globalDiffProvider: ForgeDiffContentProvider | undefined;

export class ForgeDiffContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'forge-diff';
  private _documents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this._documents.get(uri.toString()) ?? '';
  }

  public setDocument(uri: vscode.Uri, content: string): void {
    this._documents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  public clear(): void {
    this._documents.clear();
  }
}

export function computeProposalHash(filePath: string, edits: ProposedEditItem[]): string {
  const norm = {
    path: filePath.replace(/\\/g, '/').trim(),
    edits: edits.map(e => ({ old_text: e.old_text, new_text: e.new_text }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

export function normalizeProposeEditArgs(raw: any): { path: string; edits: ProposedEditItem[]; summary?: string } | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  let input = raw;
  if (typeof raw.input === 'string') {
    try {
      input = JSON.parse(raw.input);
    } catch {
      input = raw.input;
    }
  } else if (raw.input && typeof raw.input === 'object') {
    input = raw.input;
  }

  if (!input || typeof input !== 'object') {
    return null;
  }

  const filePath = typeof input.path === 'string' ? input.path : (typeof raw.path === 'string' ? raw.path : '');
  if (!filePath) {
    return null;
  }

  const summary = typeof input.summary === 'string' ? input.summary : (typeof raw.summary === 'string' ? raw.summary : undefined);

  if (Array.isArray(input.edits)) {
    const edits: ProposedEditItem[] = [];
    for (const e of input.edits) {
      if (e && typeof e.old_text === 'string' && typeof e.new_text === 'string') {
        edits.push({ old_text: e.old_text, new_text: e.new_text });
      } else {
        return null;
      }
    }
    if (edits.length === 0) {
      return null;
    }
    return { path: filePath, edits, summary };
  }

  if (typeof input.old_text === 'string' && typeof input.new_text === 'string') {
    return {
      path: filePath,
      edits: [{ old_text: input.old_text, new_text: input.new_text }],
      summary
    };
  }

  return null;
}

export function countOccurrences(source: string, target: string): number {
  if (!target) {
    return 0;
  }
  let count = 0;
  let pos = 0;
  while ((pos = source.indexOf(target, pos)) !== -1) {
    count++;
    pos += target.length;
  }
  return count;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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

export async function undoLastAppliedChange(outputChannel: vscode.OutputChannel): Promise<void> {
  if (lastAppliedSnapshots.length === 0) {
    vscode.window.showInformationMessage('No applied changes to undo.');
    outputChannel.appendLine('[Forge Agent Undo] No snapshot available to restore.');
    return;
  }

  outputChannel.appendLine(`[Forge Agent Undo] Restoring ${lastAppliedSnapshots.length} file snapshot(s)...`);
  const snapshotsToRestore = [...lastAppliedSnapshots];
  lastAppliedSnapshots = [];

  const edit = new vscode.WorkspaceEdit();
  for (const snap of snapshotsToRestore) {
    const uri = vscode.Uri.file(snap.path);
    if (snap.content === null) {
      if (fs.existsSync(snap.path)) {
        edit.deleteFile(uri, { ignoreIfNotExists: true });
        outputChannel.appendLine(`[Forge Agent Undo] Deleting created file: ${snap.path}`);
      }
    } else {
      if (fs.existsSync(snap.path)) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        edit.replace(uri, fullRange, snap.content);
        outputChannel.appendLine(`[Forge Agent Undo] Restoring content of: ${snap.path}`);
      } else {
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), snap.content);
        outputChannel.appendLine(`[Forge Agent Undo] Re-creating file with restored content: ${snap.path}`);
      }
    }
  }

  const success = await vscode.workspace.applyEdit(edit);
  if (success) {
    for (const snap of snapshotsToRestore) {
      if (snap.content !== null && fs.existsSync(snap.path)) {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(snap.path));
          await doc.save();
        } catch {}
      }
    }
    outputChannel.appendLine('[Forge Agent Undo] Snapshot restoration complete.');
    vscode.window.showInformationMessage(`Forge Agent: Restored ${snapshotsToRestore.length} file(s).`);
  } else {
    outputChannel.appendLine('[Forge Agent Undo] Failed to apply workspace edit for snapshot restoration.');
    vscode.window.showErrorMessage('Forge Agent: Failed to restore snapshot.');
  }
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

  // 4. propose_edit(path, old_text?, new_text?, edits?, summary?)
  server.registerTool(
    'propose_edit',
    {
      description: 'Propose edits to a file in the workspace. Accepts either {path, old_text, new_text, summary?} or {path, edits: [{old_text, new_text}], summary?}. old_text must match exactly once in the file (or empty string if creating a new file). Edits require user approval before writing to disk.',
      inputSchema: {
        path: z.string().describe('File path relative to the workspace folder'),
        old_text: z.string().optional().describe('Exact text to replace (empty string if creating a new file)'),
        new_text: z.string().optional().describe('Replacement text'),
        edits: z.array(z.object({
          old_text: z.string().describe('Exact text to replace (empty string if creating a new file)'),
          new_text: z.string().describe('Replacement text')
        })).optional().describe('List of edits to apply'),
        summary: z.string().optional().describe('Summary of the proposed changes')
      }
    },
    async (args) => {
      outputChannel.appendLine(`[${new Date().toISOString()}] Tool called: propose_edit for ${args.path}`);

      const normalized = normalizeProposeEditArgs(args);
      if (!normalized) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: 'Error in propose_edit: propose_edit expects {path, old_text, new_text} or {path, edits: [{old_text, new_text}]}.'
          }]
        };
      }

      const { path: normPath, edits: normEdits, summary: normSummary } = normalized;
      outputChannel.appendLine(`[propose_edit] Summary: ${normSummary || '(none)'}`);

      try {
        const root = getWorkspaceRoot();
        const targetPath = resolveWorkspacePath(normPath, root);
        const fileExists = fs.existsSync(targetPath);

        let originalContent = '';
        if (!fileExists) {
          if (normEdits.length !== 1 || normEdits[0].old_text !== '') {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `Error: File does not exist: ${normPath}. An empty old_text ("") on a path that does not exist creates the file. Please re-read the workspace and retry.`
              }]
            };
          }
        } else {
          const stat = await fs.promises.stat(targetPath);
          if (!stat.isFile()) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Error: Path is not a file: ${normPath}` }]
            };
          }

          originalContent = await fs.promises.readFile(targetPath, 'utf-8');

          let simulated = originalContent;
          for (let i = 0; i < normEdits.length; i++) {
            const edit = normEdits[i];
            if (edit.old_text === '') {
              return {
                isError: true,
                content: [{
                  type: 'text',
                  text: `Error in edit ${i + 1}: old_text cannot be empty for an existing file. Please re-read the file and retry.`
                }]
              };
            }

            const count = countOccurrences(simulated, edit.old_text);
            if (count === 0) {
              return {
                isError: true,
                content: [{
                  type: 'text',
                  text: `Error in edit ${i + 1}: old_text was not found in ${normPath}. Please re-read the file and retry with exact text.`
                }]
              };
            }
            if (count > 1) {
              return {
                isError: true,
                content: [{
                  type: 'text',
                  text: `Error in edit ${i + 1}: old_text matched ${count} times in ${normPath}. It must match exactly once. Please re-read the file with more surrounding context and retry.`
                }]
              };
            }

            const idx = simulated.indexOf(edit.old_text);
            simulated = simulated.slice(0, idx) + edit.new_text + simulated.slice(idx + edit.old_text.length);
          }
        }

        // Check if decision exists for this proposal
        const hash = computeProposalHash(normPath, normEdits);
        const decision = pendingDecisions.get(hash);

        if (!decision || decision.acceptedHunks.size === 0) {
          outputChannel.appendLine(`[propose_edit] No accepted hunks for ${normPath} (hash: ${hash}). Disk write skipped.`);
          return {
            content: [{
              type: 'text',
              text: `Proposed edits for ${normPath} were rejected by user. No changes were written to disk.`
            }]
          };
        }

        // Apply ONLY the accepted hunks
        let patchedContent = '';
        if (!fileExists) {
          if (decision.acceptedHunks.has(0)) {
            patchedContent = normEdits[0].new_text;
          } else {
            return {
              content: [{
                type: 'text',
                text: `Creation of ${normPath} was rejected by user. File was not created.`
              }]
            };
          }
        } else {
          let targetContent = originalContent;
          for (const edit of normEdits) {
            const idx = targetContent.indexOf(edit.old_text);
            if (idx !== -1) {
              targetContent = targetContent.slice(0, idx) + edit.new_text + targetContent.slice(idx + edit.old_text.length);
            }
          }

          const relPath = path.relative(root, targetPath).replace(/\\/g, '/');
          const patchStr = diff.createTwoFilesPatch(relPath, relPath, originalContent, targetContent, '', '', { context: 3 });
          const parsed = diff.parsePatch(patchStr);

          if (!parsed || parsed.length === 0 || !parsed[0].hunks) {
            patchedContent = targetContent;
          } else {
            const selectedHunks = parsed[0].hunks.filter((_, idx) => decision.acceptedHunks.has(idx));
            if (selectedHunks.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: `All hunks for ${normPath} were rejected. No changes applied.`
                }]
              };
            }
            const patched = diff.applyPatch(originalContent, [{ ...parsed[0], hunks: selectedHunks }]);
            if (typeof patched !== 'string') {
              throw new Error('Failed to apply selected hunks to file content.');
            }
            patchedContent = patched;
          }
        }

        // Snapshot pre-edit state before applying
        lastAppliedSnapshots.push({
          path: targetPath,
          content: fileExists ? originalContent : null
        });
        outputChannel.appendLine(`[propose_edit] Snapshot created for ${targetPath}`);

        // Apply ONLY accepted hunks using vscode.WorkspaceEdit
        const uri = vscode.Uri.file(targetPath);
        const wsEdit = new vscode.WorkspaceEdit();

        if (!fileExists) {
          const parentDir = path.dirname(targetPath);
          if (!fs.existsSync(parentDir)) {
            await fs.promises.mkdir(parentDir, { recursive: true });
          }
          wsEdit.createFile(uri, { ignoreIfExists: true });
          wsEdit.insert(uri, new vscode.Position(0, 0), patchedContent);
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
          );
          wsEdit.replace(uri, fullRange, patchedContent);
        }

        const applied = await vscode.workspace.applyEdit(wsEdit);
        if (!applied) {
          throw new Error(`Failed to apply WorkspaceEdit to ${normPath}`);
        }

        const doc = await vscode.workspace.openTextDocument(uri);
        await doc.save();
        outputChannel.appendLine(`[propose_edit] Saved changes to ${targetPath}`);

        pendingDecisions.delete(hash);

        const appliedCount = decision.acceptedHunks.size;
        const rejectedCount = decision.totalHunks - appliedCount;
        const hunkLines: string[] = [];
        for (let i = 0; i < decision.totalHunks; i++) {
          hunkLines.push(`- Hunk ${i + 1}: ${decision.acceptedHunks.has(i) ? 'applied' : 'rejected'}`);
        }

        const summaryText = `Applied ${appliedCount} of ${decision.totalHunks} hunk(s) to ${normPath} (${rejectedCount} rejected).\n${hunkLines.join('\n')}`;
        outputChannel.appendLine(`[propose_edit] Summary: ${summaryText}`);

        return {
          content: [{ type: 'text', text: summaryText }]
        };
      } catch (err: any) {
        outputChannel.appendLine(`[propose_edit] Error: ${err.message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error in propose_edit: ${err.message}` }]
        };
      }
    }
  );

  return server;
}

export function formatToolCall(name: string, argsStr: string): { displayName: string; isMeta: boolean; realToolName: string; input: any } {
  let parsed: any = {};
  try {
    parsed = JSON.parse(argsStr || '{}');
  } catch {}

  if (name === 'list_tools' || name === 'get_tool_info') {
    const target = parsed.tool_name || parsed.mcp_server || '';
    return {
      displayName: target ? `${name} ${target}` : name,
      isMeta: true,
      realToolName: name,
      input: parsed
    };
  }

  let realName = name;
  let input = parsed;

  if (name === 'call_tool') {
    realName = parsed.tool_name || 'tool';
    input = parsed.input || {};
  }

  let argStr = '';
  if (typeof input === 'string') {
    argStr = input;
  } else if (typeof input === 'object' && input !== null) {
    if (input.path) {
      argStr = input.path;
    } else if (input.query) {
      argStr = `"${input.query}"`;
    } else if (input.subdirectory) {
      argStr = input.subdirectory;
    } else {
      const keys = Object.keys(input);
      if (keys.length > 0) {
        argStr = keys.map(k => `${k}=${JSON.stringify(input[k])}`).join(' ');
      }
    }
  }

  return {
    displayName: argStr ? `${realName} ${argStr}` : realName,
    isMeta: false,
    realToolName: realName,
    input
  };
}

export class ForgeChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forge-agent.chatView';
  private _view?: vscode.WebviewView;
  private _sessionId?: string;
  private _isRunning: boolean = false;
  private _history: Array<{ type: string; [key: string]: any }> = [];
  private _turnToolCalls = new Map<string, any>();
  private _activeReviewPanel?: vscode.WebviewPanel;
  private _consecutiveAutoDenials: number = 0;

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
        case 'undo':
          await undoLastAppliedChange(this._outputChannel);
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

  private async _ensureSession(): Promise<string> {
    if (this._sessionId) {
      return this._sessionId;
    }

    const config = vscode.workspace.getConfiguration('forgeAgent');
    const baseUrl = config.get<string>('baseUrl', 'http://localhost:8790').replace(/\/+$/, '');
    const agentName = config.get<string>('agentName', 'editor-test');

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
    return this._sessionId;
  }

  private async _handleSendMessage(text: string) {
    if (this._isRunning || !text.trim()) {
      return;
    }

    const userMsg = { type: 'userMessage', text };
    this._history.push(userMsg);
    this._postToWebview(userMsg);

    await this._runTurn([{ type: 'user.message', content: text }]);
  }

  private async _runTurn(inputItems: any[]) {
    this._isRunning = true;
    this._postToWebview({ type: 'state', isRunning: true });

    try {
      const sessionId = await this._ensureSession();
      const config = vscode.workspace.getConfiguration('forgeAgent');
      const baseUrl = config.get<string>('baseUrl', 'http://localhost:8790').replace(/\/+$/, '');

      this._outputChannel.appendLine(`[Forge Agent Chat] Starting streaming turn in session ${sessionId} with input: ${JSON.stringify(inputItems)}`);
      let turnRes: Response;
      try {
        turnRes = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
          },
          body: JSON.stringify({
            input: inputItems,
            stream: true
          })
        });
      } catch (netErr: any) {
        throw new Error(`Unable to execute turn at ${baseUrl}: ${netErr.message}`);
      }

      if (!turnRes.ok) {
        const errBody = await turnRes.text();
        throw new Error(`Failed to execute turn (${turnRes.status}): ${errBody || turnRes.statusText}`);
      }

      if (!turnRes.body) {
        throw new Error('Server returned empty response body for turn.');
      }

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

              // Record tool calls
              if (Array.isArray(event.tool_calls)) {
                for (const tc of event.tool_calls) {
                  if (tc.id) {
                    this._turnToolCalls.set(tc.id, tc);
                  }
                  const rawName = tc.function?.name || tc.tool_info?.name || '';
                  const rawArgs = tc.function?.arguments || '';
                  const formatted = formatToolCall(rawName, rawArgs);
                  const toolKey = tc.id || `${id}-${formatted.displayName}`;

                  if (!seenToolCalls.has(toolKey)) {
                    seenToolCalls.add(toolKey);
                    const toolMsg = {
                      type: 'toolCall',
                      displayName: formatted.displayName,
                      isMeta: formatted.isMeta
                    };
                    this._history.push(toolMsg);
                    this._postToWebview(toolMsg);
                  }
                }
              }

              // Do not post empty bubble if message only has tool calls
              if (initialText.trim().length > 0) {
                const startMsg = { type: 'modelMessageStart', id, initialContent: initialText };
                this._history.push(startMsg);
                this._postToWebview(startMsg);
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
                  if (tc.id) {
                    const existing = this._turnToolCalls.get(tc.id);
                    if (existing) {
                      if (tc.function?.arguments) {
                        existing.function.arguments = (existing.function.arguments || '') + tc.function.arguments;
                      }
                    } else {
                      this._turnToolCalls.set(tc.id, tc);
                    }
                  }
                  const rawName = tc.function?.name || tc.tool_info?.name || '';
                  const rawArgs = tc.function?.arguments || '';
                  if (rawName) {
                    const formatted = formatToolCall(rawName, rawArgs);
                    const toolKey = tc.id || `${id}-${formatted.displayName}`;
                    if (!seenToolCalls.has(toolKey)) {
                      seenToolCalls.add(toolKey);
                      const toolMsg = {
                        type: 'toolCall',
                        displayName: formatted.displayName,
                        isMeta: formatted.isMeta
                      };
                      this._history.push(toolMsg);
                      this._postToWebview(toolMsg);
                    }
                  }
                }
              }
              break;
            }

            case 'tool.approval_required': {
              this._outputChannel.appendLine(`[Forge Agent Chat] tool.approval_required received with ${event.tool_calls?.length ?? 0} tool call(s)`);
              await this._handleApprovalRequired(event);
              break;
            }

            case 'turn.done': {
              if (event.state?.status === 'cancelled') {
                const cancelMsg = { type: 'cancelled' };
                this._history.push(cancelMsg);
                this._postToWebview(cancelMsg);
              } else if (event.state?.status === 'error') {
                const errMsgText = event.state?.error?.message || event.state?.error || event.error?.message || event.error || 'Turn ended with error.';
                const errorMsg = { type: 'error', message: typeof errMsgText === 'string' ? errMsgText : JSON.stringify(errMsgText) };
                this._history.push(errorMsg);
                this._postToWebview(errorMsg);
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

  private async _handleApprovalRequired(event: any) {
    const threadId = event.thread_id || 'main';
    const toolCallRefs: Array<{ id: string; source_event_id?: string }> = event.tool_calls || [];
    const root = getWorkspaceRoot();

    const proposals: PendingReviewProposal[] = [];

    for (const ref of toolCallRefs) {
      const tc = this._turnToolCalls.get(ref.id);
      if (!tc) {
        this._outputChannel.appendLine(`[Forge Agent Review] Warning: Tool call ${ref.id} not found in tracked tool calls`);
        continue;
      }

      let toolName = tc.function?.name || tc.tool_info?.name || '';
      let rawArgs: any = {};
      try {
        rawArgs = JSON.parse(tc.function?.arguments || '{}');
        if (toolName === 'call_tool') {
          toolName = rawArgs.tool_name || '';
        }
      } catch {
        // ignore parse error
      }

      if (toolName === 'propose_edit') {
        const normalized = normalizeProposeEditArgs(rawArgs);
        if (normalized) {
          try {
            const targetPath = resolveWorkspacePath(normalized.path, root);
            const relPath = path.relative(root, targetPath).replace(/\\/g, '/');
            const fileExists = fs.existsSync(targetPath);
            const originalContent = fileExists ? await fs.promises.readFile(targetPath, 'utf-8') : '';

            let proposedContent = '';
            if (!fileExists) {
              proposedContent = normalized.edits[0]?.new_text ?? '';
            } else {
              let sim = originalContent;
              for (const edit of normalized.edits) {
                const idx = sim.indexOf(edit.old_text);
                if (idx !== -1) {
                  sim = sim.slice(0, idx) + edit.new_text + sim.slice(idx + edit.old_text.length);
                }
              }
              proposedContent = sim;
            }

            const patchStr = diff.createTwoFilesPatch(relPath, relPath, originalContent, proposedContent, '', '', { context: 3 });
            const parsed = diff.parsePatch(patchStr);
            const rawHunks = parsed[0]?.hunks || [];

            const hunks = rawHunks.map((h: any) => ({
              oldStart: h.oldStart,
              oldLines: h.oldLines,
              newStart: h.newStart,
              newLines: h.newLines,
              lines: h.lines
            }));

            proposals.push({
              toolCallId: ref.id,
              threadId,
              path: normalized.path,
              summary: normalized.summary || 'Proposed changes',
              originalContent,
              proposedContent,
              edits: normalized.edits,
              hunks
            });
          } catch (err: any) {
            this._outputChannel.appendLine(`[Forge Agent Review] Error preparing proposal for ${normalized.path}: ${err.message}`);
          }
        }
      }
    }

    if (proposals.length === 0) {
      this._consecutiveAutoDenials++;
      this._outputChannel.appendLine(`[Forge Agent Review] Invalid propose_edit arguments. Consecutive count: ${this._consecutiveAutoDenials}`);

      if (this._consecutiveAutoDenials >= 3) {
        this._outputChannel.appendLine('[Forge Agent Review] Auto-denied 3 times in a row for invalid arguments. Stopping denials and ending run.');
        this._consecutiveAutoDenials = 0;
        const errorMsg = { type: 'error', message: 'The agent sent invalid edits repeatedly.' };
        this._history.push(errorMsg);
        this._postToWebview(errorMsg);
        return;
      }

      const denyInputs = toolCallRefs.map(ref => ({
        type: 'user.tool_approval',
        thread_id: threadId,
        tool_call_id: ref.id,
        approval: { status: 'deny', reason: 'propose_edit expects {path, old_text, new_text}' }
      }));
      await this._runTurn(denyInputs);
      return;
    }

    this._consecutiveAutoDenials = 0;
    const approvalNotice = { type: 'approvalRequired' };
    this._history.push(approvalNotice);
    this._postToWebview(approvalNotice);

    this._openReviewPanel(proposals, toolCallRefs, threadId);
  }

  private _openReviewPanel(
    proposals: PendingReviewProposal[],
    toolCallRefs: Array<{ id: string; source_event_id?: string }>,
    threadId: string
  ) {
    if (this._activeReviewPanel) {
      this._activeReviewPanel.dispose();
    }

    const panel = vscode.window.createWebviewPanel(
      'forge-agent.review',
      'Review Proposed Edits',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    this._activeReviewPanel = panel;

    let isDecided = false;

    panel.webview.html = this._getHtmlForReview(panel.webview, proposals);

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'openFullDiff': {
          const prop = proposals[msg.fileIdx];
          if (prop && globalDiffProvider) {
            const root = getWorkspaceRoot();
            const relPath = prop.path;
            const originalUri = vscode.Uri.parse(
              `${ForgeDiffContentProvider.scheme}://preview/Original - ${encodeURIComponent(relPath)}?t=${Date.now()}`
            );
            globalDiffProvider.setDocument(originalUri, prop.originalContent);

            const proposedUri = vscode.Uri.parse(
              `${ForgeDiffContentProvider.scheme}://preview/Proposed - ${encodeURIComponent(relPath)}?t=${Date.now()}`
            );
            globalDiffProvider.setDocument(proposedUri, prop.proposedContent);

            await vscode.commands.executeCommand(
              'vscode.diff',
              originalUri,
              proposedUri,
              `${path.basename(relPath)} (Original ↔ Proposed)`
            );
          }
          break;
        }

        case 'applySelected': {
          isDecided = true;
          panel.dispose();

          const fileDecisions: Array<{ fileIdx: number; acceptedHunks: number[] }> = msg.decisions || [];
          const decisionsByFileIdx = new Map<number, number[]>();
          for (const d of fileDecisions) {
            decisionsByFileIdx.set(d.fileIdx, d.acceptedHunks);
          }

          const inputItems: any[] = [];
          for (let i = 0; i < proposals.length; i++) {
            const prop = proposals[i];
            const accepted = decisionsByFileIdx.get(i) || [];
            const hash = computeProposalHash(prop.path, prop.edits);

            if (accepted.length > 0) {
              pendingDecisions.set(hash, {
                path: prop.path,
                acceptedHunks: new Set(accepted),
                totalHunks: prop.hunks.length
              });
              inputItems.push({
                type: 'user.tool_approval',
                thread_id: prop.threadId,
                tool_call_id: prop.toolCallId,
                approval: { status: 'allow' }
              });
              this._outputChannel.appendLine(`[Forge Agent Review] Accepted ${accepted.length} hunk(s) for ${prop.path} (hash: ${hash})`);
            } else {
              inputItems.push({
                type: 'user.tool_approval',
                thread_id: prop.threadId,
                tool_call_id: prop.toolCallId,
                approval: {
                  status: 'deny',
                  reason: 'User rejected all proposed edits for this file.'
                }
              });
              this._outputChannel.appendLine(`[Forge Agent Review] Rejected all hunks for ${prop.path}`);
            }
          }

          // Handle any tool calls that were in the event but not in proposals
          for (const ref of toolCallRefs) {
            if (!proposals.some(p => p.toolCallId === ref.id)) {
              inputItems.push({
                type: 'user.tool_approval',
                thread_id: threadId,
                tool_call_id: ref.id,
                approval: { status: 'deny', reason: 'Unrecognized tool call.' }
              });
            }
          }

          this._outputChannel.appendLine(`[Forge Agent Review] Submitting user tool approvals: ${JSON.stringify(inputItems)}`);
          await this._runTurn(inputItems);
          break;
        }

        case 'rejectAll': {
          isDecided = true;
          panel.dispose();

          const inputItems = toolCallRefs.map(ref => ({
            type: 'user.tool_approval',
            thread_id: threadId,
            tool_call_id: ref.id,
            approval: { status: 'deny', reason: 'User rejected all proposed edits.' }
          }));

          this._outputChannel.appendLine(`[Forge Agent Review] User clicked Reject All: ${JSON.stringify(inputItems)}`);
          await this._runTurn(inputItems);
          break;
        }
      }
    });

    panel.onDidDispose(async () => {
      this._activeReviewPanel = undefined;
      if (!isDecided) {
        isDecided = true;
        this._outputChannel.appendLine('[Forge Agent Review] Review panel closed by user without decision. Denying pending tool calls.');
        const denyInputs = toolCallRefs.map(ref => ({
          type: 'user.tool_approval',
          thread_id: threadId,
          tool_call_id: ref.id,
          approval: { status: 'deny', reason: 'User closed review panel without accepting changes.' }
        }));
        await this._runTurn(denyInputs);
      }
    });
  }

  private _getHtmlForReview(webview: vscode.Webview, proposals: PendingReviewProposal[]): string {
    const proposalsJson = JSON.stringify(proposals.map((p, idx) => ({
      fileIdx: idx,
      path: p.path,
      summary: p.summary,
      totalHunks: p.hunks.length
    })));

    const fileBlocks = proposals.map((prop, fIdx) => {
      const hunkBlocks = prop.hunks.map((hunk, hIdx) => {
        const lineRows = hunk.lines.map(line => {
          let lineClass = 'ctx';
          if (line.startsWith('+')) {
            lineClass = 'add';
          } else if (line.startsWith('-')) {
            lineClass = 'del';
          }
          return `<div class="line ${lineClass}">${escapeHtml(line)}</div>`;
        }).join('');

        const oldRange = hunk.oldLines > 0 ? `lines ${hunk.oldStart}-${hunk.oldStart + hunk.oldLines - 1}` : `line ${hunk.oldStart}`;
        const newRange = hunk.newLines > 0 ? `lines ${hunk.newStart}-${hunk.newStart + hunk.newLines - 1}` : `line ${hunk.newStart}`;

        return `
        <div class="hunk-card">
          <div class="hunk-header">
            <span class="hunk-title">Hunk #${hIdx + 1} (${oldRange} → ${newRange})</span>
            <label class="hunk-toggle">
              <input type="checkbox" class="hunk-checkbox" checked data-file="${fIdx}" data-hunk="${hIdx}">
              <span>Accept hunk</span>
            </label>
          </div>
          <pre class="hunk-pre">${lineRows}</pre>
        </div>`;
      }).join('');

      return `
      <div class="file-card" data-file="${fIdx}">
        <div class="file-header">
          <div class="file-info">
            <span class="file-path">${escapeHtml(prop.path)}</span>
            <span class="file-summary">${escapeHtml(prop.summary)}</span>
          </div>
          <button class="btn btn-diff" data-file="${fIdx}">Open full diff</button>
        </div>
        <div class="hunks-container">
          ${hunkBlocks.length > 0 ? hunkBlocks : '<div class="no-hunks">No line diffs detected.</div>'}
        </div>
      </div>`;
    }).join('');

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
      background-color: var(--vscode-editor-background, #1e1e1e);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .review-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-widget-border, #333333);
      background: var(--vscode-sideBar-background, #252526);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }
    .review-header h2 {
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-editor-foreground, #ffffff);
    }
    .review-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .file-card {
      border: 1px solid var(--vscode-widget-border, #3a3d41);
      border-radius: 6px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255, 255, 255, 0.02));
      overflow: hidden;
    }
    .file-header {
      padding: 10px 14px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(255, 255, 255, 0.04));
      border-bottom: 1px solid var(--vscode-widget-border, #3a3d41);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .file-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .file-path {
      font-weight: 600;
      font-size: 13px;
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .file-summary {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #999999);
    }
    .hunks-container {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .hunk-card {
      border: 1px solid var(--vscode-widget-border, #2d2d2d);
      border-radius: 4px;
      overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    .hunk-header {
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid var(--vscode-widget-border, #2d2d2d);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
    }
    .hunk-title {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-descriptionForeground, #888888);
    }
    .hunk-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 11px;
      user-select: none;
    }
    .hunk-toggle input {
      cursor: pointer;
    }
    .hunk-pre {
      font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      line-height: 1.45;
      margin: 0;
      padding: 6px 0;
      overflow-x: auto;
      white-space: pre;
    }
    .line {
      padding: 1px 12px;
    }
    .line.add {
      background: rgba(40, 167, 69, 0.18);
      color: #7ee787;
    }
    .line.del {
      background: rgba(241, 76, 76, 0.18);
      color: #ffa198;
    }
    .line.ctx {
      color: var(--vscode-editor-foreground, #cccccc);
    }
    .review-footer {
      padding: 12px 16px;
      border-top: 1px solid var(--vscode-widget-border, #333333);
      background: var(--vscode-sideBar-background, #252526);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-shrink: 0;
    }
    .btn {
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 4px;
      border: 1px solid transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-diff {
      background: transparent;
      border-color: var(--vscode-button-secondaryBorder, #3a3d41);
      color: var(--vscode-foreground, #cccccc);
      padding: 4px 10px;
      font-size: 11px;
    }
    .btn-diff:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
    }
    .btn-apply {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }
    .btn-apply:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .btn-reject {
      background: transparent;
      border-color: var(--vscode-errorForeground, #f14c4c);
      color: var(--vscode-errorForeground, #f14c4c);
    }
    .btn-reject:hover {
      background: rgba(241, 76, 76, 0.12);
    }
  </style>
</head>
<body>
  <div class="review-header">
    <h2>Review Proposed Edits</h2>
    <span>${proposals.length} file(s) modified</span>
  </div>

  <div class="review-content">
    ${fileBlocks}
  </div>

  <div class="review-footer">
    <button id="rejectAllBtn" class="btn btn-reject">Reject all</button>
    <button id="applySelectedBtn" class="btn btn-apply">Apply selected</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const proposalsMeta = ${proposalsJson};

    document.querySelectorAll('.btn-diff').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fileIdx = parseInt(e.currentTarget.getAttribute('data-file'), 10);
        vscode.postMessage({ type: 'openFullDiff', fileIdx });
      });
    });

    document.getElementById('applySelectedBtn').addEventListener('click', () => {
      const decisions = [];
      proposalsMeta.forEach(meta => {
        const acceptedHunks = [];
        const checkboxes = document.querySelectorAll(\`.hunk-checkbox[data-file="\${meta.fileIdx}"]\`);
        checkboxes.forEach(cb => {
          if (cb.checked) {
            acceptedHunks.push(parseInt(cb.getAttribute('data-hunk'), 10));
          }
        });
        decisions.push({ fileIdx: meta.fileIdx, acceptedHunks });
      });
      vscode.postMessage({ type: 'applySelected', decisions });
    });

    document.getElementById('rejectAllBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'rejectAll' });
    });
  </script>
</body>
</html>`;
  }

  private async _handleCancel() {
    if (this._activeReviewPanel) {
      this._activeReviewPanel.dispose();
      this._activeReviewPanel = undefined;
    }

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
    if (this._activeReviewPanel) {
      this._activeReviewPanel.dispose();
      this._activeReviewPanel = undefined;
    }
    if (this._isRunning && this._sessionId) {
      await this._handleCancel();
    }
    this._sessionId = undefined;
    this._isRunning = false;
    this._history = [];
    this._turnToolCalls.clear();
    this._consecutiveAutoDenials = 0;
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
    .top-actions {
      display: flex;
      gap: 6px;
    }
    .btn-action {
      background: transparent;
      border: 1px solid var(--vscode-button-secondaryBorder, #3a3d41);
      color: var(--vscode-foreground, #cccccc);
      cursor: pointer;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 3px;
    }
    .btn-action:hover {
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
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      padding: 2px 4px;
    }
    .tool-call-line.dimmed {
      opacity: 0.45;
      font-size: 10px;
      font-style: italic;
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
    <div class="top-actions">
      <button id="undoBtn" class="btn-action" title="Undo last applied change">Undo change</button>
      <button id="newChatBtn" class="btn-action">+ New chat</button>
    </div>
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
    const undoBtn = document.getElementById('undoBtn');

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

    undoBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'undo' });
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
          if (data.initialContent && data.initialContent.trim().length > 0) {
            hideEmptyState();
            lastItemIsCancelled = false;
            if (!modelMessages.has(data.id)) {
              const div = document.createElement('div');
              div.className = 'message assistant';
              div.textContent = data.initialContent;
              div.dataset.messageId = data.id;
              messagesContainer.appendChild(div);
              modelMessages.set(data.id, div);
              scrollToBottom();
            }
          }
          break;
        }

        case 'modelMessageDelta': {
          if (data.delta && data.delta.length > 0) {
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
          }
          break;
        }

        case 'toolCall': {
          hideEmptyState();
          lastItemIsCancelled = false;
          const div = document.createElement('div');
          div.className = data.isMeta ? 'tool-call-line dimmed' : 'tool-call-line';
          div.textContent = data.displayName;
          messagesContainer.appendChild(div);
          scrollToBottom();
          break;
        }

        case 'approvalRequired': {
          hideEmptyState();
          lastItemIsCancelled = false;
          const div = document.createElement('div');
          div.className = 'approval-notice';
          div.textContent = 'Approval required: A review panel has opened for proposed edits.';
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

  // Register Virtual Diff Document Content Provider
  globalDiffProvider = new ForgeDiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      ForgeDiffContentProvider.scheme,
      globalDiffProvider
    )
  );

  // Register command "Forge Agent: Hello"
  const helloCommand = vscode.commands.registerCommand('forge-agent.hello', () => {
    vscode.window.showInformationMessage('Hello from Forge Agent');
  });
  context.subscriptions.push(helloCommand);

  // Register command "Forge Agent: Undo last applied change"
  const undoCommand = vscode.commands.registerCommand('forge-agent.undoLastAppliedChange', async () => {
    await undoLastAppliedChange(outputChannel);
  });
  context.subscriptions.push(undoCommand);

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
