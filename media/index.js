// index.js - Main code that runs in the webview view
// Copyright 2023 Tom Smeets <tom@tsmeets.nl>

// NOTE: this file should be loaded after the DOM is loaded. So we can call 'document.getElementById'
// This can be done by using 'defer' or putting the <script> at the bottom of the page.

// console pane
const el_output = document.getElementById("output");
const el_input  = document.getElementById("input");
const el_filter = document.getElementById("filter");

// right pane
// selecting the connection type
const el_type    = document.getElementById("type");
const el_host    = document.getElementById("host");
const el_port    = document.getElementById("port");
const el_connect = document.getElementById("connect");
const el_highlight = document.getElementById("highlight");
const el_highlight_type = document.getElementById("highlight_type");
const el_highlight_color = document.getElementById("highlight_color");

// tab bar elements
const el_tabbar   = document.getElementById("tabbar");
const el_tab_plus = document.getElementById("tab_plus");

// extra action buttons
const el_save   = document.getElementById("save");
const el_clear  = document.getElementById("clear");
const el_follow = document.getElementById("follow");
const el_filter_type = document.getElementById("filter_type");

// The vscode api for sending messages to 'extension.ts'
const vscode = acquireVsCodeApi();

// Global state, put inside an object for better visibility.
let cfg = {
    // maximum number of messages to display. Memory is not an issue here, but updating the html becomes slow eventually.
    // That is the disadvantage of this, i don't have any control over how the html is rendered and can't make it fast
    // without re-implementing the entire renderer.
    max_length: 4000,

    // socket connection state
    connected: false,

    // every single RTT line we received
    lines: [],

    // if a line was incomplete, append here
    line_progress: "",

    // Current open tab. This object is reassigned to the tab that we are currently viewing.
    // Tabs are stored in the tab_list. tab is assigned to the currently highlighted tab.
    tab: {
        // entire element of the tab text+close button
        el: null,

        // just the text element in the tab
        el_txt: null,

        // automatically scroll to the bottom in this tab?
        follow: true,

        // filter text entered for this tab
        filter_text: "",
        // can be 'simple' or 'regex'
        // simple is "simple to enter" but still has many features. We support 'or' '|' and 'and' '&' operators. And binds more closely.
        filter_type: 'simple',

        // for type = regex, we compile the regex only once per filter change
        filter_regex: null,
    },

    // list of all tabs, objects are the same as the tab object above
    tab_list: [],
    // whether we are currently in a reconnect loop
    reconnecting: false,
};

// Settings pushed from the extension host (defaults for host/port and filter)
let settingsDefaults = null;
let settingsDefaultHighlightColor = '#ffff00';

// If the extension injected settings into the page at load time, apply them immediately.
if(window.__uscopeDefaults) {
    settingsDefaults = window.__uscopeDefaults.defaults || null;
    if(window.__uscopeDefaults.defaultHighlightColor) settingsDefaultHighlightColor = window.__uscopeDefaults.defaultHighlightColor;
    if(window.__uscopeDefaults.filterDefault) el_filter_type.value = window.__uscopeDefaults.filterDefault;
    const t = el_type.value;
    if(settingsDefaults && settingsDefaults[t]) {
        el_host.value = settingsDefaults[t].host;
        el_port.value = String(settingsDefaults[t].port);
    }
    // Do not treat this as a live update — these are initial defaults only
}

// helper to create a unique key for a tab spec
function tabKey(spec) {
    const name = spec.name || "";
    const filter = spec.filter || "";
    const type = spec.filterType || spec.filter_type || "simple";
    return `${name}|${filter}|${type}`;
}

// Close a tab (used by close buttons)
function closeTab(tab) {
    const ix = cfg.tab_list.indexOf(tab);
    if(ix < 0) return;
    cfg.tab_list.splice(ix, 1);
    try { el_tabbar.removeChild(tab.el); } catch {}
    if(tab === cfg.tab) {
        if(cfg.tab_list.length > 0) {
            let j = ix;
            if(j >= cfg.tab_list.length) j = cfg.tab_list.length-1;
            switch_tab(cfg.tab_list[j]);
        } else {
            create_new_tab();
        }
    }
}

