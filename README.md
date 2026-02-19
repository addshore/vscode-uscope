# μScope for Visual Studio Code

## Usage
Start the SEGGER J-Link gdb server, if not running already.
Put some code on the microcontroller that prints via SEGGER RTT.
Press connect, using the default host and port.

Disable or disconnect other external RTT viewers such as the RTT console in Cortex.

![](doc/screenshot.png)

## Development

These steps get you a live development workflow where you can rebuild and run the extension in the Extension Development Host.

1. Open this repository folder in VS Code.
2. Install dependencies:

```bash
npm install
```

3. Build once or run the TypeScript watcher while developing:

```bash
npm run compile      # one-off build
npm run watch        # keep rebuilding as you edit
```

4. Launch the Extension Development Host:

- Press F5 (Run → Start Debugging). A new VS Code window titled "Extension Development Host" will open.
- Make sure you generally have any other μScope extensions installs disabled to avoid conflicts.
- In that host window open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P) and run "View: Show View" → select the `uScope` view (or find it in the Panel area).

5. Use the μScope panel to connect and test. To view runtime logs and errors from the webview, open Help → Toggle Developer Tools in the Extension Development Host.

## Packaging / Release

To create a distributable VSIX package for publishing or manual install:

```bash
npm install
npx vsce package
```

This creates a `.vsix` file which you can install in VS Code via Extensions → ... → "Install from VSIX..." or publish to the Marketplace.

You can also right click the `.vsix` file and select "Install from VSIX" directly.

# LICENSE
This project is licensed under the MIT license, see [LICENSE.txt](LICENSE.txt) for more info.
