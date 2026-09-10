const vscode = require('vscode');
const http = require('http');

let autoAcceptInterval = null;
let enabled = false;
let autoRetryEnabled = true;
let cdpPort = 9222;
let retryMaxCount = 10;
let retryCurrentCount = 0;
let statusBarItem;
let retryStatusBarItem;
let lastRetryAttempt = 0;
let outputChannel;
let activeWebSockets = new Set();

function activate(context) {
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('Antigravity Auto-Accept');
    context.subscriptions.push(outputChannel);

    // Load settings
    loadSettings();

    // Watch for settings changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-auto-accept')) {
                loadSettings();
                updateRetryStatusBar();
            }
        })
    );

    // Register toggle command for auto-accept
    let disposable = vscode.commands.registerCommand('unlimited.toggle', function () {
        enabled = !enabled;
        vscode.workspace.getConfiguration('antigravity-auto-accept').update('enabled', enabled, true);
        updateStatusBar();
        if (enabled) {
            vscode.window.showInformationMessage('Auto-Accept: ON ✅');
        } else {
            vscode.window.showInformationMessage('Auto-Accept: OFF 🛑');
        }
    });
    context.subscriptions.push(disposable);

    // Register toggle command for auto-retry (CDP)
    let toggleRetry = vscode.commands.registerCommand('unlimited.toggleRetry', function () {
        autoRetryEnabled = !autoRetryEnabled;
        // Save to settings
        vscode.workspace.getConfiguration('antigravity-auto-accept').update('autoRetryEnabled', autoRetryEnabled, true);
        updateRetryStatusBar();
        if (autoRetryEnabled) {
            vscode.window.showInformationMessage(`Auto-Retry (CDP): ON ✅ Port: ${cdpPort}`);
        } else {
            vscode.window.showInformationMessage('Auto-Retry (CDP): OFF 🛑');
        }
    });
    context.subscriptions.push(toggleRetry);

    // Register set CDP port command
    let setCdpPort = vscode.commands.registerCommand('unlimited.setCdpPort', async function () {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter CDP port (e.g., 9222)',
            value: cdpPort.toString(),
            validateInput: (value) => {
                const port = parseInt(value);
                if (isNaN(port) || port < 1 || port > 65535) {
                    return 'Please enter a valid port number (1-65535)';
                }
                return null;
            }
        });
        if (input) {
            cdpPort = parseInt(input);
            vscode.workspace.getConfiguration('antigravity-auto-accept').update('cdpPort', cdpPort, true);
            vscode.window.showInformationMessage(`CDP Port set to: ${cdpPort}`);
            updateRetryStatusBar();
        }
    });
    context.subscriptions.push(setCdpPort);

    // Register set retry max count command
    let setRetryMaxCount = vscode.commands.registerCommand('unlimited.setRetryMaxCount', async function () {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter maximum retry attempts (0 = unlimited)',
            value: retryMaxCount.toString(),
            validateInput: (value) => {
                const count = parseInt(value);
                if (isNaN(count) || count < 0) {
                    return 'Please enter a valid number (0 or greater)';
                }
                return null;
            }
        });
        if (input) {
            retryMaxCount = parseInt(input);
            retryCurrentCount = 0; // Reset counter when changing max
            vscode.workspace.getConfiguration('antigravity-auto-accept').update('retryMaxCount', retryMaxCount, true);
            vscode.window.showInformationMessage(`Retry max count set to: ${retryMaxCount === 0 ? 'Unlimited' : retryMaxCount}`);
            updateRetryStatusBar();
        }
    });
    context.subscriptions.push(setRetryMaxCount);

    // Register reset retry counter command
    let resetRetryCount = vscode.commands.registerCommand('unlimited.resetRetryCount', function () {
        retryCurrentCount = 0;
        vscode.window.showInformationMessage('Retry counter reset to 0');
        updateRetryStatusBar();
    });
    context.subscriptions.push(resetRetryCount);

    // Debug command to list all antigravity commands
    let listCommands = vscode.commands.registerCommand('unlimited.listCommands', async function () {
        const allCommands = await vscode.commands.getCommands(true);
        const antigravityCommands = allCommands.filter(cmd =>
            cmd.toLowerCase().includes('antigravity') ||
            cmd.toLowerCase().includes('agent') ||
            cmd.toLowerCase().includes('retry') ||
            cmd.toLowerCase().includes('allow') ||
            cmd.toLowerCase().includes('confirm') ||
            cmd.toLowerCase().includes('cockpit')
        );

        outputChannel.appendLine('=== Antigravity Related Commands ===\n');
        antigravityCommands.sort().forEach(cmd => {
            outputChannel.appendLine(cmd);
        });
        outputChannel.show();

        vscode.window.showInformationMessage(`Found ${antigravityCommands.length} related commands. Check Output panel.`);
    });
    context.subscriptions.push(listCommands);

    try {
        // Create Auto-Accept status bar item
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
        statusBarItem.command = 'unlimited.toggle';
        context.subscriptions.push(statusBarItem);

        // Create Auto-Retry status bar item
        retryStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9999);
        retryStatusBarItem.command = 'unlimited.toggleRetry';
        context.subscriptions.push(retryStatusBarItem);

        updateStatusBar();
        updateRetryStatusBar();
        statusBarItem.show();
        retryStatusBarItem.show();
    } catch (e) {
        // Silent failure
    }

    // Start the loop
    startLoop();
}

