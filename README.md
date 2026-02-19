# μScope for Visual Studio Code

## Usage
Start the SEGGER J-Link gdb server, if not running already.
Put some code on the microcontroller that prints via SEGGER RTT.
Press connect, using the default host and port.

Disable or disconnect other external RTT viewers such as the RTT console in Cortex.

![](doc/screenshot.png)

## Preferences

### Connection defaults

You can configure default hosts/ports and the default filter type for the UI via workspace or user settings.

Example (set default host/port for J-Link RTT and the default filter type):

```json
"uscope.defaults.jlinkRtt.host": "127.0.0.1",
"uscope.defaults.jlinkRtt.port": 19021,
"uscope.filter.defaultType": "simple"
```

These settings will be used as the initial values shown when μScope is opened for that project, and can be changed once the project is open.

### Saved filter tabs

You can predefine filter tabs for a workspace so they appear automatically when the project is opened in VS Code.
Add the `uscope.savedTabs` array to your Workspace settings (Preferences → Settings → Workspace) or directly in the workspace settings JSON.

Example:

```json
"uscope.savedTabs": [
	{ "filter": "CH0", "name": "CH0." },
	{ "filter": "CH1", "name": "CH1." },
	{ "filter": "CH\\d+", "name": "CH*", "filterType": "regex", "highlight": ".*error.*", "highlightType": "regex", "highlightColor": "#ff0000" }
]
```

Saved tabs show as left-most tabs in μScope and are not closable from the UI. 
f you remove a saved tab from the workspace settings it will transition to a session tab (closable) in the open view.

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
