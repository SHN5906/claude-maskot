<div align="center">

# Claude Maskot

**La mascotte Claude vit sur ton bureau — et elle sait toujours où en est ta session Claude Code.**

macOS · Electron · GSAP · aucune clé API

<br />

<img src="docs/bulle.gif" width="340" alt="La mascotte saute et ouvre une bulle : Batman, il vous reste 26 % sur cette session de 5 h." />

<br />

*« Batman, il vous reste 26 % sur cette session de 5 h. »*

</div>

---

## Elle fait quoi ?

Elle affiche en direct l'état de ta session Claude Code (la fenêtre de 5 h) — le même chiffre que la commande `/usage` — et elle vit sa vie sur ton écran en attendant que tu la sollicites.

| Geste | Ce qui se passe |
|---|---|
| **Clic** | Elle saute et ouvre la bulle : % restant, jauge, plan, heure de reset, % hebdo |
| **Écrire dans la bulle** | Tu lui poses une question, Claude répond — via ton CLI, ton abonnement |
| **Double-clic** | Une animation différente à chaque fois, en cycle |
| **Glisser** | Tu la poses où tu veux — elle pendouille pendant le transport, la position est retenue |
| **Survol** | Ses yeux suivent ton curseur |
| **Clic droit** | Actualiser · jouer une animation · modifier les questions · quitter |

Et sans rien lui demander :

- toutes les 30–75 s d'inactivité, elle s'occupe (gym, boxe, dodo…)
- quand il reste **25 %** puis **10 %**, elle t'alerte d'elle-même — bulle + notification macOS
- quand la session se recharge, elle fête ça en faisant tourner l'étoile Claude
- sous 15 % restants, le chiffre et la jauge passent au rouge
- la fenêtre est **traversante en dehors d'elle** : elle ne bloque jamais tes clics

<div align="center">
<img src="docs/bulle-low.png" width="290" alt="État critique : il reste 8 %, chiffre et jauge en rouge" />
</div>

## Pose-lui tes questions

Un champ dans la bulle, des questions rapides cliquables, et Claude qui répond. Pendant la réflexion, la mascotte se transforme en étoile Claude qui tourne — le vrai spinner.

<div align="center">
<img src="docs/questions.png" width="300" alt="La bulle affiche une réponse de Claude sous les infos de session" />
</div>

Les réponses passent par `claude -p` : ton CLI Claude Code déjà connecté, donc **ton abonnement, zéro clé API, zéro config**. Les questions rapides vivent dans [`questions.json`](questions.json) — ajoute les tiennes (clic droit → **Modifier les questions…**).

## La troupe

| <img src="docs/gym.gif" width="240" /> | <img src="docs/flag.gif" width="240" /> | <img src="docs/march.gif" width="240" /> |
|:---:|:---:|:---:|
| **Gym** — 36 frames, bandeau inclus | **Drapeau** — lever à damier | **Marche** — 8 frames |
| <img src="docs/boxe.gif" width="240" /> | <img src="docs/danse.gif" width="240" /> | <img src="docs/dodo.gif" width="240" /> |
| **Boxe** — garde, jabs, uppercut | **Danse** — petits bonds | **Dodo** — bulles de sommeil |
| <img src="docs/coucou.gif" width="240" /> | <img src="docs/star.gif" width="240" /> | |
| **Coucou** — elle te salue | **Étoile Claude** — le spinner | |

Les flip-books (gym, drapeau, marche, étoile) sont les animations du mascot Claude reconstituées **rect par rect** par [Ayotomiwa Wale-Durojaye](https://tympanus.net/codrops/author/ayotomcs/) dans son article Codrops [*Reverse-Engineering Claude AI's Mascot Animations with SVG and GSAP*](https://tympanus.net/codrops/2026/05/05/reverse-engineering-claude-ais-mascot-animations-with-svg-and-gsap/) — frames et tempos exacts extraits de sa [démo](https://ayotomcs.me/claude-mascot), embarqués en local. Boxe, danse, coucou et dodo sont des chorégraphies GSAP procédurales écrites dans le même esprit.

## Installation

Prérequis : macOS · [Claude Code](https://claude.com/claude-code) connecté (Pro/Max) · Node ≥ 20 · pnpm.

```bash
git clone https://github.com/SHN5906/claude-maskot.git
cd claude-maskot
pnpm install
pnpm start
```

Elle apparaît en bas à droite. Pour la fermer : clic droit → **Quitter Claude Maskot** (elle n'a ni Dock ni fenêtre — c'est un widget).

## Comment elle sait ? — et vie privée

Le pourcentage vient du même endroit que `/usage` : l'endpoint OAuth officiel `https://api.anthropic.com/api/oauth/usage` (`five_hour.utilization`, `seven_day`, `limits`).

**Aucune clé ni token dans ce repo, ni dans une config.** Le token OAuth est lu à la volée dans le trousseau macOS — l'item « Claude Code-credentials » que Claude Code y range lui-même — gardé en mémoire le temps de la requête, jamais écrit ni loggé. Les seules sorties réseau : cet appel d'usage vers l'API d'Anthropic, et tes questions via le CLI `claude`. Rien d'autre.

Rafraîchissement toutes les 60 s + à l'ouverture de la bulle, avec throttle (l'API rate-limite vite) et conservation de la dernière valeur connue en cas de coupure.

## Bidouiller

Capturer la fenêtre sans permission Screen Recording — c'est comme ça que tous les visuels de ce README ont été faits :

```bash
# bulle ouverte (une image)
MASKOT_SHOT=/tmp/maskot.png pnpm start

# une animation en cours de lecture
MASKOT_SHOT=/tmp/boxe.png MASKOT_SHOT_PERF=boxe MASKOT_SHOT_AT=1200 pnpm start

# rafale de frames → GIF (ffmpeg)
MASKOT_SHOT=/tmp/frames/boxe MASKOT_SHOT_PERF=boxe MASKOT_SHOT_FRAMES=42 MASKOT_SHOT_EVERY=80 pnpm start

# une question posée automatiquement
MASKOT_SHOT=/tmp/ask.png MASKOT_SHOT_ASK="Pourquoi le ciel est bleu ?" MASKOT_SHOT_AT=18000 pnpm start

# données factices (tester sans l'API, ex. l'état critique)
MASKOT_SHOT_MOCK=92 pnpm start
```

| Fichier | Rôle |
|---|---|
| `src/main.js` | Fenêtre, trousseau, API d'usage, alertes, menu, CLI claude |
| `src/renderer/mascot.js` | Le personnage et ses animations GSAP |
| `src/renderer/performances.js` | Flip-books + chorégraphies, planification idle |
| `src/renderer/sprites.js` | Frames SVG embarquées (généré depuis la démo Codrops) |
| `src/renderer/app.js` | Bulle, questions, drag, clics |
| `questions.json` | Tes questions rapides |

## Lancement automatique (optionnel)

```bash
cat > ~/Library/LaunchAgents/com.claude-maskot.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-maskot</string>
  <key>ProgramArguments</key><array>
    <string>/chemin/vers/claude-maskot/node_modules/.bin/electron</string>
    <string>/chemin/vers/claude-maskot</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.claude-maskot.plist
```

## Crédits

- Design de la mascotte © [Anthropic](https://www.anthropic.com) — projet personnel, non affilié
- Animations flip-book reconstituées par [Ayotomiwa Wale-Durojaye](https://ayotomcs.me/claude-mascot) ([article Codrops](https://tympanus.net/codrops/2026/05/05/reverse-engineering-claude-ais-mascot-animations-with-svg-and-gsap/))
- Animations propulsées par [GSAP](https://gsap.com)