function loadSettings() {
    const config = vscode.workspace.getConfiguration('antigravity-auto-accept');
    cdpPort = config.get('cdpPort', 9222);
    enabled = config.get('enabled', false);
    autoRetryEnabled = config.get('autoRetryEnabled', true);

    const newRetryMaxCount = config.get('retryMaxCount', 10);
    if (retryMaxCount !== newRetryMaxCount) {
        // Reset count when max changes, or if new limit is below current count
        if (newRetryMaxCount === 0 || retryCurrentCount >= newRetryMaxCount || newRetryMaxCount > retryMaxCount) {
             retryCurrentCount = 0;
        }
        retryMaxCount = newRetryMaxCount;
    }
}

function updateStatusBar() {
    if (!statusBarItem) return;

    if (enabled) {
        statusBarItem.text = "✅ Auto-Accept: ON";
        statusBarItem.tooltip = "Unlimited Auto-Accept is Executing (Click to Pause)";
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = "🛑 Auto-Accept: OFF";
        statusBarItem.tooltip = "Unlimited Auto-Accept is Paused (Click to Resume)";
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

function updateRetryStatusBar() {
    if (!retryStatusBarItem) return;

    if (autoRetryEnabled) {
        const countInfo = retryMaxCount === 0 ? '∞' : `${retryCurrentCount}/${retryMaxCount}`;
        retryStatusBarItem.text = `✅ Auto-Retry: ON (${cdpPort}) [${countInfo}]`;
        retryStatusBarItem.tooltip = `Auto-Retry via CDP is Enabled\nPort: ${cdpPort}\nRetry Count: ${countInfo}\nClick to Disable`;

        // Show warning if approaching or at limit
        if (retryMaxCount > 0 && retryCurrentCount >= retryMaxCount) {
            retryStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            retryStatusBarItem.backgroundColor = undefined;
        }
    } else {
        retryStatusBarItem.text = "🛑 Auto-Retry: OFF";
        retryStatusBarItem.tooltip = "Auto-Retry via CDP is Disabled (Click to Enable)";
        retryStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

// ========== CDP Functions ==========

/**
 * Get list of CDP targets
 */
function getCDPTargets() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${cdpPort}/json`, (res) => {
            let data = '';
            res.on('data', chunk => {
                data += chunk;
                // Cap payload size at 5MB
                if (data.length > 5 * 1024 * 1024) {
                    req.destroy(new Error('Response payload too large'));
                }
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(1000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

/**
 * Execute JavaScript in a target via CDP WebSocket
 */
function executeScriptInTarget(wsUrl, script) {
    return new Promise((resolve, reject) => {
        // Use native WebSocket-like approach with http upgrade
        // For simplicity, we'll use a different approach: 
        // Fetch API is not available in Node, so we use http raw request

        const url = new URL(wsUrl);
        const WebSocket = require('ws');

        try {
            const ws = new WebSocket(wsUrl);
            let resolved = false;

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: script,
                        returnByValue: true
                    }
                }));
            });

            activeWebSockets.add(ws);

            let timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    ws.close();
                    reject(new Error('WebSocket timeout'));
                }
            }, 3000);

            const cleanup = () => {
                clearTimeout(timeoutId);
                activeWebSockets.delete(ws);
            };

            ws.on('message', (data) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    try {
                        const response = JSON.parse(data.toString());
                        resolve(response);
                    } catch (e) {
                        resolve(null);
                    }
                    ws.close();
                }
            });

            ws.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(err);
                }
            });

            ws.on('close', () => {
                cleanup();
                if (!resolved) {
                    resolved = true;
                    resolve(null);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Click the Retry button via CDP
 */
let retryLimitDialogShown = false; // Flag to prevent multiple dialogs

async function clickRetryViaCDP() {
    // Check if max retry count reached (0 = unlimited)
    if (retryMaxCount > 0 && retryCurrentCount >= retryMaxCount) {
        // Show confirmation dialog only once
        if (!retryLimitDialogShown) {
            retryLimitDialogShown = true;
            const timestamp = new Date().toLocaleTimeString();
            outputChannel.appendLine(`[${timestamp}] ⚠️ Retry limit reached (${retryMaxCount}). Waiting for user confirmation...`);

            const result = await vscode.window.showWarningMessage(
                `Auto-Retry has reached the limit of ${retryMaxCount} attempts. Continue auto-retry?`,
                { modal: false },
                'Continue',
                'Stop Auto-Retry'
            );

            if (result === 'Continue') {
                retryCurrentCount = 0;
                retryLimitDialogShown = false;
                updateRetryStatusBar();
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ✅ User confirmed. Retry counter reset. Auto-retry will continue.`);
            } else {
                // User chose to stop or dismissed dialog
                autoRetryEnabled = false;
                retryLimitDialogShown = false;
                updateRetryStatusBar();
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] 🛑 Auto-retry disabled by user.`);
                vscode.window.showInformationMessage('Auto-Retry has been disabled. Use the status bar to re-enable.');
            }
        }
        return; // Don't retry until user confirms
    }

    // Debounce: prevent rapid retry attempts
    const now = Date.now();
    if (now - lastRetryAttempt < 2000) {
        return;
    }
    lastRetryAttempt = now;

    try {
        const targets = await getCDPTargets();

        // Find Antigravity Agent panel or relevant webview
        const potentialTargets = targets.filter(t => {
            const isRelevantType = t.type === 'page' || t.type === 'webview';
            if (!isRelevantType) return false;

            const hasRelevantTitle = t.title && (
                t.title.includes('Antigravity') ||
                t.title.includes('Agent') ||
                t.title.includes('Chat')
            );

            const hasRelevantUrl = t.url && (
                t.url.includes('workbench') ||
                t.url.includes('webview')
            );

            return hasRelevantTitle || hasRelevantUrl;
        });

        // JavaScript to find and click Retry button (including inside iframes)
        const clickRetryScript = `
            (function() {
                // Helper function to find and click Retry button in a document
                function findAndClickRetry(doc, location) {
                    try {
                        const buttons = doc.querySelectorAll('button');
                        for (const btn of buttons) {
                            const text = btn.textContent ? btn.textContent.trim() : '';
                            if (text === 'Retry' && !btn.disabled && btn.offsetParent !== null) {
                                btn.click();
                                return 'clicked_' + location;
                            }
                        }
                    } catch (e) {
                        return null;
                    }
                    return null;
                }
                
                // Try main document first
                let result = findAndClickRetry(document, 'main');
                if (result) return result;
                
                // Try all iframes (where Antigravity Agent panel lives)
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    try {
                        const iframe = iframes[i];
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                        if (iframeDoc) {
                            result = findAndClickRetry(iframeDoc, 'iframe_' + i);
                            if (result) return result;
                        }
                    } catch (e) {
                        // Cross-origin iframe, skip
                    }
                }
                
                return 'not_found';
            })();
        `;

        for (const target of potentialTargets) {
            if (target.webSocketDebuggerUrl) {
                try {
                    const result = await executeScriptInTarget(target.webSocketDebuggerUrl, clickRetryScript);
                    // CDP returns nested structure: result.result.result.value
                    const value = result?.result?.result?.value || result?.result?.value;
                    if (value && typeof value === 'string' && value.startsWith('clicked_')) {
                        retryCurrentCount++;
                        const timestamp = new Date().toLocaleTimeString();
                        const location = value.replace('clicked_', '');
                        const countInfo = retryMaxCount === 0 ? retryCurrentCount : `${retryCurrentCount}/${retryMaxCount}`;
                        outputChannel.appendLine(`[${timestamp}] ✅ Retry #${countInfo} clicked via CDP (target: ${target.title || target.url}, location: ${location})`);
                        outputChannel.show(true);  // Show output channel, preserve focus
                        updateRetryStatusBar(); // Update status bar with new count
                        return;
                    }
                } catch (e) {
                    // Target not accessible, continue to next
                }
            }
        }
    } catch (e) {
        // CDP not available or error, silent fail
    }
}