// lets create the initial tabs: saved tabs if provided, otherwise a single empty tab
if(window.__uscopeDefaults && Array.isArray(window.__uscopeDefaults.savedTabs) && window.__uscopeDefaults.savedTabs.length > 0) {
    // respect array order as provided by the workspace settings
    const saved = window.__uscopeDefaults.savedTabs.slice();
    for(let i=0;i<saved.length;i++) {
        const s = saved[i];
        create_new_tab({ filter_text: s.filter || "", filter_type: s.filterType || s.filter_type || 'simple', name: s.name || '', saved: true, key: tabKey(s), highlight_text: s.highlight || s.highlightText || "", highlight_type: s.highlightType || s.highlight_type || 'simple', highlight_color: s.highlightColor || settingsDefaultHighlightColor });
    }
} else {
    create_new_tab();
}

// Create a new tab and add it tot the tab-bar
// The new tab is then focused
function create_new_tab(spec) {
    // create the HTML elements for the tab button
    // NOTE: classList is not actually a JavaScript list, but a space separated string
    // span: inline, div: display: block
    const el = document.createElement("span");
    el.classList = "tab";

    // text, and where to click to switch tab
    const el_txt = document.createElement("span");
    // el_txt.classList = "";

    // close button, closes the tab. For saved tabs we do not create a close button.
    let el_close = null;


    // create a object containing information on the current tab, it is inserted in tab list but can also
    // be referenced here directly.
    let tab = {
        el: el,
        el_txt: el_txt,
        follow: true, // scroll output automatically
        filter_text: spec && spec.filter_text ? spec.filter_text : "",
        filter_regex: null, // can be null if the text is an invalid regex
        filter_type: spec && spec.filter_type ? spec.filter_type : (spec && spec.filterType ? spec.filterType : 'simple'),
        name: spec && spec.name ? spec.name : null,
        saved: spec && spec.saved ? true : false,
        key: spec && spec.key ? spec.key : null,
        // highlight settings for this tab
        highlight_text: spec && (spec.highlight_text !== undefined) ? spec.highlight_text : "",
        highlight_type: spec && (spec.highlight_type !== undefined) ? spec.highlight_type : (spec && spec.highlightType ? spec.highlightType : 'simple'),
        highlight_color: spec && spec.highlight_color ? spec.highlight_color : '#ffff00',
        highlight_regex: null,
    };

    // clicking the 'x' in the tab should close the tab, and switch to a different tab if needed
    function do_close() {
        // remove the tab from the tab list
        const ix = cfg.tab_list.indexOf(tab);
        if(ix < 0) return;
        cfg.tab_list.splice(ix, 1);

        // remove the html element
        el_tabbar.removeChild(tab.el);

        // if the tab is active, switch to a different one
        // only returns true of they are the actual same object reference
        if(tab === cfg.tab) {
            // if there are other tabs, we switch to the one next to it
            if(cfg.tab_list.length > 0) {
                // find next element to focus
                let j = ix;
                // if the right most tab was closed, switch to the tab before it
                if(j >= cfg.tab_list.length) j = cfg.tab_list.length-1;
                switch_tab(cfg.tab_list[j]);
            } else {
                // no tabs exist anymore, create at least one and switch to it
                create_new_tab();
            }
        }
    }

    // clicking anything but the close button should switch to the tab
    el.addEventListener("click",     ev => switch_tab(tab));
    el_txt.addEventListener("click", ev => switch_tab(tab));

    // create and wire the close button only for non-saved (session) tabs
    function addClose() {
        if(el_close) return;
        el_close = document.createElement("a");
        el_close.classList = "icon";
        el_close.innerHTML = "x";
        el_close.addEventListener("click", ev => do_close());
        el_close.addEventListener("auxclick", ev => { if(ev.button === 1) do_close(); });
        el.appendChild(el_close);
        tab.el_close = el_close;
    }

    function removeClose() {
        if(!el_close) return;
        try { el.removeChild(el_close); } catch {}
        el_close = null;
        tab.el_close = null;
    }

    // middle mouse button also closes the tab (on the tab itself)
    el.addEventListener("auxclick", ev => { if(ev.button === 1) do_close(); });
    el_txt.addEventListener("auxclick", ev => { if(ev.button === 1) do_close(); });

    // insert before the first session tab (so saved tabs stay left-most) or before the '+' if none
    el.appendChild(el_txt);
    if(!tab.saved) {
        el_close = document.createElement("a");
        el_close.classList = "icon";
        el_close.innerHTML = "x";
        el_close.addEventListener("click", ev => do_close());
        el_close.addEventListener("auxclick", ev => { if(ev.button === 1) do_close(); });
        el.appendChild(el_close);
        tab.el_close = el_close;
    }

    // determine insertion index in cfg.tab_list: before first non-saved tab (i.e. keep saved tabs left)
    let insertIndex = cfg.tab_list.length;
    for(let i = 0; i < cfg.tab_list.length; i++) {
        if(!cfg.tab_list[i].saved) { insertIndex = i; break; }
    }

    // find reference node in DOM to insert before
    let refNode = el_tab_plus;
    if(insertIndex < cfg.tab_list.length) refNode = cfg.tab_list[insertIndex].el;
    el_tabbar.insertBefore(el, refNode);

    // insert into cfg.tab_list at correct position
    cfg.tab_list.splice(insertIndex, 0, tab);

    // style saved tabs slightly differently
    if(tab.saved) el.classList.add('saved');

    // set visible text
    if(tab.name && tab.name !== "") tab.el_txt.innerText = tab.name;
    else if(tab.filter_text === "") tab.el_txt.innerHTML = "<i>No filter</i>";
    else tab.el_txt.innerText = tab.filter_text;
    // switch to the new tab
    switch_tab(tab);
}

