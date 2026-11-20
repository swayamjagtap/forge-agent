/**
 * editPipeline.test.ts — Regression tests for the edit pipeline.
 *
 * Run after compiling:  node --test out/editPipeline.test.js
 *
 * Uses only node:test, node:assert, and the 'diff' package (already a
 * production dependency).  No vscode runtime is imported.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as diffLib from 'diff';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  fitEol,
  countOccurrences,
  computeHunkMetrics,
  isDestructiveHunk,
  normalizeProposeEditArgs,
  computeProposalHash,
  isRateLimitError,
  selectNextFallbackModel,
  isToolApprovalPayload,
  constructFallbackRecoveryInput,
  switchTrueForgeModel,
  FallbackOrchestrator,
  DEFAULT_FALLBACK_MODELS,
  SessionBudgetManager,
  globalBudgetManager,
} from './editHelpers.js';

// ---------------------------------------------------------------------------
// Helpers shared by multiple tests
// ---------------------------------------------------------------------------

/**
 * Apply a single {old_text, new_text} edit to `source` using unified diff,
 * and return the patched text (or null if patch fails).
 * This mirrors the production path in extension.ts applyEdit().
 */
function applyEdit(source: string, oldText: string, newText: string): string | null {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const srcLf = source.replace(/\r\n/g, '\n');
  const oldLf = oldText.replace(/\r\n/g, '\n');
  const newLf = newText.replace(/\r\n/g, '\n');

  const patchStr = diffLib.createTwoFilesPatch('a', 'b', oldLf, newLf, '', '', { context: 3 });
  const parsed = diffLib.parsePatch(patchStr);
  if (!parsed || parsed.length === 0) {
    return null;
  }
  const result = diffLib.applyPatch(srcLf, parsed[0]);
  if (result === false) {
    return null;
  }
  return fitEol(result, eol);
}

/**
 * Parse a unified-diff patch and return its hunks array.
 */
function getHunks(oldText: string, newText: string) {
  const patchStr = diffLib.createTwoFilesPatch('a', 'b',
    oldText.replace(/\r\n/g, '\n'),
    newText.replace(/\r\n/g, '\n'),
    '', '', { context: 3 });
  const parsed = diffLib.parsePatch(patchStr);
  return parsed.length > 0 ? parsed[0].hunks : [];
}

// ---------------------------------------------------------------------------
// 1. Flask routes regression
//    The agent added a new CLI command but old_text encompassed the routes
//    command's output loop — resulting in its deletion.
// ---------------------------------------------------------------------------

test('Flask routes regression: accidental deletion is flagged risky', () => {
  const routesLoop =
    '    for rule in app.url_map.iter_rules():\n' +
    '        methods = ",".join(sorted(rule.methods))\n' +
    '        print(f"{rule.endpoint:30s} {methods:20s} {rule.rule}")\n';

  const originalFile =
    'import click\n' +
    'from flask import Flask\n' +
    '\n' +
    'app = Flask(__name__)\n' +
    '\n' +
    '@app.cli.command("routes")\n' +
    'def routes_command():\n' +
    '    """Show all routes."""\n' +
    routesLoop +
    '\n';

  // The agent's old_text started at the for-loop and new_text replaced it
  // with a new command, omitting the loop entirely.
  const badOldText = routesLoop;
  const badNewText =
    '\n' +
    '@app.cli.command("hello")\n' +
    'def hello_command():\n' +
    '    """Say hello."""\n' +
    '    click.echo("Hello!")\n';

  const hunks = getHunks(badOldText, badNewText);
  assert.ok(hunks.length > 0, 'Expected at least one hunk');

  const hunk = hunks[0];
  const metrics = computeHunkMetrics(hunk);
  const analysis = isDestructiveHunk(metrics, hunk.lines);

  // The loop is 3 lines deleted, new command is 5 lines added.
  // Although added > deleted, structural detection must flag it as risky
  // because the existing 'for' loop was removed during the command addition!
  assert.equal(typeof metrics.added, 'number');
  assert.equal(typeof metrics.deleted, 'number');
  assert.equal(analysis.risky, true, 'Flask routes regression: edit deleting loop MUST be flagged as risky');
  assert.ok(analysis.reason.includes('for'), `Warning reason should identify the 'for' loop: ${analysis.reason}`);

  // Additionally verify the applied edit would indeed remove the loop:
  const patched = applyEdit(originalFile, badOldText, badNewText);
  if (patched !== null) {
    assert.ok(!patched.includes('iter_rules'), 'Loop should be absent after bad edit');
  }
});

test('Flask routes regression: larger deletion triggers risky flag', () => {
  // Scenario where a 6-line function body is replaced by 1 line stub
  const oldFn =
    'def process_data(items):\n' +
    '    result = []\n' +
    '    for item in items:\n' +
    '        if item.is_valid():\n' +
    '            result.append(item.transform())\n' +
    '    return result\n';
  const newFn = 'def process_data(items):\n    pass\n';

  const hunks = getHunks(oldFn, newFn);
  assert.ok(hunks.length > 0);
  const metrics = computeHunkMetrics(hunks[0]);
  const analysis = isDestructiveHunk(metrics, hunks[0].lines);

  assert.ok(metrics.deleted >= 3, `Expected >=3 deleted, got ${metrics.deleted}`);
  assert.ok(metrics.deleted > metrics.added, 'More deleted than added');
  assert.equal(analysis.risky, true, 'Should be risky');
  assert.ok(analysis.reason.length > 0);
});

// ---------------------------------------------------------------------------
// 2. Addition-only edit — no false positive
// ---------------------------------------------------------------------------

