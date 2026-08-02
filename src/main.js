const { app, BrowserWindow, ipcMain, screen, Menu, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const WIN_W = 340;
const WIN_H = 500;
const POLL_MS = 60_000;

const REFRESH_MIN_MS = 20_000;
const STALE_MAX_MS = 10 * 60_000;

// Une seule mascotte à la fois (sauf en mode capture dev)
if (!process.env.MASKOT_SHOT && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

let win = null;
let dragTimer = null;
let lastUsage = null;
let lastGood = null;
let lastAttempt = 0;

const statePath = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ ...loadState(), ...patch }));
  } catch {
    // la position n'est pas critique
  }
}

// Le token OAuth de Claude Code vit dans le trousseau macOS,
// même item que celui utilisé par la commande /usage du CLI.
function getToken() {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return reject(new Error('trousseau inaccessible'));
        try {
          const oauth = JSON.parse(stdout.trim()).claudeAiOauth || {};
          if (!oauth.accessToken) return reject(new Error('token absent du trousseau'));
          resolve({
            token: oauth.accessToken,
            subscriptionType: oauth.subscriptionType || null,
          });
        } catch {
          reject(new Error('credentials illisibles'));
        }
      }
    );
  });
}

async function fetchUsage() {
  // Mode dev : MASKOT_SHOT_MOCK=<pct utilisé> court-circuite l'API
  // (pour les captures et tester l'état « low » sans dépendre du rate-limit).
  if (process.env.MASKOT_SHOT_MOCK) {
    const used = Math.min(100, Math.max(0, Number(process.env.MASKOT_SHOT_MOCK) || 74));
    return {
      ok: true,
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt: new Date(Date.now() + 90 * 60000).toISOString(),
      severity: 'normal',
      plan: 'Max',
      weeklyPercent: 18,
      fetchedAt: Date.now(),
    };
  }
  const { token, subscriptionType } = await getToken();
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const fiveHour = data.five_hour || {};
  const used = fiveHour.utilization;
  if (typeof used !== 'number') throw new Error('réponse API inattendue');
  const session = (data.limits || []).find((l) => l.kind === 'session') || {};
  const usedPercent = Math.min(100, Math.max(0, Math.round(used)));
  return {
    ok: true,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: fiveHour.resets_at || session.resets_at || null,
    severity: session.severity || 'normal',
    plan: subscriptionType
      ? subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1)
      : null,
    weeklyPercent:
      data.seven_day && typeof data.seven_day.utilization === 'number'
        ? Math.round(data.seven_day.utilization)
        : null,
    fetchedAt: Date.now(),
  };
}

// Franchissements de seuil (25 % puis 10 % restants) → notification macOS
// + alerte spontanée de la mascotte. Grosse chute du % utilisé → la session
// s'est reset → petite fête.
const ALERT_THRESHOLDS = [25, 10];

function handleTransitions(prev, next) {
  if (!prev || !next || !win || win.isDestroyed()) return;
  if (next.usedPercent <= prev.usedPercent - 30) {
    win.webContents.send('session-reset', next);
    return;
  }
  for (const th of ALERT_THRESHOLDS) {
    if (prev.remainingPercent > th && next.remainingPercent <= th) {
      try {
        new Notification({
          title: 'Claude Maskot',
          body: `${getName()}, il ne vous reste que ${next.remainingPercent} % sur la session de 5 h.`,
        }).show();
      } catch {
        // les notifs peuvent être refusées, la bulle alerte de toute façon
      }
      win.webContents.send('usage-alert', next);
    }
  }
}

async function pushUsage() {
  // Évite de marteler l'API (elle rate-limite vite) : sous 20 s, on ressert
  // la dernière réponse.
  if (lastUsage && Date.now() - lastAttempt < REFRESH_MIN_MS) {
    return lastUsage;
  }
  lastAttempt = Date.now();
  let payload;
  let transition = null;
  try {
    payload = await fetchUsage();
    transition = { prev: lastGood, next: payload };
    lastGood = payload;
  } catch (e) {
    if (lastGood && Date.now() - lastGood.fetchedAt < STALE_MAX_MS) {
      payload = { ...lastGood, stale: true };
    } else {
      payload = { ok: false, error: String(e.message || e), fetchedAt: Date.now() };
    }
  }
  lastUsage = payload;
  if (win && !win.isDestroyed()) win.webContents.send('usage', payload);
  if (transition) handleTransitions(transition.prev, transition.next);
  return payload;
}

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - WIN_W - 24,
    y: workArea.y + workArea.height - WIN_H - 16,
  };
}

function clampToDisplays(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return defaultPosition();
  const display = screen.getAllDisplays().find(({ bounds }) => {
    return (
      x > bounds.x - WIN_W + 60 &&
      x < bounds.x + bounds.width - 60 &&
      y > bounds.y - 40 &&
      y < bounds.y + bounds.height - 60
    );
  });
  if (!display) return defaultPosition();
  // Garde la fenêtre entière dans l'écran (la mascotte est ancrée en bas :
  // si la fenêtre grandit d'une version à l'autre, on remonte y).
  const wa = display.workArea;
  return {
    x: Math.min(Math.max(x, wa.x), wa.x + wa.width - WIN_W),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - WIN_H),
  };
}