// Reorder tabs so saved tabs appear first in the order provided by savedKeys, then session tabs in existing order
function reorderTabs(savedKeys) {
    // build maps
    const savedKeysArr = Array.isArray(savedKeys) ? savedKeys.slice() : [];
    const existing = cfg.tab_list.slice();

    const newList = [];
    // add saved tabs in the order of savedKeys
    for(const key of savedKeysArr) {
        const t = existing.find(x => x.key === key);
        if(t) newList.push(t);
    }
    // append any remaining saved tabs that weren't matched
    for(const t of existing) {
        if(t.saved && newList.indexOf(t) === -1) newList.push(t);
    }
    // append session tabs in their existing relative order
    for(const t of existing) {
        if(!t.saved) newList.push(t);
    }

    // rebuild DOM order
    for(const t of existing) {
        try { el_tabbar.removeChild(t.el); } catch {}
    }
    for(const t of newList) {
        el_tabbar.insertBefore(t.el, el_tab_plus);
    }

    cfg.tab_list = newList;
}

// expose helpers for saved tab updates
window.__uscope_applySavedTabs = applySavedTabs;

// Apply saved tabs updates from the extension: add missing saved tabs, mark removed ones as session tabs
function applySavedTabs(savedArray) {
    if(!Array.isArray(savedArray)) return;
    const saved = savedArray.slice();
    const newKeys = saved.map(s => tabKey(s));

    // mark existing saved tabs not in newKeys as not-saved (make them session tabs and add close button)
    for(const t of cfg.tab_list) {
        if(t.saved && (!t.key || newKeys.indexOf(t.key) === -1)) {
            t.saved = false;
            t.el.classList.remove('saved');
            // add a close button if missing
            if(!t.el_close) {
                const close = document.createElement('a');
                close.classList = 'icon';
                close.innerHTML = 'x';
                close.addEventListener('click', ev => closeTab(t));
                close.addEventListener('auxclick', ev => { if(ev.button === 1) closeTab(t); });
                t.el.appendChild(close);
                t.el_close = close;
            }
        }
    }

    // add any new saved tabs not already present
    for(let i=0;i<saved.length;i++) {
        const s = saved[i];
        const key = tabKey(s);
        const exists = cfg.tab_list.find(t => t.key === key);
        if(!exists) {
            // insert at the correct position based on order: insert before the i-th saved tab element or before +
            create_new_tab({ filter_text: s.filter || "", filter_type: s.filterType || s.filter_type || 'simple', name: s.name || '', saved: true, key: key, highlight_text: s.highlight || s.highlightText || "", highlight_type: s.highlightType || s.highlight_type || 'simple', highlight_color: s.highlightColor || settingsDefaultHighlightColor });
        } else {
            // ensure it's marked saved
            exists.saved = true;
            exists.el.classList.add('saved');
            // update highlight settings from saved config
            exists.highlight_text = s.highlight || s.highlightText || exists.highlight_text;
            exists.highlight_type = s.highlightType || s.highlight_type || exists.highlight_type;
            exists.highlight_color = s.highlightColor || settingsDefaultHighlightColor || exists.highlight_color;
            exists.highlight_regex = null;
            // remove close button if present
            if(exists.el_close) {
                try { exists.el.removeChild(exists.el_close); } catch {}
                exists.el_close = null;
            }
        }
    }
    // finally reorder tabs so saved ones are left-most in the order of saved array
    reorderTabs(newKeys);
}

