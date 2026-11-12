# forge-agent

A minimal Visual Studio Code extension built in TypeScript.

## Features

- **Forge Agent: Hello**: Displays an information message saying `"Hello from Forge Agent"`.

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

4. In the Extension Development Host window, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), type and run:
   ```
   Forge Agent: Hello
   ```
   You will see an information message in the lower right corner:
   `Hello from Forge Agent`

