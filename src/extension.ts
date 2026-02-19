/* extension.ts - μScope vscode extension code */
/* Copyright 2023 Tom Smeets <tom@tsmeets.nl> */

// vscode api
import * as vscode from 'vscode';

// net is used to create sockets for the RTT connection
import * as net from 'net';

// fs is used to read files for reading the /media/index.html file
import * as fs from 'fs';

// child process will be used to spawn a gdb session which we use to connect to a gdb server
import * as cp from 'child_process';

/// global variables

// path of the extension. Used to access files in /media for example.
let extension_uri: vscode.Uri;

// vscode webview pane that contains our app
let view: vscode.WebviewView;

// socket connection to the J-link Gdb Server, usually port 19021.
// the connection is basically a telnet connection.
let socket: net.Socket | null;
let proc: cp.ChildProcessWithoutNullStreams | null;
let timer: NodeJS.Timer | null;
let reconnectTimer: NodeJS.Timer | null = null;
let reconnectAttempts = 0;
let manualDisconnect = false;
let lastHost: string | null = null;
let lastPort: number | null = null;
let lastHow: string | null = null;


// called as soon as the 'uscope' panel becomes visible, which should be at launch
export function activate(context: vscode.ExtensionContext) {
    extension_uri = context.extensionUri;
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("uscope-view", new UScopeView(context.extensionUri), { webviewOptions: { retainContextWhenHidden: true } }));
    // Forward savedTabs configuration changes live so the webview can add/remove saved tabs immediately.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if(!view) return;
        if(e.affectsConfiguration('uscope.savedTabs')) {
            const conf = vscode.workspace.getConfiguration('uscope');
            const savedTabs = conf.get('savedTabs', []);
            view.webview.postMessage({ type: 'savedTabs', savedTabs: savedTabs });
        }
    }));
}

// (removed) sendSettingsToWebview: initial settings are injected into the HTML to avoid postMessage timing issues


// probably called when vscode exists or reloads
export function deactivate() {
    disconnect();
}

