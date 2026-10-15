import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = new URL('./dist/', import.meta.url).pathname;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output = new URL('../.qa/notifications/', import.meta.url).pathname;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const token = 'a'.repeat(64);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    let body = await readFile(join(root, file));
    if (file === 'index.html') {
      const enabled = url.searchParams.get('state') !== 'disabled';
      const script = `<script>
        window.__GARMIN_HUB_APP__=true; window.__HUB_API_KEY__='qa';
        window.__HUB_DEVICE_TOKEN__='${token}'; window.__HUB_NOTIFICATION_PERMISSION__='granted';
        const enabled=${enabled};
        const json=(value)=>Promise.resolve(new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}}));
        window.fetch=(input,init)=>{const path=String(input);
          if(path.includes('/api/profile'))return json({shoes:[],races:[],injuries:[],routines:[],general_notes:'',runna_ical_url:''});
          if(path.includes('/api/gear'))return json([]);
          if(path.includes('/api/recovery'))return json([]);
          if(path.includes('/api/status'))return json({checks:[],notifications:{enabled}});
          if(path.includes('/api/notifications/device/status'))return json({enabled,registered:true,preferences:{debrief:true,weekly:true,risk:true,job_failure:true}});
          if(path.includes('/api/notifications'))return json({enabled,sent:true});
          if(path.includes('/api/plan/current'))return json(null);
          if(path.includes('/api/training-balance'))return json(null);
          if(path.includes('/api/race-countdown'))return json(null);
          return json([]);
        };
        addEventListener('DOMContentLoaded',()=>{const timer=setInterval(()=>{const button=document.querySelector('button[aria-label="Settings"]');if(button){button.click();clearInterval(timer)}},50)});
      </script>`;
      body = Buffer.from(body.toString().replace('</head>', `${script}</head>`));
    }
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch (_) { response.writeHead(404).end(); }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await import('node:fs/promises').then(({ mkdir }) => mkdir(output, { recursive: true }));
const shots = [
  ['enabled-402.png', 402, 'enabled'], ['disabled-402.png', 402, 'disabled'],
  ['overflow-375.png', 375, 'enabled'], ['overflow-402.png', 402, 'enabled'],
  ['overflow-430.png', 430, 'enabled'],
];
for (const [name, width, state] of shots) {
  const profile = await mkdtemp(join(tmpdir(), 'garmin-hub-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--hide-scrollbars', '--disable-gpu',
    '--remote-debugging-port=9333', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try { target = await fetch('http://127.0.0.1:9333/json').then((value) => value.json()).then((items) => items.find((item) => item.type === 'page')); } catch (_) { /* starting */ }
  }
  if (!target) throw new Error('Chrome debugging endpoint did not start');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const call = ++id;
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== call) return;
      socket.removeEventListener('message', listener);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
    socket.addEventListener('message', listener);
    socket.send(JSON.stringify({ id: call, method, params }));
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/?state=${state}` });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const metrics = await cdp('Runtime.evaluate', {
    expression: '({width: innerWidth, scrollWidth: document.documentElement.scrollWidth})', returnByValue: true,
  });
  if (metrics.result.value.scrollWidth > metrics.result.value.width) {
    throw new Error(`${width}px viewport overflows to ${metrics.result.value.scrollWidth}px`);
  }
  const capture = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(join(output, name), Buffer.from(capture.data, 'base64'));
  socket.close(); child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}
server.close();
