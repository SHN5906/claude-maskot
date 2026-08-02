const { app, BrowserWindow, ipcMain, screen, Menu, Notification, dialog, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const WIN_W = 340;
const WIN_H = 500;
// Géométrie du renderer à l'échelle 1 : #stage a 10px de padding et le svg
// mascotte rend à 104 × 86/107 ≈ 84px de haut. Sert à convertir position
// fenêtre ↔ position mascotte à l'écran selon l'ancrage.
const STAGE_PAD = 10;
const MASCOT_H = 84;
// En ancrage haut, les animations (saut, danse, scènes) montent au-dessus de
// la tête : il leur faut cette marge dans la fenêtre, macOS interdisant de
// déborder au-dessus de la zone de travail. Doit suivre le padding-top de
// body.flip #stage dans style.css.
const FLIP_HEADROOM = 44;
const POLL_MS = 60_000;

// Échelle du widget selon l'écran : pleine taille à partir de ~1200 pt de
// hauteur utile (grand moniteur), réduction linéaire en dessous (écran de
// MacBook ≈ 0,75–0,8), plancher à 70 % pour que la bulle reste lisible.
// Le renderer suit via setZoomFactor : toute la géométrie ci-dessus est
// exprimée à l'échelle 1 et convertie par s().
const SCALE_REF_H = 1200;
const SCALE_MIN = 0.7;
let scale = 1;

const s = (v) => Math.round(v * scale);
const winW = () => s(WIN_W);
const winH = () => s(WIN_H);
// Haut de la mascotte dans la fenêtre, selon l'ancrage
const mascotTopBottom = () => winH() - s(STAGE_PAD) - s(MASCOT_H); // ancrage bas (défaut)
const mascotTopTop = () => s(FLIP_HEADROOM); // ancrage haut

// Taille choisie dans le menu clic droit : « auto » suit l'écran, les autres
// valeurs sont des échelles fixes.
const SIZE_CHOICES = [
  { value: 'auto', label: 'Auto (selon l’écran)' },
  { value: '1', label: 'Normale (100 %)' },
  { value: '0.85', label: 'Moyenne (85 %)' },
  { value: '0.7', label: 'Petite (70 %)' },
];

function getSizeMode() {
  const v = String(loadState().size || 'auto');
  return SIZE_CHOICES.some((c) => c.value === v) ? v : 'auto';
}

function scaleForDisplay(display) {
  // Captures dev : échelle forcée (MASKOT_SHOT_SCALE) ou 1, pour des images
  // reproductibles quel que soit l'écran de la machine.
  if (process.env.MASKOT_SHOT) {
    const forced = Number(process.env.MASKOT_SHOT_SCALE);
    return forced ? Math.min(1, Math.max(SCALE_MIN, forced)) : 1;
  }
  const mode = getSizeMode();
  if (mode !== 'auto') return Number(mode);
  return Math.min(1, Math.max(SCALE_MIN, display.workArea.height / SCALE_REF_H));
}

// Centre du corps de la mascotte à l'écran pour une fenêtre posée en (x, y) :
// c'est ce point qui décide de quel écran elle dépend.
function mascotScreenAnchor(x, y) {
  return {
    x: x + Math.round(winW() / 2),
    y: y + (flip ? mascotTopTop() : mascotTopBottom()) + Math.round(s(MASCOT_H) / 2),
  };
}

const REFRESH_MIN_MS = 20_000;
const STALE_MAX_MS = 10 * 60_000;

// Une seule mascotte à la fois (sauf en mode capture dev)
if (!process.env.MASKOT_SHOT && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

let win = null;
let dragTimer = null;
// Ancrage inversé : mascotte en haut de la fenêtre, bulle ouverte vers le bas.
// Activé quand la mascotte est trop haute pour laisser la bulle au-dessus.
let flip = false;
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
// Le CLI (≥ 2.1.x) écrit l'item avec acct=<utilisateur> ; un item legacy
// de même service avec acct="unknown" peut coexister et ne contenir que
// mcpOAuth — il faut donc chercher avec -a d'abord, sinon on peut tomber
// sur le mauvais item.
function readKeychainItem(args) {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', ...args, '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? null : stdout.trim())
    );
  });
}

