(() => {
  const hot = document.getElementById('hot');
  const mascot = document.getElementById('mascot');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const bubbleSub = document.getElementById('bubble-sub');
  const meterFill = document.getElementById('meter-fill');
  const ctxFolder = document.getElementById('ctx-folder');
  const askAnswer = document.getElementById('ask-answer');
  const askInput = document.getElementById('ask-input');

  let lastUsage = null;
  let bubbleOpen = false;
  let hideTimer = null;

  /* ---------- Config : petit nom + dossier de contexte ---------- */

  const ASK_PLACEHOLDER = 'Pose une question à Claude…';
  let config = { name: 'Batman', folder: null, folders: [] };
  let nameMode = false;

  function applyConfig(c) {
    if (!c) return;
    config = c;
    ctxFolder.textContent = c.folder ? c.folder.split('/').pop() : 'Général';
    ctxFolder.title = c.folder
      ? c.folder
      : 'Question générale — clique pour choisir un dossier où Claude ira chercher';
    if (bubbleOpen) renderUsage(lastUsage);
  }

  window.maskot.getConfig().then(applyConfig);
  window.maskot.onConfig(applyConfig);
  ctxFolder.addEventListener('click', () => window.maskot.folderMenu());

  function enterNameEdit() {
    if (nameMode) return;
    nameMode = true;
    clearTimeout(hideTimer);
    askInput.value = config.name;
    askInput.placeholder = 'Comment veux-tu qu’il t’appelle ?';
    askInput.focus();
    askInput.select();
  }

  function exitNameEdit() {
    nameMode = false;
    askInput.value = '';
    askInput.placeholder = ASK_PLACEHOLDER;
  }

  window.maskot.onEditName(() => {
    showBubble();
    enterNameEdit();
  });

  /* ---------- Affichage de la conso ---------- */

  function renderUsage(data) {
    lastUsage = data;
    if (!bubbleOpen) return;

    if (!data || !data.ok) {
      bubbleText.textContent = `${config.name}, je n’arrive pas à lire la session. Ouvre Claude Code pour te reconnecter.`;
      bubbleSub.textContent = data && data.error ? `(${data.error})` : '';
      meterFill.style.width = '0%';
      bubble.classList.remove('low');
      return;
    }

    const low = data.remainingPercent <= 15 || data.severity !== 'normal';
    bubble.classList.toggle('low', low);
    const NBSP = '\u00A0';
    const strong = document.createElement('strong');
    strong.textContent = `${data.remainingPercent}${NBSP}%`;
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = config.name;
    nameEl.title = 'Clique pour changer comment il t\u2019appelle';
    nameEl.addEventListener('click', enterNameEdit);
    bubbleText.replaceChildren(
      nameEl,
      ', il vous reste ',
      strong,
      ` sur cette session de 5${NBSP}h.`
    );
    meterFill.style.width = `${data.remainingPercent}%`;

    // Deux lignes structurées (session / semaine) plutôt qu'un wrap subi
    const sessionParts = [];
    if (data.plan) sessionParts.push(`plan${NBSP}${data.plan}`);
    sessionParts.push(`utilisé${NBSP}${data.usedPercent}${NBSP}%`);
    if (data.resetsAt) {
      const t = new Date(data.resetsAt).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      sessionParts.push(`reset${NBSP}${t}`);
    }
    const weekParts = [];
    if (data.weeklyPercent != null) {
      weekParts.push(`semaine${NBSP}${data.weeklyPercent}${NBSP}%`);
    }
    if (data.stale) {
      const min = Math.max(1, Math.round((Date.now() - data.fetchedAt) / 60000));
      weekParts.push(`maj il y a ${min}${NBSP}min`);
    }
    const mkLine = (parts) => {
      const line = document.createElement('span');
      line.className = 'sub-line';
      const text = parts.join(' · ');
      line.textContent = text.charAt(0).toUpperCase() + text.slice(1);
      return line;
    };
    bubbleSub.replaceChildren(
      mkLine(sessionParts),
      ...(weekParts.length ? [mkLine(weekParts)] : [])
    );
  }

  window.maskot.onUsage(renderUsage);

  // Seuil franchi (25 % / 10 % restants) : la mascotte alerte d'elle-même
  window.maskot.onAlert((data) => {
    renderUsage(data);
    window.performances.interrupt();
    window.mascotAnim.jump();
    showBubble();
  });

  // Session reset : petite danse de fête + bulle à jour
  window.maskot.onSessionReset((data) => {
    renderUsage(data);
    window.performances.interrupt();
    window.performances.play('danse');
    showBubble();
  });

  // Animation choisie dans le menu clic droit
  window.maskot.onPlayPerf((name) => {
    window.performances.interrupt();
    window.performances.play(name);
  });

  /* ---------- Bulle ---------- */

  function showBubble() {
    bubbleOpen = true;
    bubble.hidden = false;
    renderUsage(lastUsage);
    askAnswer.hidden = true;
    gsap.fromTo(
      bubble,
      { scale: 0.5, opacity: 0, y: 10 },
      { scale: 1, opacity: 1, y: 0, duration: 0.35, ease: 'back.out(1.8)' }
    );
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideBubble, 8000);
    // Rafraîchit pendant que la bulle est ouverte pour un chiffre à jour
    window.maskot.refresh().then(renderUsage);
  }

  function hideBubble() {
    if (!bubbleOpen) return;
    bubbleOpen = false;
    clearTimeout(hideTimer);
    gsap.to(bubble, {
      scale: 0.6,
      opacity: 0,
      y: 8,
      duration: 0.2,
      ease: 'power2.in',
      onComplete: () => {
        bubble.hidden = true;
      },
    });
  }

  function toggleBubble() {
    if (bubbleOpen) hideBubble();
    else showBubble();
  }

  /* ---------- Questions à Claude ---------- */

  let asking = false;
  let streamed = '';

  // La réponse arrive en direct : chaque delta s'ajoute dans la bulle,
  // les pointillés « thinking » restent en curseur de frappe jusqu'à la fin
  window.maskot.onAskDelta((text) => {
    if (!asking) return;
    streamed += text;
    askAnswer.textContent = streamed;
    askAnswer.scrollTop = askAnswer.scrollHeight;
  });

  // La conversation a expiré côté CLI : le main relance de zéro
  window.maskot.onAskReset(() => {
    if (!asking) return;
    streamed = '';
    askAnswer.textContent = '';
  });

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q || asking) return;
    asking = true;
    streamed = '';
    // La bulle reste ouverte tant qu'on discute
    clearTimeout(hideTimer);
    askInput.disabled = true;
    askAnswer.hidden = false;
    askAnswer.textContent = '';
    askAnswer.classList.add('thinking');
    // Pendant la réflexion : yeux en l'air, balancement pensif
    window.performances.interrupt();
    window.mascotAnim.thinkStart();
    const res = await window.maskot.ask(q);
    window.mascotAnim.thinkStop();
    askAnswer.classList.remove('thinking');
    // Le texte final du CLI fait foi (les deltas peuvent être incomplets)
    askAnswer.textContent = res && res.ok
      ? res.answer
      : `Impossible de répondre (${(res && res.error) || 'erreur'}).`;
    askInput.disabled = false;
    askInput.value = '';
    asking = false;
  }

  askInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      if (nameMode) {
        window.maskot.setName(askInput.value).then((c) => {
          applyConfig(c);
          exitNameEdit();
          window.mascotAnim.wave();
        });
      } else {
        ask(askInput.value);
      }
    }
    if (e.key === 'Escape') {
      if (nameMode) exitNameEdit();
      else hideBubble();
    }
  });

  // Toute interaction avec la zone question désarme la fermeture auto
  document.getElementById('ask').addEventListener('mousedown', () => {
    clearTimeout(hideTimer);
  });
  askInput.addEventListener('focus', () => clearTimeout(hideTimer));

  /* ---------- Souris traversante hors du mascot ---------- */

  let dragging = false;

  hot.addEventListener('mouseenter', () => {
    window.maskot.setIgnore(false);
    window.mascotAnim.setHover(true);
  });
  hot.addEventListener('mouseleave', () => {
    if (!dragging) window.maskot.setIgnore(true);
    window.mascotAnim.setHover(false);
  });

  // Les yeux suivent le curseur au survol
  hot.addEventListener('mousemove', (e) => {
    if (dragging || window.performances.isActive()) return;
    const r = mascot.getBoundingClientRect();
    window.mascotAnim.eyeTrack(
      e.clientX - (r.left + r.width / 2),
      e.clientY - (r.top + r.height / 2)
    );
  });

  /* ---------- Drag de la fenêtre + détection du clic ---------- */

  const CLICK_TOLERANCE = 5;
  const DOUBLE_CLICK_MS = 300;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let moved = false;
  let clickTimer = null;

  mascot.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (window.performances) window.performances.interrupt();
    dragging = true;
    moved = false;
    startX = e.screenX;
    startY = e.screenY;
    lastX = e.screenX;
    mascot.classList.add('dragging');
    window.maskot.dragStart();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - startX;
    const dy = e.screenY - startY;
    if (!moved && Math.hypot(dx, dy) > CLICK_TOLERANCE) {
      moved = true;
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      hideBubble();
      window.mascotAnim.dragStart();
    }
    if (moved) {
      window.mascotAnim.tilt(e.screenX - lastX);
      lastX = e.screenX;
    }
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    mascot.classList.remove('dragging');
    window.maskot.dragEnd();
    if (moved) {
      window.mascotAnim.dragEnd();
    } else if (clickTimer) {
      // Double-clic : une performance différente à chaque fois
      clearTimeout(clickTimer);
      clickTimer = null;
      hideBubble();
      window.performances.playNext();
    } else {
      window.mascotAnim.jump();
      clickTimer = setTimeout(() => {
        clickTimer = null;
        toggleBubble();
      }, DOUBLE_CLICK_MS);
    }
    if (e && e.target && !hot.contains(e.target)) {
      window.maskot.setIgnore(true);
    }
  }

  window.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', () => endDrag(null));

  /* ---------- Menu contextuel (Actualiser / Quitter) ---------- */

  hot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.maskot.contextMenu();
  });

  // Hook pour le mode capture (MASKOT_SHOT) : ouvre la bulle sans passer par
  // des événements souris simulés, qui entrent en collision avec la vraie souris.
  window.__maskotShowBubble = () => {
    window.mascotAnim.jump();
    showBubble();
  };
  window.__maskotAsk = (q) => {
    showBubble();
    ask(q);
  };

  // État partagé avec performances.js (planification des animations idle)
  window.maskotState = {
    get dragging() {
      return dragging;
    },
    get bubbleOpen() {
      return bubbleOpen;
    },
  };
})();
