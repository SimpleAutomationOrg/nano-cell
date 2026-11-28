// The entry point of the INSTALLED APP.
//
// nano-cell is published as an artifact with the `desktop` capability
// (scripts/build-artifact.mjs, the /publish-app step) and installed from
// the Claude desktop app with "Install as app". There the page gets the
// person's files, child processes and a terminal — and no network access
// to this machine. So this file, which the artifact loads in place of
// app.js and chat.js, does three things before handing over to them:
//
//  1. finds the WORKSPACE: the folder on disk that holds the engine and
//     the applications (a checkout of this repository) — or makes one, by
//     downloading the repository into a folder the person names. Nothing
//     of the project is inside the artifact but the page's own code — the
//     cell, the applications, the CAD and the conversations stay on disk;
//  2. starts the engine there (`python3 viewer/serve.py --stdio`) and
//     turns every request the page makes into a message through its pipes
//     — so the viewer and the chat run exactly as they do in a browser;
//  3. tells the viewer how to save a file for the person.
//
// In a browser, served by serve.py, this file is not loaded at all.

import { startEngine, engineFetch, absolutePath, setupSteps } from './desktop-bridge.js';

const WS_KEY = 'nano.workspace';
const ui = document.createElement('div');
ui.id = 'setup';
ui.innerHTML = `
  <style>
    #setup { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: #0d1115; color: #cdd6e0; font-size: 13px; }
    #setup[hidden] { display: none; }
    #setup .card { width: min(520px, calc(100vw - 48px)); background: #151b22; border: 1px solid #2f3b4a; border-radius: 14px; padding: 22px; }
    #setup h2 { margin: 0 0 6px; font-size: 16px; color: #fff; }
    #setup p { margin: 6px 0; line-height: 1.5; color: #9fb0c0; }
    #setup input { width: 100%; box-sizing: border-box; margin: 10px 0 4px; background: #0c0f13; color: #e8eef4; border: 1px solid #2f3b4a; border-radius: 7px; padding: 8px 10px; font: 12.5px ui-monospace, monospace; }
    #setup .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
    #setup button.primary { background: #1f4f8a; border-color: #2f6cb5; color: #fff; font-weight: 600; padding: 6px 14px; }
    #setup p.warn { color: #ffb86b; animation: warnflash .6s; }
    @keyframes warnflash { from { background: #5a3a12; } to { background: transparent; } }
    #setup .picks { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    #setup .picks:empty { display: none; }
    #setup .picks button { text-align: left; font: 12px ui-monospace, monospace; padding: 7px 10px; overflow-wrap: anywhere; }
    #setup pre { margin: 10px 0 0; padding: 9px; background: #0c0f13; border-radius: 7px; color: #ff9f9f; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; }
  </style>
  <div class="card"><h2></h2><div class="body"></div><div class="row"></div></div>`;
document.body.appendChild(ui);

// one screen at a time: a title, what to say, an optional field, buttons;
// resolves with { button, value } when a button is pressed
function screen(title, lines, { field = null, buttons = [], detail = '', warn = '', choices = null } = {}) {
  ui.hidden = false;
  ui.querySelector('h2').textContent = title;
  const body = ui.querySelector('.body'), row = ui.querySelector('.row');
  body.innerHTML = ''; row.innerHTML = '';
  for (const l of lines) { const p = document.createElement('p'); p.textContent = l; body.appendChild(p); }
  if (warn) { const p = document.createElement('p'); p.className = 'warn'; p.textContent = warn; body.appendChild(p); }
  const picks = document.createElement('div');
  picks.className = 'picks';
  body.appendChild(picks);
  let input = null;
  if (field) {
    input = document.createElement('input');
    input.type = 'text'; input.value = field.value ?? ''; input.placeholder = field.placeholder ?? '';
    input.spellcheck = false;
    body.appendChild(input);
  }
  if (detail) { const pre = document.createElement('pre'); pre.textContent = detail; body.appendChild(pre); }
  return new Promise(resolve => {
    for (const c of choices ?? []) {
      const el = document.createElement('button');
      el.type = 'button'; el.textContent = c;
      el.onclick = () => resolve({ choice: c, value: c });
      picks.appendChild(el);
    }
    buttons.forEach((b, i) => {
      const el = document.createElement('button');
      el.type = 'button'; el.textContent = b;
      if (i === buttons.length - 1) el.className = 'primary';
      el.onclick = () => resolve({ button: b, value: input?.value.trim() ?? '' });
      row.appendChild(el);
    });
    input?.addEventListener('keydown', ev => { if (ev.key === 'Enter' && buttons.length) resolve({ button: buttons.at(-1), value: input.value.trim() }); });
    input?.focus();
  });
}
const busy = (title, line) => { screen(title, [line]); };

