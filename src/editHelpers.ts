/**
 * editHelpers.ts — Pure helper functions with no vscode dependency.
 * Imported by both extension.ts (production) and editPipeline.test.ts (tests).
 */

import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ProposedEditItem {
  old_text: string;
  new_text: string;
}

export interface HunkMetrics {
  added: number;
  deleted: number;
}

export interface DestructiveAnalysis {
  risky: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// EOL / occurrence helpers
// ---------------------------------------------------------------------------

export function fitEol(text: string, eol: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, eol);
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

// ---------------------------------------------------------------------------
// JSON / argument helpers
// ---------------------------------------------------------------------------

export function parseToolArguments(text: string): any | null {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function isCompleteJson(text: string): boolean {
  if (typeof text !== 'string' || !text.trim()) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Proposal hash
// ---------------------------------------------------------------------------

export function computeProposalHash(filePath: string, edits: ProposedEditItem[]): string {
  const norm = {
    path: filePath.replace(/\\/g, '/').trim(),
    edits: edits.map(e => ({ old_text: e.old_text, new_text: e.new_text }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

// ---------------------------------------------------------------------------
// Argument normalisation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Hunk analysis — language-independent, primary metric is line counts
// ---------------------------------------------------------------------------

/**
 * Count `+` (added) and `-` (deleted) lines in a unified-diff hunk.
 * Lines starting with ` ` (space) are context lines and are not counted.
 */
export function computeHunkMetrics(hunk: { lines: string[] }): HunkMetrics {
  let added = 0;
  let deleted = 0;
  for (const line of hunk.lines) {
    if (line.startsWith('+')) {
      added++;
    } else if (line.startsWith('-')) {
      deleted++;
    }
  }
  return { added, deleted };
}

const STRUCTURAL_PATTERNS: Array<{ name: string; test: (s: string) => boolean }> = [
  { name: 'def', test: s => /^async\s+def\s+|^def\s+/.test(s) },
  { name: 'class', test: s => /^class\s+/.test(s) },
  { name: 'for', test: s => /^for\s+|^for\(/.test(s) },
  { name: 'while', test: s => /^while\s+|^while\(/.test(s) },
  { name: 'if', test: s => /^if\s+|^if\(|^elif\s+|^elif\(/.test(s) },
  { name: 'function', test: s => /^function\s+|^function\(|^async\s+function\s+|^async\s+function\(/.test(s) },
];

/**
 * Determine whether a hunk is potentially destructive.
 *
 * Risk criteria:
 * 1. Line-metric heuristic: deleted >= 3 AND deleted > added (substantial net line loss).
 * 2. Structural deletion heuristic: accidental deletion of loops (for/while), functions (def/function),
 *    classes, or conditional blocks (if/elif) even when fewer than 3 lines are deleted or when lines
 *    added exceed lines deleted (e.g., adding a new CLI command while accidentally deleting a 2-line loop).
 *
 * Note: A single-line in-place edit of a statement (deleted == 1 && added == 1 where both lines match
 * the same structural pattern, e.g. updating an if condition or def signature) is treated as an in-place
 * modification rather than a block deletion.
 */
export function isDestructiveHunk(metrics: HunkMetrics, hunkLines?: string[]): DestructiveAnalysis {
  const { added, deleted } = metrics;
  const lineMetricRisky = deleted >= 3 && deleted > added;

  // Structural analysis on deleted lines
  const foundKeywords: string[] = [];
  if (hunkLines && deleted > 0) {
    const deletedLines = hunkLines.filter(l => l.startsWith('-')).map(l => l.slice(1).trimStart());
    const addedLines = hunkLines.filter(l => l.startsWith('+')).map(l => l.slice(1).trimStart());

    for (const pat of STRUCTURAL_PATTERNS) {
      const deletedMatches = deletedLines.filter(l => pat.test(l));
      if (deletedMatches.length === 0) {
        continue;
      }

      // Check if this is merely a single-line in-place edit of the same construct
      if (deleted === 1 && added === 1 && addedLines.some(l => pat.test(l))) {
        continue;
      }

      if (!foundKeywords.includes(pat.name)) {
        foundKeywords.push(pat.name);
      }
    }
  }

  const structuralRisky = foundKeywords.length > 0;
  const risky = lineMetricRisky || structuralRisky;

  if (!risky) {
    return { risky: false, reason: '' };
  }

  let reason = '';
  if (structuralRisky) {
    const kwList = foundKeywords.map(k => `'${k}'`).join(', ');
    reason = `Deletes structural ${kwList} block (${deleted} line${deleted !== 1 ? 's' : ''} deleted, ${added} added)`;
  } else {
    reason = `Deletes ${deleted} line${deleted !== 1 ? 's' : ''} and adds only ${added}`;
  }
  reason += '. Review carefully.';

  return { risky: true, reason };
}

// ---------------------------------------------------------------------------
// Rate limit / Model fallback helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether an error message from TrueForge indicates a model rate-limit
 * or quota exhaustion (e.g. HTTP 429, ResourceExhausted).
 *
 * Explicitly rejects approval-state errors (such as HTTP 422 "no pending approval"),
 * validation errors, and ordinary tool errors so they never trigger model fallback.
 */
export function isRateLimitError(message: string): boolean {
  if (!message || typeof message !== 'string') {
    return false;
  }
  const lower = message.toLowerCase();

  // Explicitly exclude approval-state errors, 422 Unprocessable Entity, tool execution errors, and validation errors
  if (
    lower.includes('422') ||
    lower.includes('no pending approval') ||
    lower.includes('pending approval') ||
    lower.includes('tool_call_id') ||
    lower.includes('validation error') ||
    lower.includes('invalid input')
  ) {
    return false;
  }

  return (
    lower.includes('429') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('rate-limit') ||
    lower.includes('resource_exhausted') ||
    lower.includes('resourceexhausted') ||
    lower.includes('too many requests')
  );
}

/**
 * Checks whether a turn input payload contains any tool approvals (user.tool_approval).
 */
export function isToolApprovalPayload(items: any[]): boolean {
  if (!Array.isArray(items) || items.length === 0) {
    return false;
  }
  return items.some(it => it && typeof it === 'object' && it.type === 'user.tool_approval');
}

/**
 * Builds the recovery input for a fallback turn retry.
 *
 * CRITICAL SAFETY REQUIREMENT:
 * If the original turn was a tool approval (user.tool_approval), that approval has ALREADY
 * been accepted/consumed by TrueForge, and the underlying command or edit was already executed.
 * Re-submitting the same tool_call_id causes TrueForge to fail with HTTP 422: "no pending approval".
 * Instead, convert the payload into a system notice user.message instructing the agent to
 * continue from the completed tool result already saved in the session history.
 */
export function constructFallbackRecoveryInput(originalInput: any[], fallbackModel: string): any[] {
  if (isToolApprovalPayload(originalInput)) {
    const isDenial = originalInput.every(it => it?.approval?.status === 'deny');
    const actionDesc = isDenial ? 'tool decision' : 'approved action';
    const text = `[System Notice] A model rate limit occurred after your ${actionDesc} was processed. The TrueForge agent model has been switched to "${fallbackModel}". Please continue your work from the completed tool result in the session history. Do not repeat the previous tool call or request approval again.`;
    return [
      {
        type: 'user.message',
        content: [{ type: 'text', text }]
      }
    ];
  }

  // Ordinary user.message rate-limit failure:
  // Stop resubmitting the original full user prompt!
  // Generate a compact continuation message instructing the new model to continue in the same session,
  // reuse previous search/read results, avoid repeating exploration, and proceed to propose_edit.
  const continuationText = `[System Notice] A model rate limit occurred. The TrueForge agent model has been switched to "${fallbackModel}". Please continue the existing task in this session. Reuse your previous search results and file reads from the session history. Never repeat completed exploration or searches. Proceed directly to the remaining propose_edit calls for all required files.`;

  return [
    {
      type: 'user.message',
      content: [{ type: 'text', text: continuationText }]
    }
  ];
}

/**
 * Chooses the next alternative model from a configured list of fallback models.
 * If currentModel is found in the list, advances to the next entry; otherwise
 * picks the first entry that differs from currentModel.
 */
export function selectNextFallbackModel(currentModel: string, fallbackModels: string[]): string | null {
  if (!Array.isArray(fallbackModels) || fallbackModels.length === 0) {
    return null;
  }
  const cleanList = fallbackModels.map(m => m.trim()).filter(Boolean);
  if (cleanList.length === 0) {
    return null;
  }

  const currentIndex = cleanList.indexOf(currentModel);
  if (currentIndex >= 0 && currentIndex < cleanList.length - 1) {
    return cleanList[currentIndex + 1];
  }

  const alternative = cleanList.find(m => m !== currentModel);
  return alternative ?? null;
}

// ---------------------------------------------------------------------------
// 7. TrueForge Model Switch & Fallback Orchestration
// ---------------------------------------------------------------------------

export const DEFAULT_FALLBACK_MODELS = [
  'google-gemini/gemini-3-5-flash-lite',
  'google-gemini/gemini-3-1-flash-lite',
  'google-gemini/gemini-3-6-flash',
  'google-gemini/gemini-3-8-flash'
];

/**
 * Switches the agent model in TrueForge by calling:
 * 1. GET /api/v1/agents to find the agent and its current model
 * 2. PUT /api/v1/agents/{id} with the new model name
 */
export async function switchTrueForgeModel(
  baseUrl: string,
  agentName: string,
  fallbackModels: string[],
  outputChannel?: { appendLine(line: string): void }
): Promise<{ previousModel: string; newModel: string } | null> {
  try {
    const agentsRes = await fetch(`${baseUrl}/api/v1/agents`);
    if (!agentsRes.ok) {
      outputChannel?.appendLine(`[Forge Agent Fallback] Failed to fetch agents: HTTP ${agentsRes.status}`);
      return null;
    }
    const agentsData = (await agentsRes.json()) as any;
    const agent = agentsData.data?.find((a: any) => a.name === agentName);
    if (!agent) {
      outputChannel?.appendLine(`[Forge Agent Fallback] Agent "${agentName}" not found on TrueForge server.`);
      return null;
    }

    const currentModel = agent.manifest?.model?.name ?? '';
    const nextModel = selectNextFallbackModel(currentModel, fallbackModels);
    if (!nextModel) {
      outputChannel?.appendLine(`[Forge Agent Fallback] No alternative fallback model found in [${fallbackModels.join(', ')}]`);
      return null;
    }

    const updatedManifest = {
      ...agent.manifest,
      model: {
        ...(agent.manifest?.model || {}),
        name: nextModel
      }
    };

    const putRes = await fetch(`${baseUrl}/api/v1/agents/${agent.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: updatedManifest })
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      outputChannel?.appendLine(`[Forge Agent Fallback] Failed to update agent model to "${nextModel}": HTTP ${putRes.status} - ${errText}`);
      return null;
    }

    outputChannel?.appendLine(`[Forge Agent Fallback] Successfully switched agent "${agentName}" model: ${currentModel} -> ${nextModel}`);
    return { previousModel: currentModel, newModel: nextModel };
  } catch (err: any) {
    outputChannel?.appendLine(`[Forge Agent Fallback] Error switching model: ${err.message}`);
    return null;
  }
}

export interface FallbackParams {
  reason: string;
  originalInput: any[];
  baseUrl: string;
  agentName: string;
  fallbackModels: string[];
  logger?: { appendLine(line: string): void };
  switchModelFn?: (baseUrl: string, agentName: string, fallbackModels: string[], logger?: any) => Promise<{ previousModel: string; newModel: string } | null>;
  onModelSwitched?: (previousModel: string, newModel: string, hadApproval: boolean) => void;
  executeRetryTurn: (recoveryInput: any[]) => Promise<void>;
  retryCount?: number;
  maxRetries?: number;
}

export class FallbackOrchestrator {
  private _isFallingBack: boolean = false;

  public get isFallingBack(): boolean {
    return this._isFallingBack;
  }

  public async handleFallback(params: FallbackParams): Promise<boolean> {
    if (this._isFallingBack) {
      params.logger?.appendLine('[Forge Agent Fallback] Fallback already in progress; ignoring duplicate attempt.');
      return false;
    }
    this._isFallingBack = true;

    let recoveryInput: any[];
    try {
      const maxRetries = params.maxRetries ?? params.fallbackModels.length;
      const retryCount = params.retryCount ?? 0;
      if (retryCount >= maxRetries) {
        params.logger?.appendLine(`[Forge Agent Fallback] Maximum fallback retries (${maxRetries}) reached; all fallback models exhausted.`);
        return false;
      }

      if (!isRateLimitError(params.reason)) {
        params.logger?.appendLine(`[Forge Agent Fallback] Reason is not a rate limit error; ignoring fallback.`);
        return false;
      }

      const switchFn = params.switchModelFn || switchTrueForgeModel;
      const switched = await switchFn(params.baseUrl, params.agentName, params.fallbackModels, params.logger);
      if (!switched) {
        params.logger?.appendLine('[Forge Agent Fallback] Could not switch to a fallback model.');
        return false;
      }

      const hadApproval = isToolApprovalPayload(params.originalInput);
      params.onModelSwitched?.(switched.previousModel, switched.newModel, hadApproval);

      recoveryInput = constructFallbackRecoveryInput(params.originalInput, switched.newModel);
      params.logger?.appendLine(`[Forge Agent Fallback] Recovery input: ${JSON.stringify(recoveryInput)}`);
    } catch (fallbackErr: any) {
      params.logger?.appendLine(`[Forge Agent Fallback] Error: ${fallbackErr.message}`);
      return false;
    } finally {
      // Release lock so successive failovers across different models are permitted
      this._isFallingBack = false;
    }

    await params.executeRetryTurn(recoveryInput);
    return true;
  }
}

// ---------------------------------------------------------------------------
// 8. Exploration Budget & Editing Progress Tracker
// ---------------------------------------------------------------------------

export interface SessionExplorationState {
  sessionId: string;
  searchCalls: number;
  readCallsBeforeEdit: number;
  listFilesCalls: number;
  cachedSearches: Map<string, string>;
  cachedReads: Map<string, string>;
  proposalsMade: number;
  proposalsApplied: number;
  approvedFiles: Set<string>;
  proposedFiles: Set<string>;
  pendingReviewFiles: Set<string>;
}

export class SessionBudgetManager {
  private _sessions = new Map<string, SessionExplorationState>();
  private _activeSessionId: string = 'default';

  public setActiveSessionId(sessionId: string): void {
    if (sessionId && sessionId.trim()) {
      this._activeSessionId = sessionId.trim();
    }
  }

  public getActiveSessionId(): string {
    return this._activeSessionId;
  }

  public getOrCreate(sessionId?: string): SessionExplorationState {
    const id = (sessionId && sessionId.trim()) ? sessionId.trim() : this._activeSessionId;
    let state = this._sessions.get(id);
    if (!state) {
      state = {
        sessionId: id,
        searchCalls: 0,
        readCallsBeforeEdit: 0,
        listFilesCalls: 0,
        cachedSearches: new Map<string, string>(),
        cachedReads: new Map<string, string>(),
        proposalsMade: 0,
        proposalsApplied: 0,
        approvedFiles: new Set<string>(),
        proposedFiles: new Set<string>(),
        pendingReviewFiles: new Set<string>()
      };
      this._sessions.set(id, state);
    }
    return state;
  }

  public reset(sessionId?: string): void {
    if (sessionId) {
      this._sessions.delete(sessionId);
    } else {
      this._sessions.delete(this._activeSessionId);
    }
  }

  public checkSearchAllowed(query: string, sessionId?: string): {
    allowed: boolean;
    isDuplicate?: boolean;
    cachedResult?: string;
    message?: string;
  } {
    const state = this.getOrCreate(sessionId);
    const normalized = query.trim().toLowerCase();

    if (state.cachedSearches.has(normalized)) {
      return {
        allowed: true,
        isDuplicate: true,
        cachedResult: state.cachedSearches.get(normalized)
      };
    }

    if (state.searchCalls >= 3) {
      return {
        allowed: false,
        message: 'Exploration search budget reached (maximum 3 searches per task). You have already explored the codebase. Use your existing search and read findings to proceed directly to propose_edit.'
      };
    }

    return { allowed: true };
  }

  public recordSearch(query: string, resultText: string, sessionId?: string): void {
    const state = this.getOrCreate(sessionId);
    const normalized = query.trim().toLowerCase();
    if (!state.cachedSearches.has(normalized)) {
      state.searchCalls++;
      state.cachedSearches.set(normalized, resultText);
    }
  }

  public checkReadAllowed(path: string, startLine?: number, endLine?: number, sessionId?: string): {
    allowed: boolean;
    isDuplicate?: boolean;
    cachedResult?: string;
    message?: string;
  } {
    const state = this.getOrCreate(sessionId);
    const normalizedPath = path.trim().replace(/\\/g, '/').toLowerCase();
    const key = `${normalizedPath}:${startLine ?? 1}-${endLine ?? 'all'}`;

    if (state.cachedReads.has(key)) {
      return {
        allowed: true,
        isDuplicate: true,
        cachedResult: state.cachedReads.get(key)
      };
    }

    if (state.proposalsMade === 0 && state.readCallsBeforeEdit >= 4) {
      return {
        allowed: false,
        message: 'Exploration read budget reached (maximum 4 focused reads before proposing edits). You have already examined the relevant code regions. Use your existing findings to proceed directly to propose_edit.'
      };
    }

    return { allowed: true };
  }

  public recordRead(path: string, startLine: number | undefined, endLine: number | undefined, resultText: string, sessionId?: string): void {
    const state = this.getOrCreate(sessionId);
    const normalizedPath = path.trim().replace(/\\/g, '/').toLowerCase();
    const key = `${normalizedPath}:${startLine ?? 1}-${endLine ?? 'all'}`;
    if (!state.cachedReads.has(key)) {
      if (state.proposalsMade === 0) {
        state.readCallsBeforeEdit++;
      }
      state.cachedReads.set(key, resultText);
    }
  }

  public checkListFilesAllowed(sessionId?: string): {
    allowed: boolean;
    message?: string;
  } {
    const state = this.getOrCreate(sessionId);
    if (state.listFilesCalls >= 1) {
      return {
        allowed: false,
        message: 'Exploration list_files budget reached (maximum 1 call per task). Please use search_workspace and read_file to explore specific paths, or proceed to propose_edit.'
      };
    }
    return { allowed: true };
  }

  public recordListFiles(sessionId?: string): void {
    const state = this.getOrCreate(sessionId);
    state.listFilesCalls++;
  }

  public recordProposal(filePath: string, sessionId?: string): void {
    const state = this.getOrCreate(sessionId);
    const norm = filePath.trim().replace(/\\/g, '/');
    if (!state.proposedFiles.has(norm)) {
      state.proposalsMade++;
      state.proposedFiles.add(norm);
    }
    state.pendingReviewFiles.add(norm);
  }

  public recordProposalApplied(filePath: string, sessionId?: string): void {
    const state = this.getOrCreate(sessionId);
    const norm = filePath.trim().replace(/\\/g, '/');
    state.proposalsApplied++;
    state.approvedFiles.add(norm);
    state.pendingReviewFiles.delete(norm);
  }

  public recordProposalRejected(filePath: string, sessionId?: string): void {
    const state = this.getOrCreate(sessionId);
    const norm = filePath.trim().replace(/\\/g, '/');
    state.pendingReviewFiles.delete(norm);
  }

  public clearPendingReview(sessionId?: string): void {
    const state = this.getOrCreate(sessionId);
    state.pendingReviewFiles.clear();
  }

  public canExecuteCommand(sessionId?: string): {
    allowed: boolean;
    message?: string;
  } {
    const state = this.getOrCreate(sessionId);
    if (state.proposalsApplied === 0) {
      return {
        allowed: false,
        message: 'Shell commands and verification tests are only permitted after required edit proposals have been approved and applied. Please use propose_edit to apply changes before running tests.'
      };
    }
    if (state.pendingReviewFiles.size > 0) {
      const pendingList = Array.from(state.pendingReviewFiles).join(', ');
      return {
        allowed: false,
        message: `Shell commands and verification tests are blocked because ${state.pendingReviewFiles.size} edit proposal(s) remain pending review (${pendingList}). All pending edit proposals must be resolved before verification.`
      };
    }
    return { allowed: true };
  }
}

export const globalBudgetManager = new SessionBudgetManager();