async function getToken() {
  const account = os.userInfo().username;
  const candidates = [
    await readKeychainItem(['-a', account]),
    await readKeychainItem([]),
  ];
  let found = false;
  for (const raw of candidates) {
    if (raw === null) continue;
    found = true;
    try {
      const oauth = JSON.parse(raw).claudeAiOauth || {};
      if (oauth.accessToken) {
        return {
          token: oauth.accessToken,
          subscriptionType: oauth.subscriptionType || null,
        };
      }
    } catch {
      throw new Error('credentials illisibles');
    }
  }
  throw new Error(found ? 'token absent du trousseau' : 'trousseau inaccessible');
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
  if (!res.ok) {
    // 404/410 : l'endpoint usage (non documenté) a probablement changé côté
    // Anthropic — le message oriente vers une mise à jour du widget
    if (res.status === 404 || res.status === 410) {
      throw new Error(`API ${res.status} — endpoint changé ? Vérifie les mises à jour du widget`);
    }
    throw new Error(`API ${res.status}`);
  }
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
    x: workArea.x + workArea.width - winW() - 24,
    y: workArea.y + workArea.height - winH() - 16,
  };
}

function clampToDisplays(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return defaultPosition();
  const display = screen.getAllDisplays().find(({ bounds }) => {
    return (
      x > bounds.x - winW() + 60 &&
      x < bounds.x + bounds.width - 60 &&
      y > bounds.y - 40 &&
      y < bounds.y + bounds.height - 60
    );
  });
  if (!display) {
    flip = false;
    return defaultPosition();
  }
  const wa = display.workArea;
  const cx = Math.min(Math.max(x, wa.x), wa.x + wa.width - winW());
  if (flip) {
    // Ancrage haut : la fenêtre peut déborder sous l'écran, seule la
    // mascotte (en haut de la fenêtre) doit rester entièrement visible.
    return {
      x: cx,
      y: Math.min(Math.max(y, wa.y), wa.y + wa.height - (mascotTopTop() + s(MASCOT_H))),
    };
  }
  // Garde la fenêtre entière dans l'écran (la mascotte est ancrée en bas :
  // si la fenêtre grandit d'une version à l'autre, on remonte y).
  return {
    x: cx,
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - winH()),
  };
}

function setFlip(next) {
  if (flip === next) return;
  flip = next;
  if (win && !win.isDestroyed()) win.webContents.send('flip', flip);
}

// Redimensionne fenêtre + rendu quand l'écran d'accueil change, en gardant
// la mascotte au même endroit (point fixe : son haut selon l'ancrage).
function applyScale(display) {
  const next = scaleForDisplay(display);
  if (!win || win.isDestroyed() || Math.abs(next - scale) < 0.01) return false;
  const [wx, wy] = win.getPosition();
  const anchorX = wx + winW() / 2;
  const anchorY = wy + (flip ? mascotTopTop() : mascotTopBottom());
  scale = next;
  win.webContents.setZoomFactor(scale);
  const { x, y } = clampToDisplays(
    Math.round(anchorX - winW() / 2),
    anchorY - (flip ? mascotTopTop() : mascotTopBottom())
  );
  // resizable: false bloque aussi le redimensionnement programmatique sur
  // certaines plateformes : on l'ouvre le temps du setBounds.
  win.setResizable(true);
  win.setBounds({ x, y, width: winW(), height: winH() });
  win.setResizable(false);
  return true;
}