function createWindow() {
  const state = loadState();
  const { x, y } = clampToDisplays(state.x, state.y);

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Fenêtre traversante par défaut : seule la zone du mascot capte la souris
  // (le renderer bascule via set-ignore au survol).
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.on('did-finish-load', () => {
    if (lastUsage) win.webContents.send('usage', lastUsage);
  });

  win.on('closed', () => {
    win = null;
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.on('set-ignore', (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});

ipcMain.on('drag-start', () => {
  if (!win || dragTimer) return;
  const [wx, wy] = win.getPosition();
  const cursor = screen.getCursorScreenPoint();
  const offX = cursor.x - wx;
  const offY = cursor.y - wy;
  dragTimer = setInterval(() => {
    if (!win) return;
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - offX, p.y - offY);
  }, 16);
});

ipcMain.on('drag-end', () => {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (win) {
    const [x, y] = win.getPosition();
    saveState({ x, y });
  }
});

ipcMain.handle('refresh-usage', () => pushUsage());

/* ---------- Config : le petit nom et le dossier de contexte ---------- */

function getName() {
  const n = String(loadState().name || '').trim();
  return n || 'Batman';
}

function getFolder() {
  const f = loadState().folder;
  try {
    if (f && fs.statSync(f).isDirectory()) return f;
  } catch {
    // dossier supprimé depuis → retombe sur Général
  }
  return null;
}

function configPayload() {
  const st = loadState();
  return {
    name: getName(),
    folder: getFolder(),
    folders: Array.isArray(st.folders) ? st.folders : [],
  };
}

function sendConfig() {
  if (win && !win.isDestroyed()) win.webContents.send('config', configPayload());
}

ipcMain.handle('get-config', () => configPayload());

ipcMain.handle('set-name', (_e, name) => {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  saveState({ name: clean || null });
  sendConfig();
  return configPayload();
});

// Menu natif : choisir dans quel dossier Claude va chercher pour répondre
ipcMain.on('folder-menu', () => {
  if (!win) return;
  const home = app.getPath('home');
  const st = loadState();
  const folders = (Array.isArray(st.folders) ? st.folders : []).filter((f) => {
    try {
      return fs.statSync(f).isDirectory();
    } catch {
      return false;
    }
  });
  const current = getFolder();
  const pick = async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Où Claude doit-il aller pour répondre ?',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return;
    const folder = res.filePaths[0];
    saveState({
      folder,
      folders: [folder, ...folders.filter((f) => f !== folder)].slice(0, 5),
    });
    sendConfig();
  };
  Menu.buildFromTemplate([
    {
      label: 'Général (aucun dossier)',
      type: 'radio',
      checked: !current,
      click: () => {
        saveState({ folder: null });
        sendConfig();
      },
    },
    ...(folders.length ? [{ type: 'separator' }] : []),
    ...folders.map((f) => ({
      label: f.startsWith(home) ? `~${f.slice(home.length)}` : f,
      type: 'radio',
      checked: current === f,
      click: () => {
        saveState({ folder: f });
        sendConfig();
      },
    })),
    { type: 'separator' },
    { label: 'Choisir un dossier…', click: pick },
  ]).popup({ window: win });
});

/* ---------- Questions à Claude (via le CLI Claude Code, abonnement) ---------- */

let claudeBin = null;

// Lancé depuis le Finder (wrapper .app), le PATH de launchd est minimal et
// `zsh -lc` ne lit pas ~/.zshrc : on teste d'abord les emplacements connus.
const CLAUDE_BIN_CANDIDATES = [
  path.join(app.getPath('home'), '.local', 'bin', 'claude'),
  path.join(app.getPath('home'), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

function resolveClaudeBin() {
  return new Promise((resolve) => {
    if (claudeBin) return resolve(claudeBin);
    const found = CLAUDE_BIN_CANDIDATES.find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (found) {
      claudeBin = found;
      return resolve(claudeBin);
    }
    execFile('/bin/zsh', ['-lc', 'which claude'], { timeout: 8000 }, (err, stdout) => {
      claudeBin = !err && stdout.trim() ? stdout.trim().split('\n').pop() : null;
      resolve(claudeBin);
    });
  });
}

ipcMain.handle('ask-claude', async (_e, question) => {
  const q = String(question || '').trim().slice(0, 500);
  if (!q) return { ok: false, error: 'question vide' };
  const bin = await resolveClaudeBin();
  if (!bin) return { ok: false, error: 'CLI claude introuvable' };
  const folder = getFolder();
  const persona = `Réponds en français, de façon concise, en texte brut sans Markdown. L'utilisateur s'appelle « ${getName()} » — adresse-toi à lui par ce nom quand c'est naturel.`;
  // PATH enrichi pour les hooks de l'utilisateur (node, etc.), absents du
  // PATH minimal de launchd quand le widget est lancé depuis le Finder
  const envPath = [
    ...new Set([
      path.dirname(bin),
      path.join(app.getPath('home'), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      ...(process.env.PATH || '').split(':'),
    ]),
  ]
    .filter(Boolean)
    .join(':');
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['-p', q, '--model', 'haiku', '--append-system-prompt', persona],
      {
        // Le dossier choisi devient le cwd : Claude peut lire le projet
        timeout: 150_000,
        cwd: folder || app.getPath('home'),
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: envPath },
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: String(stderr || err.message || 'erreur').trim().slice(0, 200),
          });
        } else {
          resolve({ ok: true, answer: stdout.trim() });
        }
      }
    );
    // stdin fermé, sinon claude attend 3 s des données qui ne viendront pas
    // (execFile ignore l'option stdio : on ferme le flux à la main)
    child.stdin.end();
  });
});