// Create a the socket connection to the rtt server. 'how' is used to decide wether to create a TCP socket or a connection over gdb.
function connect(host: string, port: number, how: string, userInitiated: boolean = false) {
    // try to disconnect, if we are still connected
    // clear manualDisconnect only when the user explicitly requests a new connection
    if (userInitiated) {
        manualDisconnect = false;
        // clear any pending reconnect attempts and disconnect existing connections
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        reconnectAttempts = 0;
    }
    disconnect();

    // store for possible reconnect attempts
    lastHost = host;
    lastPort = port;
    lastHow = how;

    // Receive RTT over GDB,
    // RTT normally only works with SEGGER J-Link devices
    // But we can read memory via gdb, so we implement the RTT protocol and read the data out
    // RTT over GDB (ST-Link / OpenOCD) use the GDB-based reader
    if(typeof how === 'string' && how.toLowerCase().includes('rtt') && how.toLowerCase().includes('gdb')) {
        proc = cp.spawn("gdb", ['-q', '-nx', "--interpreter=mi"]);
        // successful start of a gdb process counts as a successful connection
        reconnectAttempts = 0;
        view_send({ host: host, port: port, type: "connect" }); 
        proc.stdout.on('error', ev => console.log('error', ev));

        // TODO: Some kind of error handling

        // non-stop mode, so we can read memory while still running
        proc.stdin.write("set non-stop on\n");

        // connect to the gdbserver
        proc.stdin.write("target remote " + host + ":" + port + "\n");

        // find the RTT Block structure, it always starts with the string "SEGGER RTT"
        proc.stdin.write('find /1 0x24000000, 0x24080000, "SEGGER RTT"\n');
        proc.stdin.write('set var $RTT=$_\n');

        // Define structure variables
        proc.stdin.write('set var $RTT_NAME  = *(char **)($RTT + 16 + 4*2 + 4*0)\n');
        proc.stdin.write('set var $RTT_BUF   = *(char **)($RTT + 16 + 4*2 + 4*1)\n');
        proc.stdin.write('set var $RTT_SIZE  = *(unsigned *)($RTT + 16 + 4*2 + 4*2)\n');
        proc.stdin.write('set var $RTT_WR    =  (unsigned *)($RTT + 16 + 4*2 + 4*3)\n');
        proc.stdin.write('set var $RTT_RD    =  (unsigned *)($RTT + 16 + 4*2 + 4*4)\n');
        proc.stdin.write('set var $RTT_FLAGS =  (unsigned *)($RTT + 16 + 4*2 + 4*5)\n');

        // Set blocking mode on
        // proc.stdin.write('p *$RTT_FLAGS=2\n');

        // continue running the program
        proc.stdin.write("continue &\n");

        // messages from gdb
        proc.stdout.on('data', data => {
            // very crude parsing of the 'output' data, rest is ignored
            const lines = data.toString().split("\n");
            for(const i in lines) {
                let value = lines[i];
                if(value.startsWith('~"\\"')) {
                    // strip the starting '~'
                    value = value.slice(1);

                    // the strings are encoded twice, use JSON.parse to unescape the '\n' and stuff.
                    try {
                        value = JSON.parse(value);
                        value = JSON.parse(value);

                        // send the message to the backend
                        view_send({  type: "message", value: value });
                    } catch (error) {                
                    }
                }
            }
        }); 

        proc.on('exit', (code, signal) => {
            // GDB process died, try to reconnect unless user requested disconnect
            view_send({ type: 'error', value: `gdb exited (${code || signal})` });
            scheduleReconnect();
        });

        proc.on('error', (err) => {
            view_send({ type: 'error', value: err.message || String(err) });
            scheduleReconnect();
        });

        timer = setInterval(() => {
            // This should never happen, but needed to make typescript happy
            // If the process is terminated we also stop the timer.
            // Depending on the scheduling it might be possible that this still runs
            // for one iteration. In that case we ignore it. The timer should be stopped for the next.
            if(!proc) return;

            // CUR_START, CUR_END indicate the memory region that contains the new RTT text
            // we store them now here because *$RTT_WR can change anytime.
            proc.stdin.write('set var $CUR_START=*$RTT_RD\n');
            proc.stdin.write('set var $CUR_END=*$RTT_WR\n');

            // If the start is after the end, it has wrapped around and the regions are now [cur_start..buffer_end] and [0..cur_end].
            // we output the first section [cur_start..buffer_end] and assing cur_start to 0 for the next section to handle.
            proc.stdin.write('if $CUR_START > $CUR_END\n');
            proc.stdin.write('output *($RTT_BUF+$CUR_START)@($RTT_SIZE-$CUR_START)\n');
            proc.stdin.write('set var $CUR_START=0\n');
            proc.stdin.write('end\n');

            // Output the text between CUR_START and CUR_END inside RTT_BUF.
            proc.stdin.write('output *($RTT_BUF+$CUR_START)@($CUR_END-$CUR_START)\n');
            // And advance the value of the read cursor to where we have read data
            proc.stdin.write('set var *$RTT_RD=$CUR_END\n');
        }, 50);
    } else {
        // everything else, that is not over gdb just uses a simple tcp socket
        socket = net.connect(port, host, () => { view_send({ host: host, port: port, type: "connect" }); });
        // successful socket connection -> reset attempts
        socket.on('connect', () => { reconnectAttempts = 0; });

        // forward all error messages to the webview
        socket.on('error', data => {
            view_send({ type: "error", value: data.message });
            // schedule reconnect attempts
            scheduleReconnect();
        });

        // also forward close event and the message data
        socket.on('close', hadError => {
            view_send({ type: "close" });
            scheduleReconnect();
        });

        socket.on('data', data => view_send({  type: "message", value: data.toString() }));
    }
}

function scheduleReconnect() {
    // don't schedule if user explicitly disconnected
    if (manualDisconnect) return;
    // If a reconnect is already scheduled, don't schedule another (avoid double-increment)
    if (reconnectTimer) return;

    // increment attempt counter once per scheduled reconnect
    reconnectAttempts++;

    // first attempt immediate, subsequent attempts back off exponentially up to 1s
    let delay = 0;
    if (reconnectAttempts <= 1) delay = 0;
    else delay = Math.min(1000, Math.pow(2, reconnectAttempts - 2) * 100);

    view_send({ type: 'reconnect', attempt: reconnectAttempts, delay: delay });
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        // if user disconnected in the meantime, abort
        if (manualDisconnect) return;
        if (lastHost !== null && lastPort !== null && lastHow !== null) {
            connect(lastHost, lastPort, lastHow);
        }
    }, delay);
}

// close the socket if possible.
// does nothing if the socket was already closed
function disconnect() {
    if(timer) {
        clearInterval(timer);
        timer = null;
    }

    if(socket) {
        socket.destroy();
        socket = null;
    }

    if(proc) {
        proc.kill('SIGINT');
        proc = null;
    }
}

// call to send data to the webview. The data is structured as such:
// {
//   type: ...,
//   value: ...,
//   ...
// }
function view_send(data: any) {
    // console.log("view_send:", data);
    view.webview.postMessage(data);
}

