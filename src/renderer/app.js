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
  const askFiles = document.getElementById('ask-files');
  const musicControls = document.getElementById('music-controls');
  const musicToggleBtn = document.getElementById('music-toggle-btn');
  const musicNextBtn = document.getElementById('music-next-btn');

  let lastUsage = null;
  let bubbleOpen = false;
  let hideTimer = null;

  // Ancrage inversé (mascotte en haut de l'écran) : la bulle s'ouvre vers le bas
  let flipped = false;
  window.maskot.onFlip((f) => {
    flipped = f;
    document.body.classList.toggle('flip', f);
  });

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

  // Raccourci clavier global (⌥⌘M) : bulle ouverte, champ prêt à taper
  window.maskot.onFocusAsk(() => {
    if (!bubbleOpen) showBubble();
    clearTimeout(hideTimer);
    askInput.focus();
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

  /* ---------- Musique : casque + contrôles ---------- */

  let music = { active: false, playing: false, title: null, artist: null };
  let hotHover = false;
  let controlsShown = false;

  // Boutons visibles seulement : piste active + souris sur la mascotte,
  // hors drag et hors bulle (la bulle occupe déjà l'espace au-dessus).
  function renderMusicControls() {
    musicControls.classList.toggle('playing', music.playing);
    musicToggleBtn.title = music.title
      ? `${music.title}${music.artist ? ` — ${music.artist}` : ''}`
      : '';
    musicNextBtn.title = 'Piste suivante';
    const show = music.active && hotHover && !dragging && !bubbleOpen;
    if (show === controlsShown) return;
    controlsShown = show;
    gsap.killTweensOf(musicControls);
    if (show) {
      musicControls.hidden = false;
      gsap.fromTo(
        musicControls,
        { opacity: 0, scale: 0.7, y: flipped ? -6 : 6 },
        { opacity: 1, scale: 1, y: 0, duration: 0.25, ease: 'back.out(1.8)' }
      );
    } else {
      gsap.to(musicControls, {
        opacity: 0,
        scale: 0.7,
        duration: 0.15,
        ease: 'power2.in',
        onComplete: () => {
          if (!controlsShown) musicControls.hidden = true;
        },
      });
    }
  }

  musicToggleBtn.addEventListener('click', () => {
    // Update optimiste : l'icône bascule tout de suite, le stream confirmera
    music = { ...music, playing: !music.playing };
    renderMusicControls();
    window.maskot.musicToggle();
  });

  musicNextBtn.addEventListener('click', () => window.maskot.musicNext());

  window.maskot.onMusic((m) => {
    music = m || { active: false, playing: false, title: null, artist: null };
    // Casque porté seulement pendant la lecture ; en pause il l'enlève,
    // mais les boutons au survol restent tant qu'une piste est là
    if (music.playing) window.mascotAnim.headphonesOn();
    else window.mascotAnim.headphonesOff();
    renderMusicControls();
  });

  /* ---------- Bulle ---------- */

  function showBubble() {
    bubbleOpen = true;
    bubble.hidden = false;
    renderUsage(lastUsage);
    askAnswer.hidden = true;
    gsap.fromTo(
      bubble,
      { scale: 0.5, opacity: 0, y: flipped ? -10 : 10 },
      { scale: 1, opacity: 1, y: 0, duration: 0.35, ease: 'back.out(1.8)' }
    );
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideBubble, 8000);
    // Rafraîchit pendant que la bulle est ouverte pour un chiffre à jour
    window.maskot.refresh().then(renderUsage);
    renderMusicControls();
  }

  function hideBubble() {
    if (!bubbleOpen) return;
    bubbleOpen = false;
    clearTimeout(hideTimer);
    gsap.to(bubble, {
      scale: 0.6,
      opacity: 0,
      y: flipped ? -8 : 8,
      duration: 0.2,
      ease: 'power2.in',
      onComplete: () => {
        bubble.hidden = true;
      },
    });
    renderMusicControls();
  }

  function toggleBubble() {
    if (bubbleOpen) hideBubble();
    else showBubble();
  }

  /* ---------- Questions à Claude ---------- */

  let asking = false;
  let streamed = '';
  let attachedFiles = [];

  /* ---------- Fichiers déposés dans la bulle ---------- */

  function renderFiles() {
    askFiles.replaceChildren(
      ...attachedFiles.map((p) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = `${p.split('/').pop()} ×`;
        chip.title = `${p} — clique pour retirer`;
        chip.addEventListener('click', () => {
          attachedFiles = attachedFiles.filter((f) => f !== p);
          renderFiles();
        });
        return chip;
      })
    );
    askFiles.hidden = !attachedFiles.length;
  }

  // Empêche Electron de « naviguer » vers un fichier lâché à côté de la cible
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  ['dragenter', 'dragover'].forEach((type) => {
    bubble.addEventListener(type, (e) => {
      e.preventDefault();
      bubble.classList.add('dropping');
      clearTimeout(hideTimer);
    });
  });
  bubble.addEventListener('dragleave', (e) => {
    if (!bubble.contains(e.relatedTarget)) bubble.classList.remove('dropping');
  });
  bubble.addEventListener('drop', (e) => {
    e.preventDefault();
    bubble.classList.remove('dropping');
    const paths = [...((e.dataTransfer && e.dataTransfer.files) || [])]
      .map((f) => window.maskot.pathForFile(f))
      .filter(Boolean);
    if (!paths.length) return;
    attachedFiles = [...new Set([...attachedFiles, ...paths])].slice(0, 3);
    renderFiles();
    clearTimeout(hideTimer);
    askInput.focus();
  });

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
    const res = await window.maskot.ask(q, attachedFiles);
    window.mascotAnim.thinkStop();
    askAnswer.classList.remove('thinking');
    // Le texte final du CLI fait foi (les deltas peuvent être incomplets)
    askAnswer.textContent = res && res.ok
      ? res.answer
      : `Impossible de répondre (${(res && res.error) || 'erreur'}).`;
    if (res && res.ok) {
      // La conversation garde le fichier en tête via --resume : chips inutiles
      attachedFiles = [];
      renderFiles();
    }
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
    hotHover = true;
    renderMusicControls();
  });
  hot.addEventListener('mouseleave', () => {
    if (!dragging) window.maskot.setIgnore(true);
    window.mascotAnim.setHover(false);
    hotHover = false;
    renderMusicControls();
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
      renderMusicControls();
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
    renderMusicControls();
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
  window.__maskotMusicControls = () => {
    hotHover = true;
    renderMusicControls();
    // État renvoyé au mode capture (diagnostic dev)
    return { music, hotHover, controlsShown, hidden: musicControls.hidden };
  };
  window.__maskotAsk = (q, file) => {
    showBubble();
    if (file) {
      attachedFiles = [String(file)];
      renderFiles();
    }
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