// compare the line to the current active filter
function line_matches(line) {

    // if the filter is just lowercase, ignore all case
    // so make the line also lowercase to ignore case altogether
    if(cfg.tab.ignore_case) {
        line = line.toLowerCase();
    }

    // Simple filter type
    // allows for two operators: OR '|'  and AND '&'
    // the 'and' binds more strongly than the or
    // so a&b|c&d filter lines that contain 'a' and 'b', but also the lines that contain c and d
    if(cfg.tab.filter_type === 'simple') {
        // first split on every 'or' sign. The '|'
        const filter_or = cfg.tab.filter_text.split("|");
        for (let i = 0; i < filter_or.length; i++) {

            // then split on every 'and' sign. The '&'
            // this way the and binds stronger which makes more sense for this case.
            const filter_and =  filter_or[i].split("&");

            // if all elements in the 'and' match, then this 'or' matches and the line matches.
            let has_all = true;
            for (let j = 0; j < filter_and.length; j++) {
                let filter = filter_and[j];

                // trim all spaces at the start and end, so those separating the '|' and '&' signs.
                // this makes sense in my opinion. Spaces between words are not stripped, which is also good.
                filter = filter.trim();

                // if one does not match, we are done with this 'or' part.
                if(!line.includes(filter)) {
                    has_all = false;
                    break;
                }
            }

            // if we have found a case, we are done and the line matches.
            if(has_all) return true;
        }

        // not a single 'or' matches, so the line is not included
        return false;
    }

    // Matching the regex is done with the builtin javascript regex class
    if(cfg.tab.filter_type === 'regex') {
        // if the regex failed to compile we default to matching every single message.
        if(cfg.tab.filter_regex === null) return true;
        return cfg.tab.filter_regex.exec(line) !== null;
    }

    // should not be reached, but whatever.
    return true;
}

// Escape HTML special chars for safe insertion into innerHTML
function escapeHtml(unsafe) {
    return unsafe.replace(/[&<>\"']/g, function(c) {
        switch(c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#039;';
        }
    });
}