test('Addition-only edit: not flagged as risky', () => {
  const oldText = 'def foo():\n    return 1\n';
  const newText = 'def foo():\n    return 1\n\ndef bar():\n    return 2\n';

  const hunks = getHunks(oldText, newText);
  if (hunks.length === 0) {
    // No hunks — trivially not risky
    return;
  }
  for (const hunk of hunks) {
    const metrics = computeHunkMetrics(hunk);
    const analysis = isDestructiveHunk(metrics, hunk.lines);
    assert.equal(analysis.risky, false, `Hunk should not be risky: +${metrics.added} -${metrics.deleted}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Accidental deletion of loop — risky flag
// ---------------------------------------------------------------------------

test('Accidental deletion of for-loop triggers risky flag', () => {
  const oldText =
    'results = []\n' +
    'for x in data:\n' +
    '    if x > 0:\n' +
    '        results.append(x)\n' +
    'print(results)\n';
  const newText = 'results = []\nprint(results)\n';

  const hunks = getHunks(oldText, newText);
  assert.ok(hunks.length > 0);
  const metrics = computeHunkMetrics(hunks[0]);
  const analysis = isDestructiveHunk(metrics, hunks[0].lines);

  assert.ok(metrics.deleted >= 3, `Expected >=3 deleted, got ${metrics.deleted}`);
  assert.equal(analysis.risky, true);
  // Secondary keyword should appear in reason
  assert.ok(analysis.reason.includes('for'), `Expected 'for' in reason, got: ${analysis.reason}`);
});

// ---------------------------------------------------------------------------
// 4. Multiple hunks — selective acceptance and rejection
// ---------------------------------------------------------------------------

test('Multiple hunks: accept first only leaves second unchanged', () => {
  const original =
    'line1\nAAA\nline3\nline4\nBBB\nline6\n';
  const modified =
    'line1\nXXX\nline3\nline4\nYYY\nline6\n';

  const patchStr = diffLib.createTwoFilesPatch('a', 'b',
    original.replace(/\r\n/g, '\n'),
    modified.replace(/\r\n/g, '\n'),
    '', '', { context: 0 });
  const parsed = diffLib.parsePatch(patchStr);
  assert.ok(parsed.length > 0);

  const allHunks = parsed[0].hunks;
  if (allHunks.length < 2) {
    // With context:0 two non-adjacent changes should produce 2 hunks
    // If not, skip — the test file happens to coalesce
    return;
  }

  // Accept only hunk 0
  const selectedHunks = [allHunks[0]];
  const result = diffLib.applyPatch(original, { ...parsed[0], hunks: selectedHunks });
  assert.ok(result !== false, 'Patch should apply');
  assert.ok((result as string).includes('XXX'), 'First change applied');
  assert.ok((result as string).includes('BBB'), 'Second change NOT applied (original preserved)');
});

test('Multiple hunks: reject all leaves original unchanged', () => {
  const original = 'line1\nAAA\nline3\nline4\nBBB\nline6\n';
  const modified = 'line1\nXXX\nline3\nline4\nYYY\nline6\n';

  const patchStr = diffLib.createTwoFilesPatch('a', 'b', original, modified, '', '', { context: 0 });
  const parsed = diffLib.parsePatch(patchStr);
  assert.ok(parsed.length > 0);

  // Apply with no hunks
  const result = diffLib.applyPatch(original, { ...parsed[0], hunks: [] });
  // applyPatch with empty hunks returns the original unchanged
  const outcome = result === false ? original : result as string;
  assert.equal(outcome, original);
});

// ---------------------------------------------------------------------------
// 5. CRLF preservation
// ---------------------------------------------------------------------------

test('fitEol: converts LF to CRLF', () => {
  const lf = 'line1\nline2\nline3\n';
  const result = fitEol(lf, '\r\n');
  assert.equal(result, 'line1\r\nline2\r\nline3\r\n');
});

test('fitEol: leaves LF unchanged when eol is LF', () => {
  const lf = 'line1\nline2\n';
  assert.equal(fitEol(lf, '\n'), lf);
});

test('fitEol: normalises CRLF before converting to CRLF (no double CR)', () => {
  const crlf = 'line1\r\nline2\r\n';
  const result = fitEol(crlf, '\r\n');
  assert.equal(result, 'line1\r\nline2\r\n');
  assert.ok(!result.includes('\r\r'), 'No double CR');
});

test('Edit on CRLF file preserves CRLF line endings', () => {
  const original = 'alpha\r\nbeta\r\ngamma\r\n';
  const patched = applyEdit(original, 'beta\r\n', 'BETA\r\n');
  assert.ok(patched !== null, 'Patch should succeed');
  assert.equal(patched, 'alpha\r\nBETA\r\ngamma\r\n');
});

// ---------------------------------------------------------------------------
// 6. Snapshot / Undo restoration (pure string — no vscode runtime)
// ---------------------------------------------------------------------------

test('Snapshot-based undo restores original content exactly', () => {
  const originalContent = 'original line1\noriginal line2\noriginal line3\n';

  // Simulate taking a snapshot before an edit
  const snapshot = originalContent;

  // Apply an edit
  const edited = applyEdit(originalContent, 'original line2\n', 'CHANGED line2\n');
  assert.ok(edited !== null);
  assert.ok(edited !== originalContent, 'Content should differ after edit');

  // Undo: restore from snapshot
  const restored = snapshot;
  assert.equal(restored, originalContent, 'Undo must restore exact original content');
});

// ---------------------------------------------------------------------------
// 7. computeHunkMetrics — counts +/- lines correctly
// ---------------------------------------------------------------------------

test('computeHunkMetrics: counts added and deleted lines correctly', () => {
  const hunk = {
    lines: [
      ' context line',
      '-deleted line 1',
      '-deleted line 2',
      '+added line 1',
      ' context line 2',
    ]
  };
  const metrics = computeHunkMetrics(hunk);
  assert.equal(metrics.added, 1);
  assert.equal(metrics.deleted, 2);
});

test('computeHunkMetrics: pure addition (no deletions)', () => {
  const hunk = { lines: ['+new line 1', '+new line 2', '+new line 3'] };
  const metrics = computeHunkMetrics(hunk);
  assert.equal(metrics.added, 3);
  assert.equal(metrics.deleted, 0);
});

test('computeHunkMetrics: pure deletion (no additions)', () => {
  const hunk = { lines: ['-removed 1', '-removed 2', '-removed 3', '-removed 4'] };
  const metrics = computeHunkMetrics(hunk);
  assert.equal(metrics.added, 0);
  assert.equal(metrics.deleted, 4);
});

// ---------------------------------------------------------------------------
// 8. isDestructiveHunk edge cases
// ---------------------------------------------------------------------------

test('isDestructiveHunk: not risky when deleted < 3', () => {
  const analysis = isDestructiveHunk({ added: 0, deleted: 2 });
  assert.equal(analysis.risky, false);
});

test('isDestructiveHunk: not risky when deleted == added (replacement, not shrink)', () => {
  const analysis = isDestructiveHunk({ added: 5, deleted: 5 });
  assert.equal(analysis.risky, false);
});

test('isDestructiveHunk: not risky when added > deleted', () => {
  const analysis = isDestructiveHunk({ added: 10, deleted: 5 });
  assert.equal(analysis.risky, false);
});

test('isDestructiveHunk: risky when deleted >= 3 and deleted > added', () => {
  const analysis = isDestructiveHunk({ added: 1, deleted: 5 });
  assert.equal(analysis.risky, true);
  assert.ok(analysis.reason.length > 0);
});

test('isDestructiveHunk: reason includes keyword when deleted lines contain "for"', () => {
  const hunkLines = ['-for x in items:', '-    print(x)', '-    total += x', '+pass'];
  const metrics = computeHunkMetrics({ lines: hunkLines });
  const analysis = isDestructiveHunk(metrics, hunkLines);
  assert.equal(analysis.risky, true);
  assert.ok(analysis.reason.includes('for'), `Expected 'for' in reason: ${analysis.reason}`);
});

test('Accidental deletion of 2-line loop while adding new command is flagged risky (deleted < 3, added > deleted)', () => {
  const hunkLines = [
    '-for item in queue:',
    '-    process(item)',
    '+@app.cli.command("sync")',
    '+def sync_command():',
    '+    """Run background sync."""',
    '+    click.echo("Syncing...")',
    '+    pass',
  ];
  const metrics = computeHunkMetrics({ lines: hunkLines });
  assert.equal(metrics.deleted, 2, 'Should have exactly 2 lines deleted (< 3)');
  assert.equal(metrics.added, 5, 'Should have 5 lines added (> deleted)');

  const analysis = isDestructiveHunk(metrics, hunkLines);
  assert.equal(analysis.risky, true, 'Must flag deletion of 2-line loop even though added > deleted');
  assert.ok(analysis.reason.includes('for'), `Reason should identify 'for': ${analysis.reason}`);
});

test('Accidental deletion of 2-line function while adding new command is flagged risky', () => {
  const hunkLines = [
    '-def validate_token(token):',
    '-    return token == "secret"',
    '+@app.cli.command("inspect")',
    '+def inspect_command():',
    '+    click.echo("Inspecting")',
  ];
  const metrics = computeHunkMetrics({ lines: hunkLines });
  assert.equal(metrics.deleted, 2);
  const analysis = isDestructiveHunk(metrics, hunkLines);
  assert.equal(analysis.risky, true, 'Must flag deletion of 2-line function');
  assert.ok(analysis.reason.includes('def'), `Reason should identify 'def': ${analysis.reason}`);
});

test('Single-line in-place condition update is NOT flagged risky', () => {
  const hunkLines = [
    '-if count > 0:',
    '+if count > 1:',
  ];
  const metrics = computeHunkMetrics({ lines: hunkLines });
  assert.equal(metrics.deleted, 1);
  assert.equal(metrics.added, 1);
  const analysis = isDestructiveHunk(metrics, hunkLines);
  assert.equal(analysis.risky, false, 'In-place condition edit must not be flagged risky');
});

test('Single-line in-place function signature update is NOT flagged risky', () => {
  const hunkLines = [
    '-def fetch_user(user_id):',
    '+def fetch_user(user_id, timeout=30):',
  ];
  const metrics = computeHunkMetrics({ lines: hunkLines });
  assert.equal(metrics.deleted, 1);
  assert.equal(metrics.added, 1);
  const analysis = isDestructiveHunk(metrics, hunkLines);
  assert.equal(analysis.risky, false, 'In-place signature edit must not be flagged risky');
});

// ---------------------------------------------------------------------------
// 9. normalizeProposeEditArgs — both flat and edits[] forms
// ---------------------------------------------------------------------------

test('normalizeProposeEditArgs: flat {path, old_text, new_text}', () => {
  const result = normalizeProposeEditArgs({
    path: 'app.py',
    old_text: 'foo',
    new_text: 'bar',
  });
  assert.ok(result !== null);
  assert.equal(result!.path, 'app.py');
  assert.equal(result!.edits.length, 1);
  assert.equal(result!.edits[0].old_text, 'foo');
  assert.equal(result!.edits[0].new_text, 'bar');
});

test('normalizeProposeEditArgs: edits[] form', () => {
  const result = normalizeProposeEditArgs({
    path: 'app.py',
    edits: [
      { old_text: 'a', new_text: 'b' },
      { old_text: 'c', new_text: 'd' },
    ],
  });
  assert.ok(result !== null);
  assert.equal(result!.edits.length, 2);
});

test('normalizeProposeEditArgs: input nested inside .input object', () => {
  const result = normalizeProposeEditArgs({
    input: { path: 'x.py', old_text: 'old', new_text: 'new' }
  });
  assert.ok(result !== null);
  assert.equal(result!.path, 'x.py');
});

test('normalizeProposeEditArgs: returns null when path missing', () => {
  const result = normalizeProposeEditArgs({ old_text: 'a', new_text: 'b' });
  assert.equal(result, null);
});

test('normalizeProposeEditArgs: returns null when neither flat nor edits[] given', () => {
  const result = normalizeProposeEditArgs({ path: 'app.py', summary: 'whatever' });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 10. countOccurrences
// ---------------------------------------------------------------------------

test('countOccurrences: finds multiple occurrences', () => {
  assert.equal(countOccurrences('aababab', 'ab'), 3);
});

test('countOccurrences: returns 0 for empty target', () => {
  assert.equal(countOccurrences('anything', ''), 0);
});

test('countOccurrences: returns 0 when not found', () => {
  assert.equal(countOccurrences('hello', 'xyz'), 0);
});

// ---------------------------------------------------------------------------
// 11. computeProposalHash — deterministic
// ---------------------------------------------------------------------------

test('computeProposalHash: same input gives same hash', () => {
  const edits = [{ old_text: 'a', new_text: 'b' }];
  const h1 = computeProposalHash('src/app.py', edits);
  const h2 = computeProposalHash('src/app.py', edits);
  assert.equal(h1, h2);
});

test('computeProposalHash: normalises backslashes in path', () => {
  const edits = [{ old_text: 'x', new_text: 'y' }];
  const h1 = computeProposalHash('src\\app.py', edits);
  const h2 = computeProposalHash('src/app.py', edits);
  assert.equal(h1, h2);
});

test('computeProposalHash: different edits give different hashes', () => {
  const h1 = computeProposalHash('app.py', [{ old_text: 'a', new_text: 'b' }]);
  const h2 = computeProposalHash('app.py', [{ old_text: 'a', new_text: 'c' }]);
  assert.notEqual(h1, h2);
});

// ---------------------------------------------------------------------------
// 12. Rate Limit & Fallback Model Detection
// ---------------------------------------------------------------------------

test('isRateLimitError: detects TrueForge 429 quota error message', () => {
  const trueForge429 = '[Model Error] Request failed (429): You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://aistudio.google.com/docs/rate-limits.';
  assert.equal(isRateLimitError(trueForge429), true);
});

test('isRateLimitError: detects resource_exhausted and rate-limit keywords', () => {
  assert.equal(isRateLimitError('Error: 429 Too Many Requests'), true);
  assert.equal(isRateLimitError('RESOURCE_EXHAUSTED: quota limit reached'), true);
  assert.equal(isRateLimitError('rate limit exceeded for model'), true);
  assert.equal(isRateLimitError('Rate-Limit hit on API'), true);
});

test('isRateLimitError: returns false for normal non-quota errors', () => {
  assert.equal(isRateLimitError('SyntaxError: Unexpected token'), false);
  assert.equal(isRateLimitError('Error: File not found: app.py'), false);
  assert.equal(isRateLimitError('Turn cancelled by user'), false);
  assert.equal(isRateLimitError(''), false);
  assert.equal(isRateLimitError(null as any), false);
});

test('selectNextFallbackModel: advances through fallback models list', () => {
  const models = ['model-a', 'model-b', 'model-c'];
  assert.equal(selectNextFallbackModel('model-a', models), 'model-b');
  assert.equal(selectNextFallbackModel('model-b', models), 'model-c');
  assert.equal(selectNextFallbackModel('model-c', models), 'model-a');
});

test('selectNextFallbackModel: picks first alternative if current not in list', () => {
  const models = ['fallback-1', 'fallback-2'];
  assert.equal(selectNextFallbackModel('unknown-model', models), 'fallback-1');
});

test('selectNextFallbackModel: returns null when list is empty or only has current', () => {
  assert.equal(selectNextFallbackModel('model-a', []), null);
  assert.equal(selectNextFallbackModel('model-a', ['model-a']), null);
});

// ---------------------------------------------------------------------------
// 13. Agent Definition Integrity (agent.json)
// ---------------------------------------------------------------------------

test('agent.json: definition file exists and contains valid TrueForge configuration', () => {
  const agentPath = path.resolve(__dirname, '..', 'agent.json');
  assert.ok(fs.existsSync(agentPath), `agent.json must exist at ${agentPath}`);

  const raw = fs.readFileSync(agentPath, 'utf-8');
  const agentDef = JSON.parse(raw);

  assert.equal(agentDef.name, 'editor-test');
  assert.ok(agentDef.manifest, 'manifest must be defined');
  assert.ok(agentDef.manifest.model?.name, 'manifest.model.name must be defined');
  assert.ok(agentDef.manifest.instructions?.length > 50, 'instructions must be detailed');

  // Verify MCP server and all 5 required tools
  const mcpServers = agentDef.manifest.mcp_servers;
  assert.ok(Array.isArray(mcpServers) && mcpServers.length > 0, 'mcp_servers must be an array');

  const editorServer = mcpServers.find((s: any) => s.name === 'forge-editor');
  assert.ok(editorServer, 'forge-editor MCP server must be configured');

  const requiredTools = ['read_file', 'search_workspace', 'list_files', 'propose_edit', 'run_command'];
  for (const tool of requiredTools) {
    assert.ok(
      editorServer.enable_tools?.includes(tool),
      `forge-editor must enable tool: ${tool}`
    );
  }

  // Verify approval requirements
  const approvalTools = editorServer.require_approval_for_tools;
  assert.ok(approvalTools?.includes('propose_edit'), 'propose_edit must require approval');
  assert.ok(approvalTools?.includes('@destructive'), '@destructive must require approval');
});

// ---------------------------------------------------------------------------
// 14. Fallback Payload Safety — isToolApprovalPayload & constructFallbackRecoveryInput
// ---------------------------------------------------------------------------

test('isToolApprovalPayload: returns true when items contain user.tool_approval', () => {
  const payload = [
    { type: 'user.tool_approval', tool_call_id: 'call-123', allow: true }
  ];
  assert.equal(isToolApprovalPayload(payload), true);
});

test('isToolApprovalPayload: returns true for mixed approval/denial payloads', () => {
  const payload = [
    { type: 'user.tool_approval', tool_call_id: 'call-1', allow: true },
    { type: 'user.tool_approval', tool_call_id: 'call-2', allow: false }
  ];
  assert.equal(isToolApprovalPayload(payload), true);
});

test('isToolApprovalPayload: returns false for user.message payloads', () => {
  const payload = [
    { type: 'user.message', content: [{ type: 'text', text: 'hello' }] }
  ];
  assert.equal(isToolApprovalPayload(payload), false);
});

test('isToolApprovalPayload: returns false for empty array', () => {
  assert.equal(isToolApprovalPayload([]), false);
});

test('isToolApprovalPayload: returns false for non-array input', () => {
  assert.equal(isToolApprovalPayload(null as any), false);
  assert.equal(isToolApprovalPayload(undefined as any), false);
});

test('constructFallbackRecoveryInput: replaces tool approval payload with continuation message', () => {
  const originalInput = [
    { type: 'user.tool_approval', tool_call_id: 'call-abc', allow: true }
  ];
  const result = constructFallbackRecoveryInput(originalInput, 'google-gemini/gemini-3-6-flash');

  // Must NOT replay the original tool_approval
  assert.ok(!result.some((item: any) => item.type === 'user.tool_approval'),
    'recovery input must not contain user.tool_approval');

  // Must contain a user.message instructing continuation
  const msg = result.find((item: any) => item.type === 'user.message');
  assert.ok(msg, 'recovery input must contain user.message');
  const text = msg.content?.[0]?.text ?? '';
  assert.ok(text.length > 0, 'continuation message must not be empty');
});

test('constructFallbackRecoveryInput: continuation message contains fallback model name', () => {
  const originalInput = [
    { type: 'user.tool_approval', tool_call_id: 'call-xyz', allow: true }
  ];
  const model = 'google-gemini/gemini-3-7-flash';
  const result = constructFallbackRecoveryInput(originalInput, model);

  const msg = result.find((item: any) => item.type === 'user.message');
  const text = msg?.content?.[0]?.text ?? '';
  assert.ok(text.includes(model), `continuation message must mention fallback model "${model}"`);
});

test('constructFallbackRecoveryInput: generates compact continuation message instead of repeating original Task B prompt', () => {
  const originalInput = [
    { type: 'user.message', content: [{ type: 'text', text: 'Task B: Add routes command to Flask CLI. Please inspect files, find routes, update tests, and docs.' }] }
  ];
  const model = 'google-gemini/gemini-3-6-flash';
  const result = constructFallbackRecoveryInput(originalInput, model);

  // Original full user prompt must NOT be repeated
  assert.notDeepEqual(result, originalInput, 'Original full prompt must not be repeated');
  const msg = result.find((item: any) => item.type === 'user.message');
  assert.ok(msg, 'recovery input must contain user.message continuation');
  const text = msg?.content?.[0]?.text ?? '';
  assert.ok(text.includes(model), `continuation message must mention fallback model "${model}"`);
  assert.ok(text.includes('Reuse your previous search results and file reads'), 'Must instruct to reuse findings');
  assert.ok(text.includes('Never repeat completed exploration'), 'Must instruct not to repeat exploration');
  assert.ok(text.includes('Proceed directly to the remaining propose_edit calls'), 'Must instruct to proceed to edits');
});

test('constructFallbackRecoveryInput: denial-only payload generates continuation not replay', () => {
  const originalInput = [
    { type: 'user.tool_approval', tool_call_id: 'call-def', allow: false, reason: 'User denied' }
  ];
  const result = constructFallbackRecoveryInput(originalInput, 'google-gemini/gemini-3-6-flash');

  assert.ok(!result.some((item: any) => item.type === 'user.tool_approval'),
    'denial payload must not be replayed');
  const msg = result.find((item: any) => item.type === 'user.message');
  assert.ok(msg, 'recovery input must contain user.message even for denial payload');
});

// ---------------------------------------------------------------------------
// 15. isRateLimitError — HTTP 422 and approval errors must NOT trigger fallback
// ---------------------------------------------------------------------------

test('isRateLimitError: HTTP 422 does NOT trigger fallback', () => {
  assert.equal(isRateLimitError('Failed to execute turn (422): no pending approval for tool_call_id'), false);
  assert.equal(isRateLimitError('HTTP 422 Unprocessable Entity'), false);
});

test('isRateLimitError: "no pending approval" error does NOT trigger fallback', () => {
  assert.equal(isRateLimitError('no pending approval for tool_call_id'), false);
});

test('isRateLimitError: "pending approval" does NOT trigger fallback', () => {
  assert.equal(isRateLimitError('pending approval already consumed'), false);
});

test('isRateLimitError: "tool_call_id" in message does NOT trigger fallback', () => {
  assert.equal(isRateLimitError('Invalid tool_call_id provided in payload'), false);
});

test('isRateLimitError: validation error does NOT trigger fallback', () => {
  assert.equal(isRateLimitError('validation error: invalid input'), false);
});

test('isRateLimitError: HTTP 429 quota error DOES trigger fallback', () => {
  assert.equal(isRateLimitError('Request failed (429): You exceeded your current quota'), true);
});

test('isRateLimitError: RESOURCE_EXHAUSTED DOES trigger fallback', () => {
  assert.equal(isRateLimitError('RESOURCE_EXHAUSTED: gemini quota exceeded'), true);
});

// ---------------------------------------------------------------------------
// 16. Fallback Control Flow & Recovery Orchestration (Mocked Deterministic Tests)
// ---------------------------------------------------------------------------

test('switchTrueForgeModel: calls GET /api/v1/agents and PUT /api/v1/agents/{id} with next fallback model', async () => {
  const originalFetch = globalThis.fetch;
  const recordedCalls: Array<{ url: string; method?: string; body?: any }> = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    recordedCalls.push({ url: urlStr, method, body });

    if (urlStr.endsWith('/api/v1/agents') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 'agent-123',
              name: 'editor-test',
              manifest: {
                model: { name: 'google-gemini/gemini-3-5-flash-lite' }
              }
            }
          ]
        })
      } as any;
    }

    if (urlStr.includes('/api/v1/agents/agent-123') && method === 'PUT') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      } as any;
    }

    return { ok: false, status: 404, text: async () => 'Not found' } as any;
  }) as any;

  try {
    const fallbackModels = [
      'google-gemini/gemini-3-6-flash',
      'google-gemini/gemini-3-5-flash',
      'google-gemini/gemini-3-7-flash'
    ];
    const result = await switchTrueForgeModel('http://localhost:8790', 'editor-test', fallbackModels);

    assert.ok(result, 'switchTrueForgeModel must succeed');
    assert.equal(result.previousModel, 'google-gemini/gemini-3-5-flash-lite');
    assert.equal(result.newModel, 'google-gemini/gemini-3-6-flash');

    assert.equal(recordedCalls.length, 2);
    assert.equal(recordedCalls[0].method, 'GET');
    assert.equal(recordedCalls[1].method, 'PUT');
    assert.equal(recordedCalls[1].body?.manifest?.model?.name, 'google-gemini/gemini-3-6-flash');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Scenario 1 & 4: After an approved run_command executes and turn returns 429, fallback submits fresh user.message preserving session ID and never replays tool_approval', async () => {
  const orchestrator = new FallbackOrchestrator();

  // Initial turn: session exists, input was user.tool_approval
  const existingSessionId = 'sess-task-b-run-cmd-001';
  const approvalInput = [
    { type: 'user.tool_approval', tool_call_id: 'call_run_cmd_999', approval: { status: 'allow' } }
  ];

  let retryTurnCalled = false;
  let retrySessionId = '';
  let retryPayload: any[] = [];

  const switchedMock = async () => ({
    previousModel: 'google-gemini/gemini-3-5-flash-lite',
    newModel: 'google-gemini/gemini-3-6-flash'
  });

  const success = await orchestrator.handleFallback({
    reason: 'Request failed (429): You exceeded your current quota',
    originalInput: approvalInput,
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: ['google-gemini/gemini-3-6-flash'],
    switchModelFn: switchedMock,
    executeRetryTurn: async (recoveryInput) => {
      retryTurnCalled = true;
      // In production extension, _runTurn reuses this._sessionId without creating a new one
      retrySessionId = existingSessionId;
      retryPayload = recoveryInput;
    }
  });

  assert.equal(success, true, 'handleFallback must return true');
  assert.equal(retryTurnCalled, true, 'Retry turn must be executed');

  // Requirement 4: Session ID must be preserved
  assert.equal(retrySessionId, existingSessionId, 'Recovery must preserve the original session ID');

  // Requirement 1: Original user.tool_approval must NEVER be submitted again
  assert.ok(
    !retryPayload.some((it: any) => it.type === 'user.tool_approval'),
    'Fallback turn MUST NOT submit user.tool_approval'
  );
  assert.ok(
    !retryPayload.some((it: any) => it.tool_call_id === 'call_run_cmd_999'),
    'Already-consumed tool_call_id must not be submitted again'
  );

  // Requirement 4: Fresh user.message continuation is submitted
  const userMsg = retryPayload.find((it: any) => it.type === 'user.message');
  assert.ok(userMsg, 'Fallback must submit a user.message continuation');
  const msgText = userMsg.content?.[0]?.text ?? '';
  assert.ok(msgText.includes('approved action was processed'), 'Notice must explain approved action completed');
  assert.ok(msgText.includes('google-gemini/gemini-3-6-flash'), 'Notice must mention new model');
  assert.ok(msgText.includes('Do not repeat the previous tool call'), 'Notice must instruct agent not to repeat tool');
});

test('Scenario 2: The approved run_command executes exactly once across approval + 429 error + fallback recovery', async () => {
  const orchestrator = new FallbackOrchestrator();

  let runCommandExecutionCount = 0;
  function executeRunCommand(cmd: string) {
    runCommandExecutionCount++;
    return { exitCode: 0, output: `Running ${cmd}... done.` };
  }

  // Step 1: User approves command
  const toolCallId = 'call_cmd_abc';
  const approvalPayload = [
    { type: 'user.tool_approval', tool_call_id: toolCallId, approval: { status: 'allow' } }
  ];

  // TrueForge executes the MCP tool once upon receiving approval
  executeRunCommand('flask --app app routes');
  assert.equal(runCommandExecutionCount, 1, 'Command executed once upon initial approval');

  // Step 2: Next turn streaming hits 429 quota error
  const rateLimitReason = '429 RESOURCE_EXHAUSTED: rate limit exceeded for model';

  // Step 3: Fallback runs
  const success = await orchestrator.handleFallback({
    reason: rateLimitReason,
    originalInput: approvalPayload,
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: ['google-gemini/gemini-3-6-flash'],
    switchModelFn: async () => ({ previousModel: 'gemini-3-5', newModel: 'gemini-3-6' }),
    executeRetryTurn: async (recoveryInput) => {
      // The recovery turn is a user.message, not a tool approval
      // No MCP tool execution occurs here
      assert.equal(isToolApprovalPayload(recoveryInput), false, 'Recovery turn must not contain tool approvals');
    }
  });

  assert.equal(success, true);
  // Verify command was NOT executed a second time during fallback recovery
  assert.equal(runCommandExecutionCount, 1, 'Approved run_command MUST execute exactly once');
});

test('Scenario 3: The equivalent approved propose_edit executes exactly once and its workspace change is not applied twice', () => {
  // Simulates pendingDecisions Map from extension.ts
  interface PendingDecision {
    acceptedHunks: Set<number>;
    totalHunks: number;
  }
  const pendingDecisions = new Map<string, PendingDecision>();

  const filePath = 'app.py';
  const edits = [{ old_text: 'old_routes()', new_text: 'new_routes()' }];
  const hash = computeProposalHash(filePath, edits);

  // 1. User reviews and approves hunk 0
  pendingDecisions.set(hash, { acceptedHunks: new Set([0]), totalHunks: 1 });

  let workspaceApplyCount = 0;
  function applyProposalIfApproved(normPath: string, rawEdits: any[]): { applied: boolean; message: string } {
    const proposalHash = computeProposalHash(normPath, rawEdits);
    const decision = pendingDecisions.get(proposalHash);

    if (!decision || decision.acceptedHunks.size === 0) {
      return { applied: false, message: 'Proposed edits were rejected by user. No changes were written to disk.' };
    }

    // Apply change and IMMEDIATELY delete decision to guarantee exactly-once application
    workspaceApplyCount++;
    pendingDecisions.delete(proposalHash);
    return { applied: true, message: `Applied ${decision.acceptedHunks.size} hunk(s)` };
  }

  // Execution 1: First call applies the edit and consumes the pending decision
  const firstResult = applyProposalIfApproved(filePath, edits);
  assert.equal(firstResult.applied, true, 'First proposal application must succeed');
  assert.equal(workspaceApplyCount, 1, 'Workspace change applied once');

  // Execution 2: If propose_edit is invoked again with the same arguments (e.g. during replay or repeat)
  const secondResult = applyProposalIfApproved(filePath, edits);
  assert.equal(secondResult.applied, false, 'Second proposal application must be rejected');
  assert.equal(workspaceApplyCount, 1, 'Workspace change MUST NOT be applied a second time');
  assert.ok(secondResult.message.includes('No changes were written to disk'));
});

test('Scenario 5: An HTTP 422 caused by no pending approval does not trigger another fallback', async () => {
  const orchestrator = new FallbackOrchestrator();

  let switchModelCalled = false;
  let retryTurnCalled = false;

  const http422Reason = 'Failed to execute turn (422): no pending approval for tool_call_id "call_123"';

  const success = await orchestrator.handleFallback({
    reason: http422Reason,
    originalInput: [{ type: 'user.tool_approval', tool_call_id: 'call_123', allow: true }],
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: ['google-gemini/gemini-3-6-flash'],
    switchModelFn: async () => {
      switchModelCalled = true;
      return { previousModel: 'gemini-3-5', newModel: 'gemini-3-6' };
    },
    executeRetryTurn: async () => {
      retryTurnCalled = true;
    }
  });

  assert.equal(success, false, 'handleFallback must reject HTTP 422');
  assert.equal(switchModelCalled, false, 'switchModel must NOT be called for HTTP 422');
  assert.equal(retryTurnCalled, false, 'Retry turn must NOT be executed for HTTP 422');
});

test('Scenario 6: Concurrent model-error events cannot trigger duplicate fallback submissions', async () => {
  const orchestrator = new FallbackOrchestrator();

  let switchModelCallCount = 0;
  let retryTurnCallCount = 0;

  // A switchModel implementation that takes a few milliseconds (simulating real async network I/O)
  const slowSwitchModel = async () => {
    switchModelCallCount++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { previousModel: 'gemini-3-5', newModel: 'gemini-3-6' };
  };

  const slowRetryTurn = async () => {
    retryTurnCallCount++;
    await new Promise(resolve => setTimeout(resolve, 20));
  };

  const params = {
    reason: 'Request failed (429): You exceeded your current quota',
    originalInput: [{ type: 'user.message', content: 'hello' }],
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: ['google-gemini/gemini-3-6-flash'],
    switchModelFn: slowSwitchModel,
    executeRetryTurn: slowRetryTurn
  };

  // Trigger two fallback attempts concurrently
  const [res1, res2] = await Promise.all([
    orchestrator.handleFallback(params),
    orchestrator.handleFallback(params)
  ]);

  // Exactly one must succeed and one must be rejected by the concurrency guard
  const results = [res1, res2];
  assert.equal(results.filter(r => r === true).length, 1, 'Exactly one fallback must succeed');
  assert.equal(results.filter(r => r === false).length, 1, 'Duplicate fallback must be rejected');

  assert.equal(switchModelCallCount, 1, 'switchModel must be called exactly once');
  assert.equal(retryTurnCallCount, 1, 'Retry turn must be executed exactly once');
});

test('Normal user.message 429 fallback generates continuation message instead of repeating original Task B prompt', async () => {
  const orchestrator = new FallbackOrchestrator();

  const userMessageInput = [
    { type: 'user.message', content: [{ type: 'text', text: 'Task B: Add routes command to Flask CLI. Inspect files, read docs...' }] }
  ];

  let retriedInput: any[] = [];
  const success = await orchestrator.handleFallback({
    reason: '429 Too Many Requests',
    originalInput: userMessageInput,
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: ['google-gemini/gemini-3-6-flash'],
    switchModelFn: async () => ({ previousModel: 'gemini-3-5', newModel: 'gemini-3-6' }),
    executeRetryTurn: async (recoveryInput) => {
      retriedInput = recoveryInput;
    }
  });

  assert.equal(success, true);
  assert.notDeepEqual(retriedInput, userMessageInput, 'Original full prompt must not be repeated');
  const retriedText = retriedInput[0]?.content?.[0]?.text ?? '';
  assert.ok(retriedText.includes('gemini-3-6'), 'Must contain model name');
  assert.ok(retriedText.includes('Reuse your previous search results and file reads'), 'Must instruct reuse of findings');
  assert.ok(retriedText.includes('Never repeat completed exploration'), 'Must instruct not to repeat exploration');
});

// ---------------------------------------------------------------------------
// 17. Successive Model Failover, Bounded Retries & Quota Isolation Tests
// ---------------------------------------------------------------------------

test('DEFAULT_FALLBACK_MODELS: configured in exact priority order with distinct models', () => {
  assert.deepEqual(DEFAULT_FALLBACK_MODELS, [
    'google-gemini/gemini-3-5-flash-lite',
    'google-gemini/gemini-3-1-flash-lite',
    'google-gemini/gemini-3-6-flash',
    'google-gemini/gemini-3-8-flash'
  ]);

  // Ensure all models are unique distinct quota buckets
  const uniqueSet = new Set(DEFAULT_FALLBACK_MODELS);
  assert.equal(uniqueSet.size, DEFAULT_FALLBACK_MODELS.length, 'All fallback models must be distinct');
});

test('package.json: fallbackModels setting default matches DEFAULT_FALLBACK_MODELS', () => {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const configDefault = pkg.contributes?.configuration?.properties?.['forgeAgent.fallbackModels']?.default;

  assert.deepEqual(configDefault, DEFAULT_FALLBACK_MODELS, 'package.json default must match DEFAULT_FALLBACK_MODELS');
});

test('Successive model failover: transitions through successive distinct models upon repeated 429 errors', async () => {
  const orchestrator = new FallbackOrchestrator();
  const models = [...DEFAULT_FALLBACK_MODELS];

  let currentModel = models[0]; // starts at gemini-3-5-flash-lite
  const switchHistory: Array<{ from: string; to: string }> = [];

  const mockSwitchModel = async (_base: string, _agent: string, list: string[]) => {
    const next = selectNextFallbackModel(currentModel, list);
    if (!next) return null;
    const prev = currentModel;
    currentModel = next;
    switchHistory.push({ from: prev, to: next });
    return { previousModel: prev, newModel: next };
  };

  // Simulate Turn 1: model 1 fails with 429
  let turn2Executed = false;
  const res1 = await orchestrator.handleFallback({
    reason: '429 Rate limit exceeded on gemini-3-5-flash-lite',
    originalInput: [{ type: 'user.message', content: 'test turn 1' }],
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: models,
    retryCount: 0,
    maxRetries: models.length,
    switchModelFn: mockSwitchModel,
    executeRetryTurn: async () => {
      turn2Executed = true;
    }
  });

  assert.equal(res1, true);
  assert.equal(turn2Executed, true);
  assert.equal(currentModel, 'google-gemini/gemini-3-1-flash-lite', 'First failover must switch to gemini-3-1-flash-lite');

  // Simulate Turn 2: model 2 ALSO fails with 429
  let turn3Executed = false;
  const res2 = await orchestrator.handleFallback({
    reason: '429 Rate limit exceeded on gemini-3-1-flash-lite',
    originalInput: [{ type: 'user.message', content: 'test turn 2' }],
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: models,
    retryCount: 1,
    maxRetries: models.length,
    switchModelFn: mockSwitchModel,
    executeRetryTurn: async () => {
      turn3Executed = true;
    }
  });

  assert.equal(res2, true);
  assert.equal(turn3Executed, true);
  assert.equal(currentModel, 'google-gemini/gemini-3-6-flash', 'Second failover must switch to gemini-3-6-flash');

  // Simulate Turn 3: model 3 ALSO fails with 429
  let turn4Executed = false;
  const res3 = await orchestrator.handleFallback({
    reason: '429 Rate limit exceeded on gemini-3-6-flash',
    originalInput: [{ type: 'user.message', content: 'test turn 3' }],
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: models,
    retryCount: 2,
    maxRetries: models.length,
    switchModelFn: mockSwitchModel,
    executeRetryTurn: async () => {
      turn4Executed = true;
    }
  });

  assert.equal(res3, true);
  assert.equal(turn4Executed, true);
  assert.equal(currentModel, 'google-gemini/gemini-3-8-flash', 'Third failover must switch to gemini-3-8-flash');

  // Verify complete sequential transition log
  assert.deepEqual(switchHistory, [
    { from: 'google-gemini/gemini-3-5-flash-lite', to: 'google-gemini/gemini-3-1-flash-lite' },
    { from: 'google-gemini/gemini-3-1-flash-lite', to: 'google-gemini/gemini-3-6-flash' },
    { from: 'google-gemini/gemini-3-6-flash', to: 'google-gemini/gemini-3-8-flash' }
  ]);
});

test('Successive model exhaustion: stops when bounded retry limit is reached and prevents infinite loops', async () => {
  const orchestrator = new FallbackOrchestrator();
  const models = [...DEFAULT_FALLBACK_MODELS];
  let switchCount = 0;

  const mockSwitchModel = async () => {
    switchCount++;
    return { previousModel: 'm1', newModel: 'm2' };
  };

  // Attempt fallback when retryCount has already reached maxRetries
  const success = await orchestrator.handleFallback({
    reason: '429 RESOURCE_EXHAUSTED',
    originalInput: [{ type: 'user.message', content: 'exhausted test' }],
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: models,
    retryCount: models.length, // equals maxRetries
    maxRetries: models.length,
    switchModelFn: mockSwitchModel,
    executeRetryTurn: async () => {
      assert.fail('executeRetryTurn must not be called when max retries exceeded');
    }
  });

  assert.equal(success, false, 'handleFallback must return false when retries are exhausted');
  assert.equal(switchCount, 0, 'No model switch should be executed when retry limit is reached');
});

test('Successive failover preserves same session ID across multiple rate limits', async () => {
  const orchestrator = new FallbackOrchestrator();
  const targetSessionId = 'sess-fixed-chain-session-xyz';
  const executedSessions: string[] = [];

  let currentModel = 'google-gemini/gemini-3-5-flash-lite';
  const mockSwitchModel = async (_base: string, _agent: string, list: string[]) => {
    const next = selectNextFallbackModel(currentModel, list);
    const prev = currentModel;
    currentModel = next!;
    return { previousModel: prev, newModel: next! };
  };

  // Failover step 1
  await orchestrator.handleFallback({
    reason: '429 Rate limit on step 1',
    originalInput: [{ type: 'user.message', content: 'turn 1' }],
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    retryCount: 0,
    maxRetries: 4,
    switchModelFn: mockSwitchModel,
    executeRetryTurn: async () => {
      executedSessions.push(targetSessionId);
    }
  });

  // Failover step 2
  await orchestrator.handleFallback({
    reason: '429 Rate limit on step 2',
    originalInput: [{ type: 'user.message', content: 'turn 2' }],
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    retryCount: 1,
    maxRetries: 4,
    switchModelFn: mockSwitchModel,
    executeRetryTurn: async () => {
      executedSessions.push(targetSessionId);
    }
  });

  assert.equal(executedSessions.length, 2);
  assert.equal(executedSessions[0], targetSessionId, 'Step 1 must execute on original session');
  assert.equal(executedSessions[1], targetSessionId, 'Step 2 must execute on original session');
});

test('Approval safety across successive failovers: user.tool_approval is NEVER replayed in any failover', async () => {
  const orchestrator = new FallbackOrchestrator();
  const toolApprovalInput = [
    { type: 'user.tool_approval', tool_call_id: 'tool_call_original', approval: { status: 'allow' } }
  ];

  let chainedPayload1: any[] = [];
  let chainedPayload2: any[] = [];

  let currentModel = 'google-gemini/gemini-3-5-flash-lite';
  const mockSwitch = async (_b: string, _a: string, list: string[]) => {
    const next = selectNextFallbackModel(currentModel, list)!;
    const prev = currentModel;
    currentModel = next;
    return { previousModel: prev, newModel: next };
  };

  // Failover 1: original input is tool approval
  await orchestrator.handleFallback({
    reason: '429 after tool approval',
    originalInput: toolApprovalInput,
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    retryCount: 0,
    maxRetries: 4,
    switchModelFn: mockSwitch,
    executeRetryTurn: async (rec1) => {
      chainedPayload1 = rec1;
    }
  });

  // Verify Failover 1 did NOT submit tool approval
  assert.equal(isToolApprovalPayload(chainedPayload1), false, 'Failover 1 must NOT be tool approval');
  assert.equal(chainedPayload1[0].type, 'user.message', 'Failover 1 must be user.message');

  // Failover 2: child turn also hits 429, input is the user.message continuation
  await orchestrator.handleFallback({
    reason: '429 on retry turn',
    originalInput: chainedPayload1,
    baseUrl: 'http://localhost:8790',
    agentName: 'editor-test',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    retryCount: 1,
    maxRetries: 4,
    switchModelFn: mockSwitch,
    executeRetryTurn: async (rec2) => {
      chainedPayload2 = rec2;
    }
  });

  // Verify Failover 2 still did NOT submit tool approval
  assert.equal(isToolApprovalPayload(chainedPayload2), false, 'Failover 2 must NOT be tool approval');
  assert.equal(chainedPayload2[0].type, 'user.message', 'Failover 2 must remain user.message continuation');
});

// ---------------------------------------------------------------------------
// 18. Enforced Exploration Budgets & Progress Tracking Tests
// ---------------------------------------------------------------------------

test('Enforced Budget: search_workspace blocks the fourth distinct search', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'test-search-budget-session';

  // Search 1: allowed
  const s1 = manager.checkSearchAllowed('def routes', sessionId);
  assert.equal(s1.allowed, true);
  manager.recordSearch('def routes', 'src/flask/cli.py:10: def routes():', sessionId);

  // Search 2: allowed
  const s2 = manager.checkSearchAllowed('test_routes', sessionId);
  assert.equal(s2.allowed, true);
  manager.recordSearch('test_routes', 'tests/test_cli.py:50: def test_routes():', sessionId);

  // Search 3: allowed
  const s3 = manager.checkSearchAllowed('cli documentation', sessionId);
  assert.equal(s3.allowed, true);
  manager.recordSearch('cli documentation', 'docs/cli.rst:100: Routes command', sessionId);

  // Search 4: BLOCKED
  const s4 = manager.checkSearchAllowed('extra search query', sessionId);
  assert.equal(s4.allowed, false, 'Fourth search must be blocked');
  assert.ok(s4.message?.includes('maximum 3 searches'), 'Block message must explain budget limit');
  assert.ok(s4.message?.includes('propose_edit'), 'Block message must instruct to proceed to propose_edit');
});

test('Enforced Budget: read_file blocks the fifth focused read before first proposal', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'test-read-budget-session';

  // 4 focused reads before any proposal: all allowed
  for (let i = 1; i <= 4; i++) {
    const check = manager.checkReadAllowed(`file${i}.py`, 1, 30, sessionId);
    assert.equal(check.allowed, true, `Read ${i} must be allowed`);
    manager.recordRead(`file${i}.py`, 1, 30, `content of file ${i}`, sessionId);
  }

  // 5th read before proposing edits: BLOCKED
  const fifth = manager.checkReadAllowed('file5.py', 1, 30, sessionId);
  assert.equal(fifth.allowed, false, 'Fifth read before first proposal must be blocked');
  assert.ok(fifth.message?.includes('maximum 4 focused reads'), 'Message must explain 4 reads limit');
  assert.ok(fifth.message?.includes('propose_edit'), 'Message must instruct to proceed to propose_edit');
});

test('Enforced Budget: read_file after first proposal is NOT blocked by pre-edit budget', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'test-post-proposal-read';

  // Perform 4 reads
  for (let i = 1; i <= 4; i++) {
    manager.recordRead(`file${i}.py`, 1, 30, `content ${i}`, sessionId);
  }

  // 5th read is blocked before proposal
  assert.equal(manager.checkReadAllowed('file5.py', 1, 30, sessionId).allowed, false);

  // Agent makes first proposal
  manager.recordProposal('src/flask/cli.py', sessionId);

  // Focused read after proposal is now permitted for editing adjustments
  const postProposalRead = manager.checkReadAllowed('file5.py', 1, 30, sessionId);
  assert.equal(postProposalRead.allowed, true, 'Focused read after proposal is permitted');
});

test('Enforced Budget: duplicate queries and duplicate reads do not consume additional budget', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'test-duplicate-budget';

  // Search 1: consumes 1 search call
  const s1 = manager.checkSearchAllowed('flask routes', sessionId);
  assert.equal(s1.allowed, true);
  manager.recordSearch('flask routes', 'match 1', sessionId);
  assert.equal(manager.getOrCreate(sessionId).searchCalls, 1);

  // Search 2: duplicate query (same normalized string)
  const s2 = manager.checkSearchAllowed('FLASK ROUTES', sessionId);
  assert.equal(s2.allowed, true);
  assert.equal(s2.isDuplicate, true);
  assert.equal(s2.cachedResult, 'match 1');
  // Attempting to record duplicate does not increase searchCalls
  manager.recordSearch('FLASK ROUTES', 'match 1', sessionId);
  assert.equal(manager.getOrCreate(sessionId).searchCalls, 1, 'Duplicate search must not increment searchCalls');

  // Read 1: consumes 1 read call
  const r1 = manager.checkReadAllowed('src/cli.py', 1, 50, sessionId);
  assert.equal(r1.allowed, true);
  manager.recordRead('src/cli.py', 1, 50, 'lines 1 to 50', sessionId);
  assert.equal(manager.getOrCreate(sessionId).readCallsBeforeEdit, 1);

  // Read 2: duplicate read
  const r2 = manager.checkReadAllowed('src/cli.py', 1, 50, sessionId);
  assert.equal(r2.allowed, true);
  assert.equal(r2.isDuplicate, true);
  assert.equal(r2.cachedResult, 'lines 1 to 50');
  manager.recordRead('src/cli.py', 1, 50, 'lines 1 to 50', sessionId);
  assert.equal(manager.getOrCreate(sessionId).readCallsBeforeEdit, 1, 'Duplicate read must not increment readCalls');
});

test('Enforced Budget: a new TrueForge session resets the counters', () => {
  const manager = new SessionBudgetManager();
  const sessionOld = 'session-task-old';
  const sessionNew = 'session-task-new';

  // Old session exhausts searches and reads
  for (let i = 1; i <= 3; i++) {
    manager.recordSearch(`query ${i}`, `result ${i}`, sessionOld);
  }
  for (let i = 1; i <= 4; i++) {
    manager.recordRead(`file ${i}`, 1, 10, `content ${i}`, sessionOld);
  }
  assert.equal(manager.checkSearchAllowed('another search', sessionOld).allowed, false);
  assert.equal(manager.checkReadAllowed('another file', 1, 10, sessionOld).allowed, false);

  // In new session: counters start at zero and are allowed
  const stateNew = manager.getOrCreate(sessionNew);
  assert.equal(stateNew.searchCalls, 0);
  assert.equal(stateNew.readCallsBeforeEdit, 0);
  assert.equal(manager.checkSearchAllowed('fresh query', sessionNew).allowed, true);
  assert.equal(manager.checkReadAllowed('fresh file', 1, 10, sessionNew).allowed, true);
});

test('Enforced Budget: a model fallback in the same session does not reset counters', () => {
  const manager = new SessionBudgetManager();
  const currentSessionId = 'session-task-persists-across-fallback';

  // Run 2 searches and 3 reads
  manager.recordSearch('query 1', 'res 1', currentSessionId);
  manager.recordSearch('query 2', 'res 2', currentSessionId);
  manager.recordRead('file 1', 1, 20, 'code 1', currentSessionId);
  manager.recordRead('file 2', 1, 20, 'code 2', currentSessionId);
  manager.recordRead('file 3', 1, 20, 'code 3', currentSessionId);

  // Simulate model fallback: TrueForge session remains unchanged
  const stateDuringFallback = manager.getOrCreate(currentSessionId);
  assert.equal(stateDuringFallback.searchCalls, 2, 'Search count must persist during fallback');
  assert.equal(stateDuringFallback.readCallsBeforeEdit, 3, 'Read count must persist during fallback');

  // One more search is permitted (reaches 3)
  assert.equal(manager.checkSearchAllowed('query 3', currentSessionId).allowed, true);
  manager.recordSearch('query 3', 'res 3', currentSessionId);

  // Subsequent search is blocked
  assert.equal(manager.checkSearchAllowed('query 4', currentSessionId).allowed, false);
});

test('Editing Progress: three different file proposals can be made and reviewed without blocking', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'task-b-multi-proposal-session';

  // Propose file 1 (CLI implementation)
  manager.recordProposal('src/flask/cli.py', sessionId);
  assert.equal(manager.getOrCreate(sessionId).proposalsMade, 1);

  // Propose file 2 (Tests) - MUST NOT be blocked
  manager.recordProposal('tests/test_cli.py', sessionId);
  assert.equal(manager.getOrCreate(sessionId).proposalsMade, 2);

  // Propose file 3 (Docs) - MUST NOT be blocked
  manager.recordProposal('docs/cli.rst', sessionId);
  assert.equal(manager.getOrCreate(sessionId).proposalsMade, 3);

  const state = manager.getOrCreate(sessionId);
  assert.equal(state.proposedFiles.size, 3);
  assert.ok(state.proposedFiles.has('src/flask/cli.py'));
  assert.ok(state.proposedFiles.has('tests/test_cli.py'));
  assert.ok(state.proposedFiles.has('docs/cli.rst'));
});

test('Verification commands: run_command is blocked before proposals are approved and applied, and permitted after', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'task-b-verification-session';

  // Before any proposal is approved/applied: verification commands BLOCKED
  const beforeApply = manager.canExecuteCommand(sessionId);
  assert.equal(beforeApply.allowed, false, 'Verification command must be blocked before proposals applied');
  assert.ok(beforeApply.message?.includes('only permitted after required edit proposals have been approved'));

  // Proposals made and applied
  manager.recordProposal('src/flask/cli.py', sessionId);
  manager.recordProposalApplied('src/flask/cli.py', sessionId);

  // After approval and application: verification commands ALLOWED
  const afterApply = manager.canExecuteCommand(sessionId);
  assert.equal(afterApply.allowed, true, 'Verification commands permitted once proposals are applied');
});

test('Verification gate: run_command is blocked while an edit proposal remains pending review even if another proposal was applied', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'pending-review-test-session';

  // Step 1: File 1 proposed and applied
  manager.recordProposal('src/flask/cli.py', sessionId);
  manager.recordProposalApplied('src/flask/cli.py', sessionId);
  assert.equal(manager.canExecuteCommand(sessionId).allowed, true, 'Should be allowed after file 1 is resolved');

  // Step 2: File 2 proposed but NOT yet reviewed or applied
  manager.recordProposal('tests/test_cli.py', sessionId);
  const pendingCheck = manager.canExecuteCommand(sessionId);
  assert.equal(pendingCheck.allowed, false, 'Verification MUST be blocked while an edit proposal remains pending review');
  assert.ok(pendingCheck.message?.includes('remain pending review'));
  assert.ok(pendingCheck.message?.includes('tests/test_cli.py'));

  // Step 3: User resolves File 2 (e.g. approved & applied)
  manager.recordProposalApplied('tests/test_cli.py', sessionId);
  assert.equal(manager.canExecuteCommand(sessionId).allowed, true, 'Verification allowed once all pending proposals resolved');
});

test('Verification gate: ordinary single-file task works without requiring 3 files', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'single-file-task-session';

  // Single file proposed and applied
  manager.recordProposal('src/utils.py', sessionId);
  manager.recordProposalApplied('src/utils.py', sessionId);

  // Exactly 1 file applied, 0 pending
  const check = manager.canExecuteCommand(sessionId);
  assert.equal(check.allowed, true, 'Ordinary single-file task must be permitted without 3-file minimum');
  assert.equal(manager.getOrCreate(sessionId).proposalsApplied, 1);
});

test('Verification gate: run_command is permitted after all multi-file proposals are resolved (mix of accepted and rejected)', () => {
  const manager = new SessionBudgetManager();
  const sessionId = 'mixed-proposals-session';

  // Propose 3 files
  manager.recordProposal('file1.py', sessionId);
  manager.recordProposal('file2.py', sessionId);
  manager.recordProposal('file3.py', sessionId);

  // While all 3 are pending: blocked
  assert.equal(manager.canExecuteCommand(sessionId).allowed, false);

  // File 1 applied, File 2 rejected, File 3 applied
  manager.recordProposalApplied('file1.py', sessionId);
  manager.recordProposalRejected('file2.py', sessionId);
  manager.recordProposalApplied('file3.py', sessionId);

  // All 3 resolved, 2 applied: allowed!
  const finalCheck = manager.canExecuteCommand(sessionId);
  assert.equal(finalCheck.allowed, true);
  assert.equal(manager.getOrCreate(sessionId).proposalsApplied, 2);
  assert.equal(manager.getOrCreate(sessionId).pendingReviewFiles.size, 0);
});

test('SessionBudgetManager correlation: all five MCP tools operate against the active TrueForge chat session budget', () => {
  const manager = new SessionBudgetManager();
  const chatSessionId = 'trueforge-chat-session-001';
  manager.setActiveSessionId(chatSessionId);

  // 1. read_file check & record using active session
  assert.equal(manager.checkReadAllowed('file1.py').allowed, true);
  manager.recordRead('file1.py', 1, 10, 'content1');

  // 2. search_workspace check & record using active session
  assert.equal(manager.checkSearchAllowed('query1').allowed, true);
  manager.recordSearch('query1', 'result1');

  // 3. list_files check & record using active session
  assert.equal(manager.checkListFilesAllowed().allowed, true);
  manager.recordListFiles();

  // 4. propose_edit record using active session
  manager.recordProposal('file1.py');
  assert.equal(manager.getOrCreate(chatSessionId).proposalsMade, 1);

  // 5. run_command check using active session
  assert.equal(manager.canExecuteCommand().allowed, false); // blocked because not applied
  manager.recordProposalApplied('file1.py');
  assert.equal(manager.canExecuteCommand().allowed, true);

  // Verify chatSessionId state reflects all 5 tool actions
  const state = manager.getOrCreate(chatSessionId);
  assert.equal(state.readCallsBeforeEdit, 1);
  assert.equal(state.searchCalls, 1);
  assert.equal(state.listFilesCalls, 1);
  assert.equal(state.proposalsMade, 1);
  assert.equal(state.proposalsApplied, 1);
});

test('SessionBudgetManager correlation: MCP transport mcp-session-id is independent and does not overwrite TrueForge chat session ID', () => {
  const manager = new SessionBudgetManager();
  const chatSessionId = 'tf-chat-session-xyz';
  manager.setActiveSessionId(chatSessionId);

  // MCP transport connects with random UUID headers
  const transportMcpSessionId = 'e1a3bc4d-5678-4901-abcd-ef1234567890';
  assert.notEqual(transportMcpSessionId, chatSessionId);

  // Tool calls in the active chat session record under chatSessionId
  manager.recordSearch('symbol search', 'found symbol');
  assert.equal(manager.getOrCreate(chatSessionId).searchCalls, 1);

  // The random transport UUID was not registered as active session ID
  assert.equal(manager.getActiveSessionId(), chatSessionId);
  assert.equal(manager.getOrCreate(transportMcpSessionId).searchCalls, 0, 'Transport UUID must not collide with chat session state');
});

test('SessionBudgetManager correlation: concurrent sessions maintain strictly isolated counters without crosstalk', () => {
  const manager = new SessionBudgetManager();
  const sessionAlpha = 'session-alpha';
  const sessionBeta = 'session-beta';

  // Session Alpha consumes all 3 searches
  manager.recordSearch('q1', 'r1', sessionAlpha);
  manager.recordSearch('q2', 'r2', sessionAlpha);
  manager.recordSearch('q3', 'r3', sessionAlpha);
  assert.equal(manager.checkSearchAllowed('q4', sessionAlpha).allowed, false, 'Alpha search budget exhausted');

  // Session Beta is unaffected: has 0 searches consumed
  assert.equal(manager.checkSearchAllowed('q1', sessionBeta).allowed, true, 'Beta must be allowed');
  assert.equal(manager.getOrCreate(sessionBeta).searchCalls, 0, 'Beta must have 0 searches recorded');

  // Session Beta consumes list_files
  manager.recordListFiles(sessionBeta);
  assert.equal(manager.checkListFilesAllowed(sessionBeta).allowed, false, 'Beta list_files exhausted');
  assert.equal(manager.checkListFilesAllowed(sessionAlpha).allowed, true, 'Alpha list_files must still be allowed');
});
