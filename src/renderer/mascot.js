/*
 * Animations du mascot — reprises de la démarche de l'article Codrops
 * « Reverse-Engineering Claude AI's Mascot Animations with SVG and GSAP »
 * (Ayotomiwa Wale-Durojaye, mai 2026) : rects animés en rotation/scale
 * avec svgOrigin, easing power/sine, et séquences crouch → jump → land.
 */
(() => {
  const root = '#claude-root';
  const body = '#body';
  const eyes = ['#left-eye', '#right-eye'];
  const legs = ['#leg1', '#leg2', '#leg3', '#leg4'];

  const GROUND = '53 86'; // centre au sol du viewBox 107×86
  const CARRY = '53 32'; // centre du corps, pour le balancement porté

  gsap.set(root, { svgOrigin: GROUND });
  gsap.set(legs, { transformOrigin: '50% 100%' });
  gsap.set(eyes, { transformOrigin: '50% 50%' });

  let jumping = false;
  let dragging = false;

  /* ---------- Idle : respiration + pattes ---------- */

  gsap.to(body, {
    y: -2,
    scaleY: 0.985,
    svgOrigin: '53 65',
    duration: 1.4,
    yoyo: true,
    repeat: -1,
    ease: 'sine.inOut',
  });

  // Gardés à part pour pouvoir les suspendre pendant saut et portage
  // (sinon ils écrasent le scaleY des tweens ponctuels).
  const legIdle = legs.map((leg, i) =>
    gsap.to(leg, {
      scaleY: 1.06,
      duration: 1.4,
      yoyo: true,
      repeat: -1,
      delay: i * 0.12,
      ease: 'sine.inOut',
    })
  );

  const pauseLegIdle = () => legIdle.forEach((t) => t.pause());
  const resumeLegIdle = () => legIdle.forEach((t) => t.resume());

  /* ---------- Clignement, à intervalle aléatoire ---------- */

  function blink() {
    // Pas de clignement pendant une performance : il remettrait les yeux
    // à 1 en plein milieu d'une pose (dodo, boxe…).
    if (window.performances && window.performances.isActive()) {
      scheduleBlink();
      return;
    }
    // Retour explicite à 1 (pas de yoyo) : un clignement lancé pendant une
    // pose (yeux plissés de la boxe) ne doit pas y rester bloqué.
    gsap
      .timeline({ onComplete: scheduleBlink })
      .to(eyes, { scaleY: 0.12, duration: 0.07, ease: 'power2.inOut' })
      .to(eyes, { scaleY: 1, duration: 0.07, ease: 'power2.inOut' });
  }

  function scheduleBlink() {
    gsap.delayedCall(gsap.utils.random(2.2, 5.5), blink);
  }

  scheduleBlink();

  /* ---------- Coups d'œil de côté ---------- */

  function glance() {
    if (!dragging && !hovering) {
      const dir = gsap.utils.random([-3, 3]);
      gsap
        .timeline()
        .to(eyes, { x: dir, duration: 0.28, ease: 'power2.out' })
        .to(eyes, { x: 0, duration: 0.32, ease: 'power2.inOut' }, '+=0.9');
    }
    gsap.delayedCall(gsap.utils.random(4, 9), glance);
  }

  gsap.delayedCall(3, glance);

  /* ---------- Saut (au clic) : crouch → jump → land ---------- */

  function jump() {
    if (jumping || dragging) return;
    jumping = true;
    pauseLegIdle();
    gsap.set(root, { svgOrigin: GROUND });
    gsap
      .timeline({
        onComplete: () => {
          jumping = false;
          resumeLegIdle();
        },
      })
      .to(root, { scaleY: 0.92, scaleX: 1.04, duration: 0.12, ease: 'power2.out' })
      .to(root, { scaleY: 1, scaleX: 1, duration: 0.1, ease: 'power2.in' })
      .to(root, { y: -24, duration: 0.3, ease: 'sine.out' }, '<')
      .to(legs, { scaleY: 1.4, duration: 0.22, ease: 'power2.out' }, '<')
      .to(root, { y: 0, duration: 0.2, ease: 'power3.in' }, '-=0.06')
      .to(legs, { scaleY: 1, duration: 0.16, ease: 'power3.in' }, '<')
      .to(root, { scaleY: 0.94, scaleX: 1.03, duration: 0.09, ease: 'power2.out' })
      .to(root, { scaleY: 1, scaleX: 1, duration: 0.35, ease: 'elastic.out(1, 0.45)' });
  }

  /* ---------- Porté / déposé (drag) ---------- */

  const tiltTo = gsap.quickTo(root, 'rotation', {
    duration: 0.25,
    ease: 'power2.out',
  });

  function dragStart() {
    if (dragging) return;
    dragging = true;
    pauseLegIdle();
    gsap.set(root, { svgOrigin: CARRY });
    // Pattes qui pendent : étirées depuis le haut, plus attachées au sol
    gsap.set(legs, { transformOrigin: '50% 0%' });
    gsap.to(legs, {
      scaleY: 1.55,
      duration: 0.3,
      stagger: 0.035,
      ease: 'power2.out',
    });
    gsap.to(eyes, { scale: 1.25, duration: 0.2, ease: 'power2.out' });
  }

  function tilt(vx) {
    if (!dragging) return;
    tiltTo(gsap.utils.clamp(-11, 11, vx * 1.1));
  }

  function dragEnd() {
    if (!dragging) return;
    dragging = false;
    gsap.to(eyes, { scale: 1, duration: 0.25, ease: 'power2.inOut' });
    gsap.to(legs, {
      scaleY: 1,
      duration: 0.45,
      ease: 'elastic.out(1, 0.5)',
      onComplete: () => {
        gsap.set(legs, { transformOrigin: '50% 100%' });
        resumeLegIdle();
      },
    });
    gsap
      .timeline()
      .to(root, { rotation: 0, duration: 0.18, ease: 'power2.out' })
      .set(root, { svgOrigin: GROUND })
      .to(root, { scaleY: 0.93, scaleX: 1.04, duration: 0.1, ease: 'power2.out' })
      .to(root, { scaleY: 1, scaleX: 1, duration: 0.4, ease: 'elastic.out(1, 0.45)' });
  }

  /* ---------- Boxe : garde, esquives, jabs, uppercut ---------- */

  const hands = ['#left-hand', '#right-hand'];
  gsap.set(hands, { transformOrigin: '50% 50%' });

  function box() {
    gsap.set(root, { svgOrigin: GROUND });
    const [L, R] = hands;
    const tl = gsap.timeline();

    // Garde : poings serrés sur les côtés du visage (ils restent hors du
    // contour du corps — même couleur, sinon ils disparaissent), yeux plissés
    tl.to(eyes, { scaleY: 0.5, duration: 0.14, ease: 'power2.out' }, 0)
      .to(root, { scaleY: 0.95, duration: 0.16, ease: 'power2.out' }, 0)
      .to(L, { x: 2, y: -9, duration: 0.2, ease: 'back.out(2.5)' }, 0.04)
      .to(R, { x: -2, y: -9, duration: 0.2, ease: 'back.out(2.5)' }, 0.04);

    // Esquive gauche-droite
    tl.to(root, { x: -5, rotation: -2, duration: 0.14, ease: 'sine.inOut' }, '+=0.1')
      .to(root, { x: 5, rotation: 2, duration: 0.18, ease: 'sine.inOut' })
      .to(root, { x: 0, rotation: 0, duration: 0.14, ease: 'sine.inOut' });

    // Jabs alternés (frontal : le poing « sort » vers l'écran)
    const jab = (hand, dir) => {
      tl.to(hand, { scale: 1.6, y: -38, duration: 0.09, ease: 'power3.out' })
        .to(root, { rotation: dir * 4, x: dir * 3, duration: 0.09, ease: 'power2.out' }, '<')
        .to(hand, { scale: 1, y: -9, duration: 0.12, ease: 'power2.in' })
        .to(root, { rotation: 0, x: 0, duration: 0.12, ease: 'power2.in' }, '<');
    };
    jab(L, 1);
    jab(R, -1);
    jab(L, 1);
    jab(R, -1);

    // Uppercut final + petit saut, puis retour au neutre
    tl.to(root, { scaleY: 0.9, scaleX: 1.05, duration: 0.12, ease: 'power2.out' }, '+=0.15')
      .to([L, R], { y: -46, scale: 1.55, duration: 0.14, ease: 'power3.out' })
      .to(root, { scaleY: 1, scaleX: 1, y: -16, duration: 0.18, ease: 'sine.out' }, '<')
      .to(root, { y: 0, duration: 0.16, ease: 'power3.in' })
      .to([L, R], { x: 0, y: 0, scale: 1, duration: 0.35, ease: 'elastic.out(1, 0.5)' }, '-=0.05')
      .to(eyes, { scaleY: 1, duration: 0.2, ease: 'power2.inOut' }, '<')
      .to(root, { scaleY: 0.95, scaleX: 1.03, duration: 0.08, ease: 'power2.out' })
      .to(root, { scaleY: 1, scaleX: 1, duration: 0.3, ease: 'elastic.out(1, 0.45)' });

    return tl;
  }

  /* ---------- Danse : petits bonds, mains alternées ---------- */

  function dance() {
    gsap.set(root, { svgOrigin: GROUND });
    const [L, R] = hands;
    const tl = gsap.timeline();
    const step = (dir) => {
      tl.to(root, { x: dir * 6, rotation: dir * 4, y: -7, duration: 0.16, ease: 'power1.out' })
        .to(root, { y: 0, duration: 0.14, ease: 'power1.in' }, '<0.04')
        .to(L, { y: dir > 0 ? -30 : -2, duration: 0.2, ease: 'sine.inOut' }, '<')
        .to(R, { y: dir > 0 ? -2 : -30, duration: 0.2, ease: 'sine.inOut' }, '<');
    };
    for (let i = 0; i < 6; i++) step(i % 2 === 0 ? 1 : -1);
    tl.to(root, { x: 0, rotation: 0, y: 0, duration: 0.2, ease: 'power2.inOut' })
      .to(hands, { x: 0, y: 0, scale: 1, duration: 0.35, ease: 'elastic.out(1, 0.5)' }, '<');
    return tl;
  }

  /* ---------- Coucou : la main droite salue ---------- */

  function wave() {
    gsap.set(root, { svgOrigin: GROUND });
    const R = '#right-hand';
    const tl = gsap.timeline();
    tl.to(R, { x: 8, y: -40, scale: 1.25, duration: 0.25, ease: 'back.out(2)' })
      .to(root, { rotation: -2, duration: 0.25, ease: 'sine.inOut' }, '<')
      .to(eyes, { scaleY: 0.6, duration: 0.2, ease: 'power2.out' }, '<');
    for (let i = 0; i < 3; i++) {
      tl.to(R, { rotation: 20, duration: 0.13, ease: 'sine.inOut' })
        .to(R, { rotation: -14, duration: 0.13, ease: 'sine.inOut' });
    }
    tl.to(R, { rotation: 0, x: 0, y: 0, scale: 1, duration: 0.35, ease: 'power2.inOut' })
      .to(root, { rotation: 0, duration: 0.25, ease: 'sine.inOut' }, '<')
      .to(eyes, { scaleY: 1, duration: 0.2, ease: 'power2.inOut' }, '<');
    return tl;
  }

  /* ---------- Dodo : paupières lourdes et bulles de sommeil ---------- */

  function sleep() {
    gsap.set(root, { svgOrigin: GROUND });
    const zzz = ['#zzz1', '#zzz2', '#zzz3'];
    const tl = gsap.timeline();
    tl.to(eyes, { scaleY: 0.22, duration: 0.7, ease: 'power2.inOut' }, 0)
      .to(root, { scaleY: 0.96, rotation: 1.5, duration: 0.9, ease: 'sine.inOut' }, 0);
    for (let cycle = 0; cycle < 2; cycle++) {
      const at = 0.8 + cycle * 1.5;
      zzz.forEach((z, i) => {
        tl.fromTo(
          z,
          { opacity: 0, y: 6 },
          { opacity: 1, y: -8, duration: 0.9, ease: 'sine.out' },
          at + i * 0.28
        ).to(z, { opacity: 0, duration: 0.35, ease: 'sine.in' }, at + 0.9 + i * 0.28);
      });
    }
    // Réveil en sursaut
    tl.to(zzz, { opacity: 0, duration: 0.1 }, '+=0.2')
      .to(eyes, { scaleY: 1.25, duration: 0.09, ease: 'power3.out' })
      .to(root, { scaleY: 1, rotation: 0, y: -8, duration: 0.14, ease: 'power2.out' }, '<')
      .to(root, { y: 0, duration: 0.14, ease: 'power2.in' })
      .to(eyes, { scaleY: 1, duration: 0.2, ease: 'power2.inOut' });
    return tl;
  }

  /* ---------- Réflexion : yeux en l'air, balancement lent ---------- */

  let thinkTl = null;

  function thinkStart() {
    if (thinkTl) return;
    gsap.set(root, { svgOrigin: GROUND });
    thinkTl = gsap.timeline({ repeat: -1, yoyo: true });
    thinkTl
      .to(eyes, { y: -3, x: 2, scaleY: 0.8, duration: 0.5, ease: 'power2.out' }, 0)
      .to(root, { rotation: 1.5, duration: 1.1, ease: 'sine.inOut' }, 0)
      .to(root, { rotation: -1.5, duration: 1.1, ease: 'sine.inOut' });
  }

  function thinkStop() {
    if (!thinkTl) return;
    thinkTl.kill();
    thinkTl = null;
    gsap.to(eyes, { y: 0, x: 0, scaleY: 1, duration: 0.25, ease: 'power2.inOut' });
    gsap.to(root, { rotation: 0, duration: 0.3, ease: 'power2.inOut' });
  }

  /* ---------- Casque : posé quand de la musique joue ---------- */

  const headphones = '#headphones';
  let wearingHeadphones = false;

  function headphonesOn() {
    if (wearingHeadphones) return;
    wearingHeadphones = true;
    gsap.killTweensOf(headphones);
    // Le casque « se pose » sur la tête depuis le haut
    gsap.fromTo(
      headphones,
      { opacity: 0, y: -14 },
      { opacity: 1, y: 0, duration: 0.45, ease: 'bounce.out' }
    );
  }

  function headphonesOff() {
    if (!wearingHeadphones) return;
    wearingHeadphones = false;
    gsap.killTweensOf(headphones);
    gsap.to(headphones, { opacity: 0, y: -10, duration: 0.3, ease: 'power2.in' });
  }

  /* ---------- Yeux qui suivent le curseur ---------- */

  const eyeFollowX = gsap.quickTo(eyes, 'x', { duration: 0.3, ease: 'power2.out' });
  const eyeFollowY = gsap.quickTo(eyes, 'y', { duration: 0.3, ease: 'power2.out' });
  let hovering = false;

  function eyeTrack(dx, dy) {
    if (dragging) return;
    eyeFollowX(gsap.utils.clamp(-3.5, 3.5, dx / 16));
    eyeFollowY(gsap.utils.clamp(-2.5, 2.5, dy / 16));
  }

  function setHover(v) {
    hovering = v;
    if (!v) {
      eyeFollowX(0);
      eyeFollowY(0);
    }
  }

  // Remise au neutre après interruption d'une animation procédurale
  function resetPose() {
    gsap.set(hands, { x: 0, y: 0, scale: 1, rotation: 0 });
    gsap.set(eyes, { scaleY: 1, scale: 1, x: 0, y: 0 });
    gsap.set(['#zzz1', '#zzz2', '#zzz3'], { opacity: 0, y: 0 });
    gsap.set(root, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
  }

  window.mascotAnim = {
    jump,
    dragStart,
    dragEnd,
    tilt,
    box,
    dance,
    wave,
    sleep,
    thinkStart,
    thinkStop,
    eyeTrack,
    setHover,
    resetPose,
    headphonesOn,
    headphonesOff,
    isBusy: () => jumping || dragging,
  };
})();