// Apply highlight for the active tab to a single line, returning HTML-safe string (may contain <span> wrappers)
function applyHighlightToLine(line) {
    const h = cfg.tab.highlight_text;
    if(!h || h === '') return escapeHtml(line);

    // determine ignore case for highlight (same heuristic as filter)
    const ignore_case = h === h.toLowerCase();

    if(cfg.tab.highlight_type === 'regex') {
        // compile if needed
        if(cfg.tab.highlight_regex === null) {
            try {
                cfg.tab.highlight_regex = new RegExp(h, ignore_case ? 'i' : '');
            } catch (e) { cfg.tab.highlight_regex = null; }
        }
        if(cfg.tab.highlight_regex === null) return escapeHtml(line);
        try {
            const re = new RegExp(cfg.tab.highlight_regex.source, (ignore_case ? 'gi' : 'g'));
            return escapeHtml(line).replace(re, match => `<span style="background-color:${cfg.tab.highlight_color}">${escapeHtml(match)}</span>`);
        } catch (e) {
            return escapeHtml(line);
        }
    }

    // simple highlight: escape the pattern and replace occurrences
    const pat = h.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    const flags = ignore_case ? 'gi' : 'g';
    try {
        const re = new RegExp(pat, flags);
        return escapeHtml(line).replace(re, match => `<span style="background-color:${cfg.tab.highlight_color}">${escapeHtml(match)}</span>`);
    } catch (e) {
        return escapeHtml(line);
    }
}

// Change the current tab to the new tab
function switch_tab(tab_new) {
    // if the tab is already gone, don't switch to it
    const ix = cfg.tab_list.indexOf(tab_new);
    if(ix < 0) return;

    let tab_old = cfg.tab;

    // if there was a previous tab, mark it not active anymore
    if(tab_old.el !== null) {
        tab_old.el.classList = "tab";
    }

    // the new tab is now active
    tab_new.el.classList = "tab active";

    // let everyone know what the new tab is. This is not a copy but a reference.
    cfg.tab = tab_new;

    // the filter input element should reflect the state of the tab.
    el_filter.value = cfg.tab.filter_text;
    el_filter_type.value = cfg.tab.filter_type;

    // highlight inputs should reflect tab state
    if(typeof el_highlight !== 'undefined' && el_highlight) el_highlight.value = cfg.tab.highlight_text || '';
    if(typeof el_highlight_type !== 'undefined' && el_highlight_type) el_highlight_type.value = cfg.tab.highlight_type || 'simple';
    if(typeof el_highlight_color !== 'undefined' && el_highlight_color) el_highlight_color.value = cfg.tab.highlight_color || settingsDefaultHighlightColor || '#ffff00';

    // different tab means a different filter
    change_filter();
}

// Scroll to bottom, if enabled
function update_scroll() {
    // this is the best way i found to scroll to the bottom
    if(cfg.tab.follow) el_output.scrollTop = el_output.scrollHeight;
}

// Redraw the entire output console with the current active filter
function output_redraw() {
    // we accumulate all lines into a single string and set that as the element.
    // I measured this and it is significantly faster than appending tons of text elements directly.
    // NOTE: This is not very efficient given that we copy at every line, is there a string builder class?
    // according to this <https://stackoverflow.com/questions/2087522/does-javascript-have-a-built-in-stringbuilder-class> this is actually way
    // faster than a join. Bit strange, so maybe the browser does more smart things.
    let out = "";
    for(i in cfg.lines) {
        let line = cfg.lines[i];
        if(line_matches(line))
            out += applyHighlightToLine(line);
    }

    // set as HTML inside the pre; lines are escaped inside applyHighlightToLine
    el_output.innerHTML = out;

    // everything changed so scroll to the bottom again
    update_scroll();
}

// Send a message to the extension
function msg_send(data) {
    vscode.postMessage(data);
}

// Start the socket connection
function connect() {
    const host = el_host.value;
    const port = el_port.value;
    const type = el_type.value;
    el_connect.innerText = "Connecting...";
    msg_send({ type: 'connect', host: host, port: port, how: type });
}

// close the socket connection
function disconnect() {
    el_connect.innerText = "Connect";
    cfg.connected = false;
    msg_send({ type: 'disconnect' });
}

// We have connected to the socket
function on_connect() {
    el_connect.innerText = "Disconnect";
    cfg.connected = true;
    cfg.reconnecting = false;
}

// We failed to connect to the socket
function on_error() {
    // If we are in a reconnect loop, keep that UI state instead of showing Failed
    if (cfg.reconnecting) {
        console.debug('[uScope] on_error ignored because reconnecting');
        return;
    }

    el_connect.innerText = "Failed, Retry?";
    cfg.reconnecting = false;
}