// the app's icon: a robot arm over a breadboard, drawn here (Claude uses it as drawn)
function drawIcon() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#131a22';
  g.beginPath(); g.roundRect(8, 8, 240, 240, 52); g.fill();
  g.fillStyle = '#2a3644';
  g.beginPath(); g.roundRect(40, 176, 176, 30, 8); g.fill();
  g.fillStyle = '#131a22';
  for (let x = 58; x < 210; x += 22) { g.beginPath(); g.arc(x, 191, 3.5, 0, 7); g.fill(); }
  g.strokeStyle = '#dfe7ef'; g.lineWidth = 22; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(92, 172); g.lineTo(92, 118); g.lineTo(150, 78); g.lineTo(178, 118); g.stroke();
  g.fillStyle = '#4da3ff';
  for (const [x, y] of [[92, 118], [150, 78]]) { g.beginPath(); g.arc(x, y, 13, 0, 7); g.fill(); }
  g.fillStyle = '#7fd0a0';
  g.beginPath(); g.roundRect(164, 122, 28, 20, 5); g.fill();
  return c.toDataURL('image/png');
}

async function main() {
  const desktop = await window.claude?.use?.('desktop').catch(() => null) ?? null;

  // ---- not the app's own window: offer to install it ----
  if (!desktop?.fs) {
    const state = await desktop?.install?.state().catch(() => 'unavailable') ?? 'unavailable';
    if (state === 'available') {
      for (;;) {
        await screen('Nano Cell', ['This page is the Nano Cell application. Install it to run it: it works with the files and tools on this computer.'], { buttons: ['Install as app'] });
        // (asked straight from the click above)
        const r = await desktop.install.request().catch(() => 'failed');
        if (r === 'installed') { busy('Nano Cell', 'Installing — open Nano Cell from your applications when it is ready.'); return; }
      }
    }
    busy('Nano Cell', state === 'installed'
      ? 'Nano Cell is installed on this computer: open it from your applications.'
      : 'This page works only as its desktop app, which can be installed from the Claude desktop app (open this artifact there and choose "Install as app").');
    return;
  }

  desktop.app.dock.setIcon(drawIcon()).catch(() => {});
  desktop.window.setOptions({ width: 1500, height: 950, minWidth: 1100, minHeight: 700 }).catch(() => {});

  // ---- access to files and programs: asked from a click, never on load ----
  for (;;) {
    const access = await desktop.permissions.state('full-access').catch(() => 'unavailable');
    if (access === 'granted') break;
    if (access === 'prompt') {
      await screen('Nano Cell needs this computer', [
        'This window is only the screen. The work is done by programs on this computer, in one folder: saving your applications, running the assistant, converting CAD files. Nano Cell needs access to read and write that folder and to run those programs.',
      ], { buttons: ['Continue'] });
      await desktop.permissions.request(['full-access']).catch(() => {});
    } else if (access === 'denied') {
      await screen('Nano Cell cannot work without access', ['Access to files and programs was refused. Turn it on in the app\'s permissions to continue.'], { buttons: ['Open permissions'] });
      await desktop.permissions.manage().catch(() => {});
    } else {
      await screen('Nano Cell cannot get access here', ['Access to files and programs is not available in this window (it is allowed only for an artifact of your own organization, in its installed app). Try again once that is sorted.'], { buttons: ['Try again'] });
    }
  }

  const platform = await desktop.os.platform().catch(() => 'darwin');
  const home = await desktop.os.homedir().catch(() => '~');
  const source = window.NANO_BUILD?.source ?? '';
  const isWorkspace = async dir => !!dir && await desktop.fs.exists(`${dir}/viewer/serve.py`).catch(() => false);

  // ---- the workspace, then the engine in it ----
  // look under the home folder for workspaces (a folder with viewer/serve.py and the viewer's code)
  const findWorkspaces = async () => {
    if (platform === 'win32') return [];
    const r = await desktop.childProcess.exec(
      `find "$HOME" -maxdepth 7 -type f -path '*/viewer/serve.py' -not -path '*/node_modules/*' -not -path '*/Library/*' -not -path '*/.Trash/*' -not -path '*/dist/*' 2>/dev/null | head -20`,
      { timeout: 40000 }).catch(() => ({ stdout: '' }));
    const dirs = r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.replace(/\/viewer\/serve\.py$/, ''));
    const ours = [];
    for (const d of dirs) if (await desktop.fs.exists(`${d}/viewer/cell-data.js`).catch(() => false)) ours.push(d);
    return ours;
  };
  // put a new workspace into `dir`; resolves with '' or with what went wrong
  const createWorkspace = async dir => {
    if (platform === 'win32') return { problem: 'Making a workspace is not supported on Windows yet.' };
    if (!source) return { problem: 'This build does not know where to download Nano Cell from.' };
    if (await desktop.fs.exists(dir).catch(() => false)) {
      const entries = await desktop.fs.readdir(dir).catch(() => null);
      if (!entries) return { problem: `“${dir}” is not a folder.` };
      if (entries.some(e => (e.name ?? e) !== '.DS_Store')) return { problem: `“${dir}” already has other things in it. Choose a new or empty folder for the workspace.` };
    }
    for (const step of setupSteps(source, dir)) {
      busy('Making the workspace', `${step.say}  (${dir})`);
      const r = await desktop.childProcess.exec(step.command, { timeout: 900000 }).catch(e => ({ code: 1, stderr: String(e?.message ?? e), stdout: '' }));
      if (r.code !== 0) {
        const out = `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-12).join('\n');
        const hint = /command not found/.test(out) ? 'A program it needs is missing on this computer: git, and node (with npm), must be installed.'
          : /Authentication|could not read Username|Repository not found|403|denied/i.test(out) ? 'This computer has no access to the Nano Cell repository: sign in to GitHub in git with an account that was given access, then try again.'
          : 'The detail below says what went wrong.';
        return { problem: `The workspace could not be made in “${dir}”. ${hint}`, detail: out };
      }
    }
    return {};
  };
  let workspace = localStorage.getItem(WS_KEY) ?? '';
  let problem = '', detail = '', found = null, checked = false;
  for (;;) {
    if (workspace && !checked) {
      checked = true;
      if (await isWorkspace(workspace)) {
        busy('Nano Cell', `Starting in ${workspace} …`);
        const engine = startEngine(desktop.childProcess.spawn, workspace, platform);
        try {
          await Promise.race([engine.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no answer within 30 s')), 30000))]);
          localStorage.setItem(WS_KEY, workspace);
          // from here on, every request the page makes for the cell goes to the engine
          window.fetch = engineFetch(engine, window.fetch.bind(window), { pageUrl: document.baseURI });
          break;
        } catch (e) {
          problem = `Nano Cell's local programs did not start in ${workspace}.`;
          detail = `${e.message}\n${engine.errors()}`.trim() + '\n\nThey need python3 and node on this computer, and `npm install` run once in the folder.';
        }
      } else {
        const there = await desktop.fs.exists(workspace).catch(() => false);
        problem = there
          ? `“${workspace}” exists, but it is not a Nano Cell workspace. Press Create new to make one there (if the folder is empty), or type another folder.`
          : `There is no folder “${workspace}” yet. Press Create new to make a workspace there.`;
      }
    }
    const r = await screen('Where should Nano Cell work?', [
      'Nano Cell keeps everything in one folder on this computer, its workspace: your applications, and the programs this window runs for you (saving files, the assistant, the CAD tools).',
      'First time here? Type where the folder should be and press Create new — Nano Cell is downloaded into it.',
      'Already have one? Type its path and press Open, or press Find it.',
      ...(found ? [found.length ? 'Found — pick one:' : 'No workspace was found under your home folder. Press Create new to make one.'] : []),
    ], { field: { value: workspace || '~/nano-cell', placeholder: '~/nano-cell' }, buttons: ['Find it', 'Create new', 'Open'], warn: problem, detail, choices: found });
    problem = ''; detail = '';
    if (r.button === 'Find it') {
      busy('Nano Cell', 'Looking for a workspace under your home folder …');
      found = await findWorkspaces();
      if (found.length === 1) { workspace = found[0]; found = null; checked = false; }
      continue;
    }
    found = null;
    if (!r.value) { problem = 'Type the path of the folder first.'; workspace = ''; continue; }
    workspace = absolutePath(r.value, home);
    checked = false;
    if (r.button === 'Create new' && !(await isWorkspace(workspace))) {
      const made = await createWorkspace(workspace);
      if (made.problem) { problem = made.problem; detail = made.detail ?? ''; checked = true; }
    }
  }

  // ---- what the viewer needs to know, then the viewer itself ----
  window.nanoDesktop = {
    workspace,
    // a file for the person: into Downloads, then shown there
    async saveFile(name, blob) {
      const path = `~/Downloads/${name}`;
      await desktop.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      desktop.shell.showItemInFolder(path).catch(() => {});
      return path;
    },
    changeWorkspace() { localStorage.removeItem(WS_KEY); location.reload(); },
  };
  desktop.Menu.setApplicationMenu([
    { role: 'editMenu' },                       // keeps copy, cut and paste working
    { label: 'Workspace', submenu: [
      { label: 'Show in Finder', click: () => desktop.shell.openPath(workspace).catch(() => {}) },
      { label: 'Choose Another Folder…', click: () => window.nanoDesktop.changeWorkspace() },
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => location.reload() },
    ] },
  ]).catch(() => {});

  ui.hidden = true;
  await import('./app.js');
  await import('./chat.js');
}

main().catch(e => {
  console.error(e);
  screen('Nano Cell could not start', ['Something failed while starting. The detail below says what.'], { detail: String(e?.stack ?? e) });
});