// Réapplique l'échelle là où la mascotte se trouve (taille changée dans le
// menu, écran branché/débranché, résolution modifiée).
function rescaleToCurrentDisplay() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  if (applyScale(screen.getDisplayNearestPoint(mascotScreenAnchor(x, y)))) {
    const [nx, ny] = win.getPosition();
    saveState({ x: nx, y: ny });
  }
}

function createWindow() {
  const state = loadState();
  flip = Boolean(state.flip) || Boolean(process.env.MASKOT_SHOT_FLIP);
  // L'échelle dépend de l'écran où la mascotte va apparaître : position
  // dégrossie à l'échelle 1, puis re-clampée à la bonne taille.
  const rough = clampToDisplays(state.x, state.y);
  scale = scaleForDisplay(
    screen.getDisplayNearestPoint(mascotScreenAnchor(rough.x, rough.y))
  );
  const { x, y } = clampToDisplays(state.x, state.y);

  win = new BrowserWindow({
    width: winW(),
    height: winH(),
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
    win.webContents.setZoomFactor(scale);
    if (lastUsage) win.webContents.send('usage', lastUsage);
    if (flip) win.webContents.send('flip', true);
    if (musicState.active) win.webContents.send('music', musicState);
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
  // Offset curseur → haut de la mascotte à l'écran : stable même si
  // l'ancrage change en cours de drag (la fenêtre saute, pas la mascotte).
  const offY = cursor.y - (wy + (flip ? mascotTopTop() : mascotTopBottom()));
  dragTimer = setInterval(() => {
    if (!win) return;
    const p = screen.getCursorScreenPoint();
    const mascotY = p.y - offY;
    const wa = screen.getDisplayNearestPoint(p).workArea;
    // Plus assez de place au-dessus pour la bulle → la mascotte s'ancre en
    // haut de la fenêtre et la bulle s'ouvrira vers le bas.
    setFlip(mascotY - mascotTopBottom() < wa.y);
    win.setPosition(
      p.x - offX,
      flip ? Math.max(wa.y, mascotY - mascotTopTop()) : mascotY - mascotTopBottom()
    );
  }, 16);
});

ipcMain.on('drag-end', () => {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (win) {
    // Déposée sur un autre écran → la mascotte adopte l'échelle de cet écran
    const [px, py] = win.getPosition();
    applyScale(screen.getDisplayNearestPoint(mascotScreenAnchor(px, py)));
    const [x, y] = win.getPosition();
    saveState({ x, y, flip });
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

// Une conversation par dossier de contexte : le session_id renvoyé par le CLI
// permet d'enchaîner les questions avec --resume. Persisté dans state.json
// pour que les fils survivent aux redémarrages du widget.
let askSessions = null;

function getAskSessions() {
  if (!askSessions) {
    askSessions = new Map(Object.entries(loadState().askSessions || {}));
  }
  return askSessions;
}

function saveAskSession(key, sessionId) {
  const sessions = getAskSessions();
  if (sessionId) sessions.set(key, sessionId);
  else sessions.delete(key);
  saveState({ askSessions: Object.fromEntries(sessions) });
}

// Modèle des réponses, choisi dans le menu clic droit
const ASK_MODELS = {
  haiku: 'Haiku (rapide)',
  sonnet: 'Sonnet (équilibré)',
  opus: 'Opus (soigné)',
  fable: 'Fable (maximal)',
};

function getModel() {
  const m = String(loadState().model || '');
  return ASK_MODELS[m] ? m : 'haiku';
}

function sendAsk(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('ask-claude', async (_e, question, files) => {
  const q = String(question || '').trim().slice(0, 500);
  if (!q) return { ok: false, error: 'question vide' };
  const bin = await resolveClaudeBin();
  if (!bin) return { ok: false, error: 'CLI claude introuvable' };
  // Fichiers déposés dans la bulle : validés ici, joints au prompt pour que
  // Claude les lise (le CLI sait lire un chemin absolu, images et PDF compris)
  const attachments = (Array.isArray(files) ? files : [])
    .slice(0, 3)
    .map((f) => String(f))
    .filter((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
  const prompt = attachments.length
    ? `${q}\n\nFichier(s) joint(s) — lis-les pour répondre :\n${attachments.map((f) => `- ${f}`).join('\n')}`
    : q;
  const folder = getFolder();
  const folderKey = folder || '';
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

  const run = (resumeId) =>
    new Promise((resolve) => {
      const args = ['-p', prompt, '--model', getModel(), '--append-system-prompt', persona];
      if (resumeId) args.push('--resume', resumeId);
      // stream-json : la réponse arrive en deltas, poussés à la bulle au fil
      // de l'eau (le CLI exige --verbose avec ce format en mode -p)
      args.push('--output-format', 'stream-json', '--include-partial-messages', '--verbose');
      const child = spawn(bin, args, {
        // Le dossier choisi devient le cwd : Claude peut lire le projet
        cwd: folder || app.getPath('home'),
        env: { ...process.env, PATH: envPath },
        // stdin fermé, sinon claude attend 3 s des données qui ne viendront pas
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 150_000,
      });
      let buffer = '';
      let result = null;
      let stderrTail = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.type === 'stream_event') {
            const ev = msg.event || {};
            // Seul le texte de la réponse est affiché (pas le thinking)
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              sendAsk('ask-delta', ev.delta.text);
            }
          } else if (msg.type === 'result') {
            result = msg;
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-400);
      });
      child.on('error', (e) => {
        resolve({ ok: false, error: String(e.message || 'erreur').slice(0, 200) });
      });
      child.on('close', (_code, signal) => {
        if (result && !result.is_error && typeof result.result === 'string') {
          if (result.session_id) saveAskSession(folderKey, result.session_id);
          resolve({ ok: true, answer: result.result.trim() });
        } else if (signal) {
          resolve({ ok: false, error: 'délai dépassé', resumed: Boolean(resumeId) });
        } else {
          const raw = (result && (result.result || result.error)) || stderrTail || 'erreur';
          resolve({
            ok: false,
            error: String(raw).trim().slice(0, 200),
            resumed: Boolean(resumeId),
          });
        }
      });
    });

  let res = await run(getAskSessions().get(folderKey) || null);
  if (!res.ok && res.resumed) {
    // La session a pu expirer côté CLI : on repart d'une conversation neuve
    saveAskSession(folderKey, null);
    sendAsk('ask-reset');
    res = await run(null);
  }
  delete res.resumed;
  return res;
});

/* ---------- Musique : casque + contrôles (media-control, MediaRemote) ---------- */

// Détection système (Spotify, Musique, YouTube…) via le CLI media-control
// (brew install media-control) : depuis macOS 15.4, MediaRemote est réservé
// aux process Apple, ce CLI passe par /usr/bin/perl signé Apple. Absent →
// la fonction est invisible, rien d'autre ne change.
const MEDIA_CONTROL_CANDIDATES = [
  '/opt/homebrew/bin/media-control',
  '/usr/local/bin/media-control',
];
// Pause prolongée → on considère l'écoute terminée (MediaRemote garde des
// entrées périmées : sans ça, le casque resterait toute la journée).
const MUSIC_PAUSE_TIMEOUT_MS = 15 * 60_000;
const MUSIC_RESPAWN_DELAY_MS = 15_000;
// Un process qui meurt en moins de 60 s est « mort-né » ; 5 d'affilée →
// on abandonne pour la session au lieu de relancer en boucle.
const MUSIC_FAST_DEATH_MS = 60_000;
const MUSIC_MAX_FAST_DEATHS = 5;

let mediaControlBin = null;
let musicProc = null;
let musicRaw = {}; // dernier payload du stream, fusionné (mode diff)
let musicState = { active: false, playing: false, title: null, artist: null };
let musicPauseTimer = null;
let musicFastDeaths = 0;
let musicSpawnedAt = 0;

function resolveMediaControl() {
  return new Promise((resolve) => {
    if (mediaControlBin) return resolve(mediaControlBin);
    const found = MEDIA_CONTROL_CANDIDATES.find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (found) {
      mediaControlBin = found;
      return resolve(mediaControlBin);
    }
    execFile('/bin/zsh', ['-lc', 'which media-control'], { timeout: 8000 }, (err, stdout) => {
      mediaControlBin = !err && stdout.trim() ? stdout.trim().split('\n').pop() : null;
      resolve(mediaControlBin);
    });
  });
}

function setMusicState(next) {
  const changed =
    next.active !== musicState.active ||
    next.playing !== musicState.playing ||
    next.title !== musicState.title ||
    next.artist !== musicState.artist;
  musicState = next;
  if (!changed) return;
  if (process.env.MASKOT_MUSIC_DEBUG) console.log('[music]', JSON.stringify(musicState));
  if (win && !win.isDestroyed()) win.webContents.send('music', musicState);
}

function updateFromMusicPayload(payload, diff) {
  musicRaw = diff ? { ...musicRaw, ...payload } : payload;
  const hasTrack = Boolean(musicRaw.title);
  const playing = hasTrack && Boolean(musicRaw.playing);
  clearTimeout(musicPauseTimer);
  musicPauseTimer = null;
  if (hasTrack && !playing) {
    musicPauseTimer = setTimeout(() => {
      musicRaw = {};
      setMusicState({ active: false, playing: false, title: null, artist: null });
    }, MUSIC_PAUSE_TIMEOUT_MS);
  }
  setMusicState({
    active: hasTrack,
    playing,
    title: musicRaw.title || null,
    artist: musicRaw.artist || null,
  });
}

function spawnMusicStream() {
  musicSpawnedAt = Date.now();
  // --no-artwork : sans lui, chaque update embarque des centaines de Ko
  // de pochette en base64 ; --debounce lisse les rafales d'événements.
  musicProc = spawn(mediaControlBin, ['stream', '--no-artwork', '--debounce=250'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let buffer = '';
  musicProc.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'data' && msg.payload) {
        updateFromMusicPayload(msg.payload, Boolean(msg.diff));
      }
    }
  });
  musicProc.on('error', () => {
    // spawn impossible : close suit et gère la relance
  });
  musicProc.on('close', () => {
    musicProc = null;
    musicFastDeaths =
      Date.now() - musicSpawnedAt < MUSIC_FAST_DEATH_MS ? musicFastDeaths + 1 : 0;
    if (musicFastDeaths >= MUSIC_MAX_FAST_DEATHS) {
      updateFromMusicPayload({}, false);
      return;
    }
    setTimeout(() => {
      if (!musicProc) spawnMusicStream();
    }, MUSIC_RESPAWN_DELAY_MS);
  });
}

async function startMusicWatch() {
  // Mode dev : MASKOT_MUSIC_MOCK=playing|paused simule une piste sans
  // dépendre d'un vrai lecteur (captures README, tests d'UI).
  if (process.env.MASKOT_MUSIC_MOCK) {
    updateFromMusicPayload(
      {
        title: 'All Along the Watchtower',
        artist: 'Jimi Hendrix',
        playing: process.env.MASKOT_MUSIC_MOCK !== 'paused',
      },
      false
    );
    return;
  }
  if (await resolveMediaControl()) spawnMusicStream();
}

ipcMain.on('music-toggle', () => {
  if (process.env.MASKOT_MUSIC_MOCK) {
    updateFromMusicPayload({ ...musicRaw, playing: !musicRaw.playing }, false);
    return;
  }
  if (mediaControlBin) execFile(mediaControlBin, ['toggle-play-pause'], () => {});
});

ipcMain.on('music-next', () => {
  if (!process.env.MASKOT_MUSIC_MOCK && mediaControlBin) {
    execFile(mediaControlBin, ['next-track'], () => {});
  }
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
      label: 'Taille',
      submenu: SIZE_CHOICES.map(({ value, label }) => ({
        label,
        type: 'radio',
        checked: getSizeMode() === value,
        click: () => {
          saveState({ size: value === 'auto' ? null : value });
          rescaleToCurrentDisplay();
        },
      })),
    },
    {
      label: "Comment il m'appelle…",
      click: () => win.webContents.send('edit-name'),
    },
    {
      label: 'Modèle des réponses',
      submenu: Object.entries(ASK_MODELS).map(([value, label]) => ({
        label,
        type: 'radio',
        checked: getModel() === value,
        click: () => saveState({ model: value }),
      })),
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

/* ---------- Vérification de mise à jour (releases GitHub) ---------- */

const RELEASES_PAGE = 'https://github.com/SHN5906/claude-maskot/releases/latest';

function isNewerVersion(remote, local) {
  const r = String(remote).replace(/^v/, '').split('.').map(Number);
  const l = String(local).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdate() {
  try {
    const res = await fetch(
      'https://api.github.com/repos/SHN5906/claude-maskot/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) return;
    const tag = String((await res.json()).tag_name || '');
    if (!tag || !isNewerVersion(tag, app.getVersion())) return;
    // Une seule notification par version, pas de harcèlement à chaque lancement
    if (loadState().updateNotified === tag) return;
    saveState({ updateNotified: tag });
    const notif = new Notification({
      title: 'Claude Maskot',
      body: `La version ${tag.replace(/^v/, '')} est disponible — clique pour la récupérer.`,
    });
    notif.on('click', () => shell.openExternal(RELEASES_PAGE));
    notif.show();
  } catch {
    // hors-ligne, rate-limit GitHub ou notifs refusées : on retentera
  }
}

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
        if (process.env.MASKOT_SHOT_MUSIC) {
          const state = await win.webContents.executeJavaScript('window.__maskotMusicControls()');
          console.log('music-controls state:', JSON.stringify(state));
          // MASKOT_SHOT_MUSIC=click : clique le bouton pause/play avant la
          // capture (teste toute la chaîne clic → IPC → état → icône)
          if (process.env.MASKOT_SHOT_MUSIC === 'click') {
            await win.webContents.executeJavaScript(
              "document.getElementById('music-toggle-btn').click()"
            );
          }
          await new Promise((r) => setTimeout(r, Number(process.env.MASKOT_SHOT_AT || 800)));
        } else if (process.env.MASKOT_SHOT_ASK) {
          await win.webContents.executeJavaScript(
            `window.__maskotAsk(${JSON.stringify(String(process.env.MASKOT_SHOT_ASK))}, ${JSON.stringify(process.env.MASKOT_SHOT_FILE || null)})`
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
  startMusicWatch();
  // Écran branché/débranché ou résolution modifiée : l'échelle peut changer
  screen.on('display-added', rescaleToCurrentDisplay);
  screen.on('display-removed', rescaleToCurrentDisplay);
  screen.on('display-metrics-changed', rescaleToCurrentDisplay);
  // ⌥⌘M depuis n'importe quelle app : la bulle s'ouvre prête à taper
  // (échec silencieux si le raccourci est déjà pris ailleurs)
  globalShortcut.register('Alt+Command+M', () => {
    if (!win || win.isDestroyed()) return;
    app.focus({ steal: true });
    win.focus();
    win.webContents.send('focus-ask');
  });
  if (process.env.MASKOT_SHOT) devScreenshot();
  pushUsage();
  setInterval(pushUsage, POLL_MS);
  setTimeout(checkForUpdate, 15_000);
  setInterval(checkForUpdate, 24 * 3_600_000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (musicProc) musicProc.kill();
});

app.on('window-all-closed', () => {
  app.quit();
});