// Connection was closed, the server went away or something
function on_disconnect() {
    // If a reconnect is scheduled/ongoing, keep the reconnect UI instead of flipping back to Connect
    if (cfg.reconnecting) {
        return;
        cfg.connected = false; // still mark disconnected
        return;
    }

    el_connect.innerText = "Connect";
    cfg.connected = false;
    cfg.reconnecting = false;
}

// Handle reconnect updates from the extension
function on_reconnect(attempt, delay) {
    cfg.connected = false;
    // keep the button narrow: short text with attempt number
    el_connect.innerText = `Reconnecting... ${attempt}`;
    cfg.reconnecting = true;
}

// Unified incoming message handler from the extension
window.addEventListener('message', event => {
    const data = event.data;
    if(!data || !data.type) return;

    // configuration defaults
    if(data.type === 'settings') {
        settingsDefaults = data.defaults || null;
        if(data.filterDefault) el_filter_type.value = data.filterDefault;
        // apply host/port for the currently selected type
        const t = el_type.value;
        if(settingsDefaults && settingsDefaults[t]) {
            el_host.value = settingsDefaults[t].host;
            el_port.value = String(settingsDefaults[t].port);
        }
        return;
    }

    // saved tabs update from the extension
    if(data.type === 'savedTabs') {
        applySavedTabs(data.savedTabs || []);
        return;
    }

    switch(data.type) {
        case 'connect':
            on_connect();
            break;

        case 'error':
            on_error();
            append_line("ERROR: " + (data.value || "") + "\n");
            break;

        case 'close':
            on_disconnect();
            append_line("[Connection closed]\n");
            break;

        case 'reconnect':
            on_reconnect(data.attempt, data.delay);
            break;
        // debug messages removed

        case 'message': {
            // streaming message: may contain multiple lines; preserve incomplete tail in cfg.line_progress
            const message = cfg.line_progress + (data.value || "");
            const msg_lines = message.split("\n");
            cfg.line_progress = msg_lines.pop();

            for (let i = 0; i < msg_lines.length; i++) {
                let line = msg_lines[i];
                if(line === "") continue;
                line += "\n";
                append_line(line);
            }

            // scroll down to the new lines
            update_scroll();
            break;
        }
    }
});

// we changed the filter
function change_filter() {
    const filter = el_filter.value;
    cfg.tab.filter_text = filter;
    // smart case: if the filter is lowercase, we ignore all case.
    // A single upper case char makes the filter case sensitive.
    // if x == x.toLowerCase() then x is lowercase.
    cfg.tab.ignore_case = filter === filter.toLowerCase();
    cfg.tab.filter_regex = null;
    
    // for regex filters, compile the regex
    if(cfg.tab.filter_type === 'regex') {
        try {
            cfg.tab.filter_regex = new RegExp(filter, cfg.tab.ignore_case ? "i" : "");
            el_filter.style = "";
        } catch {
            // cool red border if the regex is invalid
            cfg.tab.filter_regex = null;
            el_filter.style = "outline: 2px solid red !important; outline-offset: -1px";
        }
    }

    // just scroll to bottom, probably good default behavior
    cfg.tab.follow = true;

    // update tab text, but only use the filter as the tab label when the tab has no explicit name.
    if(cfg.tab.name && cfg.tab.name !== "") {
        // keep the name as the tab label
        cfg.tab.el_txt.innerText = cfg.tab.name;
    } else {
        if(filter === "") {
            cfg.tab.el_txt.innerHTML = "<i>No filter</i>";
        } else {
            cfg.tab.el_txt.innerText = filter;
        }
    }

    // filter changed -> need a full redraw
    output_redraw();
}

