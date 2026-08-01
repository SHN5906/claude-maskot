const { app, BrowserWindow, ipcMain, screen, Menu, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const WIN_W = 340;
const WIN_H = 500;
const POLL_MS = 60_000;

const REFRESH_MIN_MS = 20_000;
const STALE_MAX_MS = 10 * 60_000;

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
          body: `Batman, il ne vous reste que ${next.remainingPercent} % sur la session de 5 h.`,
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

/* ---------- Questions à Claude (via le CLI Claude Code, abonnement) ---------- */

const questionsPath = path.join(__dirname, '..', 'questions.json');
let claudeBin = null;

function resolveClaudeBin() {
  return new Promise((resolve) => {
    if (claudeBin) return resolve(claudeBin);
    execFile('/bin/zsh', ['-lc', 'which claude'], { timeout: 8000 }, (err, stdout) => {
      claudeBin = !err && stdout.trim() ? stdout.trim().split('\n').pop() : null;
      resolve(claudeBin);
    });
  });
}

ipcMain.handle('get-questions', () => {
  try {
    const list = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
    return Array.isArray(list) ? list.filter((q) => typeof q === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
});

ipcMain.handle('ask-claude', async (_e, question) => {
  const q = String(question || '').trim().slice(0, 500);
  if (!q) return { ok: false, error: 'question vide' };
  const bin = await resolveClaudeBin();
  if (!bin) return { ok: false, error: 'CLI claude introuvable' };
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-p', q, '--model', 'haiku'],
      { timeout: 90_000, cwd: app.getPath('home'), maxBuffer: 1024 * 1024 },
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
  });
});

const PERF_LABELS = {
  gym: 'Gym',
  flag: 'Drapeau',
  march: 'Marche',
  boxe: 'Boxe',
  danse: 'Danse',
  coucou: 'Coucou',
  dodo: 'Dodo',
  star: 'Étoile Claude',
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
    { label: 'Modifier les questions…', click: () => shell.openPath(questionsPath) },
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
