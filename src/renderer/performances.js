/*
 * « Performances » : les autres animations du mascot Claude reconstituées
 * par l'article Codrops (gym, drapeau, marche, confettis), jouées en
 * flip-book quand la mascotte s'ennuie. Séquences et tempos extraits du
 * bundle de la démo ayotomcs.me/claude-mascot :
 *  - gym : seq 0→24, 13→24, 25→35 ; 0.085 s/frame (0.27 s sur 6-7,
 *    0.4 s sur 15 et 21, tenue finale 1.5 s)
 *  - drapeau : intro 0→11 puis boucle 3→11, 0.07 s/frame
 *  - marche : 8 frames à 0.125 s
 */
(() => {
  const SPRITES = window.MASKOT_SPRITES;
  const mascotEl = document.getElementById('mascot');
  const walker = document.getElementById('mascot-svg');
  const WALKER_VB_W = 107;
  const WALKER_PX_W = 104;

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  const GYM_SEQ = [...range(0, 24), ...range(13, 24), ...range(25, 35)];
  const gymDelay = (stepIdx, frame, len) => {
    if (stepIdx === len - 1) return 1.5;
    if (frame === 6 || frame === 7) return 0.27;
    if (frame === 15 || frame === 21) return 0.4;
    return 0.085;
  };

  const PERFS = {
    gym: {
      frames: (svg) => [...svg.querySelectorAll(':scope > g')],
      build(tl, frames) {
        let t = 0;
        GYM_SEQ.forEach((f, i) => {
          showOnly(tl, frames, f, t);
          t += gymDelay(i, f, GYM_SEQ.length);
        });
      },
    },
    flag: {
      frames: findLargestFrameSet,
      build(tl, frames) {
        let t = 0;
        range(0, 11).forEach((f) => {
          showOnly(tl, frames, f, t);
          t += 0.07;
        });
        for (let loop = 0; loop < 4; loop++) {
          range(3, 11).forEach((f) => {
            showOnly(tl, frames, f, t);
            t += 0.07;
          });
        }
        tl.set({}, {}, t + 0.6);
      },
    },
    march: {
      frames: (svg) => [...svg.querySelectorAll(':scope > g[id^="l0"]')],
      build(tl, frames) {
        let t = 0;
        for (let loop = 0; loop < 4; loop++) {
          range(0, 7).forEach((f) => {
            showOnly(tl, frames, f, t);
            t += 0.125;
          });
        }
        tl.set({}, {}, t + 0.2);
      },
    },
    // Chorégraphies GSAP procédurales sur le personnage lui-même
    boxe: {
      procedural: () => window.mascotAnim.box(),
      reset: () => window.mascotAnim.resetPose(),
    },
    danse: {
      procedural: () => window.mascotAnim.dance(),
      reset: () => window.mascotAnim.resetPose(),
    },
    coucou: {
      procedural: () => window.mascotAnim.wave(),
      reset: () => window.mascotAnim.resetPose(),
    },
    dodo: {
      procedural: () => window.mascotAnim.sleep(),
      reset: () => window.mascotAnim.resetPose(),
    },
    // Le logo étoile Claude qui tourne (le spinner de Claude Code)
    star: {
      width: 120,
      frames: (svg) => [...svg.querySelectorAll(':scope > g')],
      build(tl, frames) {
        let t = 0;
        for (let loop = 0; loop < 3; loop++) {
          frames.forEach((_, f) => {
            showOnly(tl, frames, f, t);
            t += 0.11;
          });
        }
        tl.set({}, {}, t + 0.5);
      },
    },
  };

  function showOnly(tl, frames, idx, at) {
    frames.forEach((el, j) => {
      tl.set(el, { display: j === idx ? 'inline' : 'none' }, at);
    });
  }

  // Pour le drapeau, les frames sont imbriquées : on prend le groupe qui a le
  // plus d'enfants <g> (le conteneur de frames).
  function findLargestFrameSet(svg) {
    let best = [];
    svg.querySelectorAll('g').forEach((el) => {
      const kids = [...el.children].filter((c) => c.tagName === 'g');
      if (kids.length > best.length) best = kids;
    });
    const top = [...svg.children].filter((c) => c.tagName === 'g');
    return top.length > best.length ? top : best;
  }

  let active = null; // { tl, el }

  function cleanup() {
    if (!active) return;
    active.tl.kill();
    if (active.el) active.el.remove();
    if (active.reset) active.reset();
    walker.style.visibility = '';
    active = null;
  }

  function play(name) {
    if (active) cleanup();
    const perf = PERFS[name];
    if (!perf) return;

    // Animation procédurale : jouée sur le personnage, pas de sprite
    if (perf.procedural) {
      const tl = perf.procedural();
      active = { tl, el: null, reset: perf.reset };
      tl.eventCallback('onComplete', cleanup);
      return;
    }

    const sprite = SPRITES[name];
    if (!sprite) return;

    const holder = document.createElement('div');
    holder.id = 'perf';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', sprite.viewBox);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const vbW = Number(sprite.viewBox.split(' ')[2]);
    svg.style.width = `${perf.width || Math.round((WALKER_PX_W * vbW) / WALKER_VB_W)}px`;
    const parsed = new DOMParser()
      .parseFromString(`<svg>${sprite.content}</svg>`, 'text/html')
      .querySelector('svg');
    [...parsed.childNodes].forEach((n) => svg.appendChild(n));
    holder.appendChild(svg);
    mascotEl.appendChild(holder);

    const frames = perf.frames(svg);
    if (frames.length < 2) {
      holder.remove();
      return;
    }

    walker.style.visibility = 'hidden';
    const tl = gsap.timeline({ onComplete: cleanup });
    perf.build(tl, frames);
    active = { tl, el: holder };
  }

  /* ---------- Planification pendant l'idle ---------- */

  const names = Object.keys(PERFS);
  let lastName = null;
  let cycleIdx = -1;

  // Double-clic : joue les performances en cycle, une différente à chaque fois
  function playNext() {
    cycleIdx = (cycleIdx + 1) % names.length;
    lastName = names[cycleIdx];
    play(names[cycleIdx]);
  }

  function canPlay() {
    const s = window.maskotState || {};
    return !active && !s.dragging && !s.bubbleOpen && !window.mascotAnim.isBusy();
  }

  function schedule() {
    gsap.delayedCall(gsap.utils.random(30, 75), () => {
      if (canPlay()) {
        let name = gsap.utils.random(names);
        if (name === lastName) name = gsap.utils.random(names);
        lastName = name;
        play(name);
      }
      schedule();
    });
  }

  schedule();

  window.performances = {
    play,
    playNext,
    interrupt: cleanup,
    isActive: () => Boolean(active),
  };
})();