let isExecuting = false;

function startLoop() {
    if (autoAcceptInterval) {
        clearTimeout(autoAcceptInterval);
    }

    const loop = async () => {
        if (!enabled || isExecuting) {
            autoAcceptInterval = setTimeout(loop, 500);
            return;
        }

        isExecuting = true;
        try {
            // ========== AUTO-ACCEPT AGENT STEPS ==========
            try {
                await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
            } catch (e) { }

            // ========== AUTO-ACCEPT TERMINAL COMMANDS ==========
            try {
                await vscode.commands.executeCommand('antigravity.terminal.accept');
            } catch (e) { }
            try {
                await vscode.commands.executeCommand('antigravity.terminalCommand.accept');
            } catch (e) { }
            try {
                await vscode.commands.executeCommand('antigravity.command.accept');
            } catch (e) { }

            // ========== AUTO-CONFIRM STEP EXECUTION ==========
            try {
                await vscode.commands.executeCommand('antigravity.agent.confirmStep');
            } catch (e) { }
            try {
                await vscode.commands.executeCommand('agCockpit.confirm');
            } catch (e) { }
            try {
                await vscode.commands.executeCommand('antigravity.confirm');
            } catch (e) { }

            // ========== AUTO-ALLOW PERMISSIONS ==========
            try {
                await vscode.commands.executeCommand('antigravity.agent.allowOnce');
            } catch (e) { }
            try {
                await vscode.commands.executeCommand('antigravity.agent.allowConversation');
            } catch (e) { }
            try {
                await vscode.commands.executeCommand('agCockpit.allowOnce');
            } catch (e) { }
            try {
                await vscode.commands.executeCommand('agCockpit.allowConversation');
            } catch (e) { }
            try {
                await vscode.commands.executeCommand('antigravity.allow');
            } catch (e) { }

            // ========== AUTO-RETRY VIA CDP ==========
            if (autoRetryEnabled) {
                await clickRetryViaCDP();
            }
        } finally {
            isExecuting = false;
            autoAcceptInterval = setTimeout(loop, 500);
        }
    };

    autoAcceptInterval = setTimeout(loop, 500);
}

function deactivate() {
    if (autoAcceptInterval) {
        clearTimeout(autoAcceptInterval);
        autoAcceptInterval = null;
    }
    for (const ws of activeWebSockets) {
        try {
            ws.close();
        } catch (e) {
            // Ignore
        }
    }
    activeWebSockets.clear();
}

module.exports = {
    activate,
    deactivate
}