// we got a new line from the connection
function append_line(line) {
    cfg.lines.push(line);
    
    if(line_matches(line)) {
        // add as an element so we can include highlight markup
        const span = document.createElement('span');
        span.innerHTML = applyHighlightToLine(line);
        el_output.appendChild(span);
    }

    // reduce the number of messages, the html rendrer
    // becomes laggy after a given number of lines.
    // This is done in chuncks to limit the rate
    // where the entire screen is re rendred.
    if(cfg.lines.length >= cfg.max_length) {
        cfg.lines.splice(0, cfg.max_length / 4);
        output_redraw();
    }
}

// We got some input we need to send to the device
function send_input() {
    // Always terminate the line with a newline symbol
    const value = el_input.value + "\n";

    // forward to extension.ts
    msg_send({ type: 'input', value: value });

    // show the input line in the console
    append_line("> " + value);

    // after sending clear the input field again
    el_input.value = "";
}

// Connect button
el_connect.addEventListener("click", event => {
    // If we are in a reconnect loop, clicking should cancel retries (manual disconnect)
    if (cfg.reconnecting) {
        cfg.reconnecting = false;
        cfg.connected = false;
        el_connect.innerText = "Connect";
        // inform extension to stop retrying
        msg_send({ type: 'disconnect' });
        return;
    }

    if(!cfg.connected) {
        connect();
    } else {
        disconnect();
    }
});

// Command input text, enter = send
el_input.addEventListener("keydown", event => {
    if (event.key === "Enter") send_input();
});

// Filter changed, immediately update the console, because that is cool
el_filter.addEventListener("input", event => {
    change_filter();
});


// clicking on the output text should stop the scrolling
el_output.addEventListener("click", event => {
    cfg.tab.follow = false;
    update_scroll();
});

// clicking the follow button should always enable scroll to bottom again
el_follow.addEventListener("click", event => {
    cfg.tab.follow = true;
    update_scroll();
});

// (Old message handler removed — messages are handled by the unified handler above)

// create new tabs with the new tab '+' button
el_tab_plus.addEventListener("click", ev => {
    create_new_tab();
});

// clear console output
el_clear.addEventListener("click", ev => {
    cfg.lines = [];
    output_redraw();
});

// save console output, now just everything, but could potentially be the filtered list.
el_save.addEventListener("click", ev => {
    msg_send({ type: 'save', value: cfg.lines });
});

// if the filter type changed, recompile the filter and update the output console.
el_filter_type.addEventListener("change", ev => { cfg.tab.filter_type = el_filter_type.value; change_filter(); });

// highlight input changed -> update tab settings and redraw
if(el_highlight) el_highlight.addEventListener('input', ev => {
    cfg.tab.highlight_text = el_highlight.value;
    // reset compiled regex so it will recompile on demand
    cfg.tab.highlight_regex = null;
    output_redraw();
});
if(el_highlight_type) el_highlight_type.addEventListener('change', ev => {
    cfg.tab.highlight_type = el_highlight_type.value;
    cfg.tab.highlight_regex = null;
    output_redraw();
});
if(el_highlight_color) el_highlight_color.addEventListener('input', ev => {
    cfg.tab.highlight_color = el_highlight_color.value;
    output_redraw();
});

// connection type, changes the port. The '-gdb' versions also start gdb and use that to communicate over RTT.
el_type.addEventListener("change", ev => {
    // prefer settings pushed from the extension host
    const mapping = settingsDefaults ? settingsDefaults[el_type.value] : null;
    if(mapping) {
        el_host.value = mapping.host;
        el_port.value = String(mapping.port);
        return;
    }

    // fallback hardcoded ports if no settings available
    if(el_type.value === "jlinkRtt")
        el_port.value = "19021";

    if(el_type.value === "jlinkSwo")
        el_port.value = "2332";

    if(el_type.value === "jlinkTelnet")
        el_port.value = "2333";

    if(el_type.value === "stlinkSwo")
        el_port.value = "61235";

    if(el_type.value === "stlinkRttGdb")
        el_port.value = "61234";

    if(el_type.value === "openocdRttGdb")
        el_port.value = "3333";

    if(el_type.value === "openocdSwo")
        el_port.value = "3344";
});
