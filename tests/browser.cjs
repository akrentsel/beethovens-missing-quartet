// Minimal Chrome DevTools Protocol driver (no npm available here).
const { spawn } = require('child_process');
const fs = require('fs');
const CHROME = process.env.CHROME || process.env.HOME + '/.agent-browser/engines/chrome-headless-shell/bin/chrome-headless-shell';

async function launch({ width = 1000, height = 900, port = 9360 } = {}) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`,
    '--user-data-dir=/tmp/missing-works-main-chrome', 'about:blank',
  ], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch (e) { await new Promise(r => setTimeout(r, 200)); }
  }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', m => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    else if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    else if (msg.method === 'Network.loadingFailed') logs.push('NETFAIL: ' + msg.params.errorText);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const page = {
    logs, send,
    async open(url) { await send('Page.navigate', { url }); await new Promise(r => setTimeout(r, 2500)); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async shot(file, full = false) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    async close() { try { ws.close(); } catch (e) { } proc.kill(); },
  };
  return page;
}
module.exports = { launch };