// receive a message from the webview. So we can handle connecting, saving data and sending input.
function view_recv(data: any) {
    // (re)connect to the socket
    if(data.type === 'connect') {
        connect(data.host, data.port, data.how, true);
    }

    // send input to the socket, data.value is always a single line with no '\n' at the end.
    if(data.type === 'input') {
        const value: string = data.value;
        socket?.write(value);
    }

    // user wants to close the socket, so lets do that
    if(data.type === 'disconnect') {
        // mark as manual disconnect so automatic reconnect attempts stop
        manualDisconnect = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        reconnectAttempts = 0;
        disconnect();
    }

    // save data as a text file, show a dialog so the user can choose a destination. The data.value is an array of all the lines.
    if(data.type === 'save') {
        vscode.window.showSaveDialog({ filters: { 'Text': ["txt"] } }).then(info => {
            if(info !== undefined) {
                fs.writeFileSync(info.fsPath, data.value.join(""));
            }
        });
    }
}

// Load the webview. We use 'media/index.html' as a reference and substitute the correct paths.
// This should only be called once on load. Calling again will clear the stored data in the webview.
function view_update() {
    view.webview.options = {
        enableScripts: true,
        localResourceRoots: [extension_uri]
    };

    // read the html from a file, so we don't need a big string here. But because the file is sent as text, we don't know what path it is.
    // We ask vscode for the paths of index.js and index.css and insert them into the html page.
    const uri_js  = view.webview.asWebviewUri(vscode.Uri.joinPath(extension_uri, 'media', 'index.js'));
    const uri_css = view.webview.asWebviewUri(vscode.Uri.joinPath(extension_uri, 'media', 'index.css'));
    let html = fs.readFileSync(vscode.Uri.joinPath(extension_uri, 'media', 'index.html').fsPath).toString();
    // Build initial settings script so the webview receives defaults immediately on first render
    try {
        const conf = vscode.workspace.getConfiguration('uscope');
        const defaults: any = {
            'jlinkRtt': { host: conf.get('defaults.jlinkRtt.host', '127.0.0.1'), port: conf.get('defaults.jlinkRtt.port', 19021) },
            'jlinkSwo': { host: conf.get('defaults.jlinkSwo.host', '127.0.0.1'), port: conf.get('defaults.jlinkSwo.port', 2332) },
            'jlinkTelnet': { host: conf.get('defaults.jlinkTelnet.host', '127.0.0.1'), port: conf.get('defaults.jlinkTelnet.port', 2333) },
            'stlinkRttGdb': { host: conf.get('defaults.stlinkRttGdb.host', '127.0.0.1'), port: conf.get('defaults.stlinkRttGdb.port', 61234) },
            'stlinkSwo': { host: conf.get('defaults.stlinkSwo.host', '127.0.0.1'), port: conf.get('defaults.stlinkSwo.port', 61235) },
            'openocdRttGdb': { host: conf.get('defaults.openocdRttGdb.host', '127.0.0.1'), port: conf.get('defaults.openocdRttGdb.port', 3333) },
            'openocdSwo': { host: conf.get('defaults.openocdSwo.host', '127.0.0.1'), port: conf.get('defaults.openocdSwo.port', 3344) }
        };
        // default highlight color
        const defaultHighlightColor = conf.get('defaults.highlightColor', 'yellow');
        const filterDefault = conf.get('filter.defaultType', 'simple');
        const savedTabs = conf.get('savedTabs', []);
        const settingsScript = `<script>window.__uscopeDefaults = ${JSON.stringify({ defaults: defaults, filterDefault: filterDefault, savedTabs: savedTabs, defaultHighlightColor: defaultHighlightColor })};</script>`;
        html = html.replace("${uscope_settings}", settingsScript);
    } catch (e) {
        html = html.replace("${uscope_settings}", "");
    }

    html = html.replace("${uri_js}", uri_js.toString());
    html = html.replace("${uri_css}", uri_css.toString());
    view.webview.html = html;
    
    // received messages are forwarded to view_recv
    view.webview.onDidReceiveMessage(data => view_recv(data));
}

// Mandatory class for vscode. We just delegate the actual rendering
// to view_update() and use a global. This is ok because there will only ever be one.
class UScopeView implements vscode.WebviewViewProvider {
    constructor(readonly _extensionUri: vscode.Uri) { }
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        // if we have not yet created the webview. Create it
        if(view === undefined) {
            view = webviewView;
            view_update();
        }
    }
}
