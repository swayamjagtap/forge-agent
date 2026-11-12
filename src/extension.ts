import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('forge-agent.hello', () => {
    vscode.window.showInformationMessage('Hello from Forge Agent');
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