/* ---------- Ouverture au démarrage (LaunchAgent) ---------- */

const launchAgentPath = path.join(
  app.getPath('home'),
  'Library',
  'LaunchAgents',
  'com.claude-maskot.plist'
);

function isAutoStartOn() {
  return fs.existsSync(launchAgentPath);
}

function setAutoStart(on) {
  try {
    if (on) {
      // RunAtLoad ne s'activera qu'au prochain login (pas de launchctl load
      // maintenant : ça lancerait une deuxième mascotte tout de suite).
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-maskot</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${path.join(__dirname, '..')}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
      fs.mkdirSync(path.dirname(launchAgentPath), { recursive: true });
      fs.writeFileSync(launchAgentPath, plist);
    } else {
      execFile('launchctl', ['unload', launchAgentPath], () => {
        try {
          fs.unlinkSync(launchAgentPath);
        } catch {
          // déjà supprimé
        }
      });
    }
  } catch {
    // sans droits sur ~/Library/LaunchAgents, l'option reste sans effet
  }
}

const PERF_LABELS = {
  gym: 'Gym',
  flag: 'Drapeau',
  march: 'Marche',
  boxe: 'Boxe',
  danse: 'Danse',
  coucou: 'Coucou',
  dodo: 'Dodo',
};

ipcMain.on('context-menu', () => {
  if (!win) return;
  Menu.buildFromTemplate([
    { label: 'Actualiser', click: () => pushUsage() },
    {
      label: 'Jouer une animation',
      submenu: Object.entries(PERF_LABELS).map(([name, label]) => ({
        label,
        click: () => win.webContents.send('play-perf', name),
      })),
    },
    {
      label: "Comment il m'appelle…",
      click: () => win.webContents.send('edit-name'),
    },
    {
      label: "Ouvrir au démarrage de l'ordinateur",
      type: 'checkbox',
      checked: isAutoStartOn(),
      click: (item) => setAutoStart(item.checked),
    },
    { type: 'separator' },
    { label: 'Quitter Claude Maskot', click: () => app.quit() },
  ]).popup({ window: win });
});

// Mode dev : MASKOT_SHOT=/chemin.png pnpm start → capture la fenêtre bulle
// ouverte puis quitte. Avec MASKOT_SHOT_PERF=gym|flag|march|confetti, capture
// l'animation demandée en cours de lecture à la place.
function devScreenshot() {
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        // La vraie souris ne doit pas interférer avec la scène capturée
        win.setIgnoreMouseEvents(true);
        const perf = (process.env.MASKOT_SHOT_PERF || '').replace(/[^a-z]/g, '');
        if (process.env.MASKOT_SHOT_ASK) {
          await win.webContents.executeJavaScript(
            `window.__maskotAsk(${JSON.stringify(String(process.env.MASKOT_SHOT_ASK))})`
          );
          await new Promise((r) => setTimeout(r, Number(process.env.MASKOT_SHOT_AT || 2000)));
        } else if (perf) {
          await win.webContents.executeJavaScript(
            `window.performances.play('${perf}')`
          );
          await new Promise((r) => setTimeout(r, Number(process.env.MASKOT_SHOT_AT || 900)));
        } else {
          await win.webContents.executeJavaScript('window.__maskotShowBubble()');
          await new Promise((r) => setTimeout(r, Number(process.env.MASKOT_SHOT_AT || 1800)));
        }
        const frameCount = Number(process.env.MASKOT_SHOT_FRAMES || 0);
        if (frameCount > 0) {
          // Rafale de frames (pour fabriquer des GIF de démo)
          const every = Number(process.env.MASKOT_SHOT_EVERY || 80);
          for (let i = 0; i < frameCount; i++) {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(
              `${process.env.MASKOT_SHOT}-${String(i).padStart(3, '0')}.png`,
              img.toPNG()
            );
            await new Promise((r) => setTimeout(r, every));
          }
          console.log('shot saved:', `${process.env.MASKOT_SHOT}-*.png (${frameCount})`);
        } else {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.MASKOT_SHOT, img.toPNG());
          console.log('shot saved:', process.env.MASKOT_SHOT);
        }
      } catch (e) {
        console.error('shot failed:', e);
      }
      app.quit();
    }, 2000);
  });
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createWindow();
  if (process.env.MASKOT_SHOT) devScreenshot();
  pushUsage();
  setInterval(pushUsage, POLL_MS);
});

app.on('window-all-closed', () => {
  app.quit();
});
