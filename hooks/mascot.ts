// The mascot: Kibbles, a chibi cream frog adapted from the user's own sock-frog plush:
// spiral-stitched eye bumps, a red zigzag stitched mouth, an X belly stitch.
// Busy (a task running): works behind a big computer, sweating.
// Idle: asleep, eyes closed, breathing slowly, z's floating up.

export type Mood = 'happy' | 'neutral' | 'worried'
export type Activity = 'busy' | 'sleep' | 'wait'

export function moodFor(weekPct: number): Mood {
  return weekPct < 50 ? 'happy' : weekPct <= 80 ? 'neutral' : 'worried'
}

const CREAM = '#f4ecd8'
const SHADE = '#e3d6b8'
const EDGE = '#b9a67f'
const RED = '#d8322c'
const SLEEP_INK = '#8a7550'
const ZZZ = '#4f86c6'
const W = 2.6

const BUMPS: [number, number, number][] = [
  [27, 22, 15],
  [73, 22, 15],
]

function spiral(cx: number, cy: number, r: number, turns = 2.6): string {
  const steps = 60
  let d = ''
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * turns * Math.PI * 2
    const rr = (i / steps) * r
    d += `${i === 0 ? 'M' : 'L'}${(cx + rr * Math.cos(t)).toFixed(2)} ${(cy + rr * Math.sin(t)).toFixed(2)}`
  }
  return d
}

function silhouette(): string {
  const parts = (stroke: boolean) => {
    const s = stroke ? ` stroke="${EDGE}" stroke-width="${W}"` : ''
    return (
      `<rect x="36" y="76" width="28" height="22" rx="10" fill="${CREAM}"${s}/>` +
      `<rect x="10" y="20" width="80" height="62" rx="30" fill="${CREAM}"${s}/>` +
      BUMPS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${CREAM}"${s}/>`).join('')
    )
  }
  const knit =
    `<g fill="url(#k)">` +
    parts(false).replaceAll(`fill="${CREAM}"`, '') +
    `</g>`
  return parts(true) + parts(false) + knit
}

function limb(from: [number, number], to: [number, number], width: number, end: (fill: string, grow: number) => string): string {
  const line = (c: string, w: number) =>
    `<path d="M${from.join(' ')}L${to.join(' ')}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`
  return line(EDGE, width + W) + end(EDGE, W / 2) + line(CREAM, width) + end(CREAM, 0)
}

const hand = (x: number, y: number, r: number) => (fill: string, grow: number) =>
  `<circle cx="${x}" cy="${y}" r="${r + grow}" fill="${fill}"/>`
const foot = (x: number, y: number) => (fill: string, grow: number) =>
  `<ellipse cx="${x}" cy="${y}" rx="${7 + grow}" ry="${4.5 + grow}" fill="${fill}"/>`

function legs(): string {
  return (
    limb([44, 96], [42, 108], 6, foot(39, 111)) +
    limb([56, 96], [58, 108], 6, foot(61, 111))
  )
}

// The sleeping mouth breathes: on each slow breath (3.4s, in time with the
// body) it opens from its mood's line into a round "o", deep-sleep style, and
// closes again. Both shapes are the same four-curve oval so they morph.
function oval(cx: number, cy: number, rx: number, ry: number, bow: number): string {
  const k = 0.5523
  const p = (x: number, y: number) => {
    const t = (x - cx) / rx
    return `${x.toFixed(2)} ${(y + bow * (1 - t * t)).toFixed(2)}`
  }
  return (
    `M${p(cx - rx, cy)}` +
    `C${p(cx - rx, cy - k * ry)} ${p(cx - k * rx, cy - ry)} ${p(cx, cy - ry)}` +
    `C${p(cx + k * rx, cy - ry)} ${p(cx + rx, cy - k * ry)} ${p(cx + rx, cy)}` +
    `C${p(cx + rx, cy + k * ry)} ${p(cx + k * rx, cy + ry)} ${p(cx, cy + ry)}` +
    `C${p(cx - k * rx, cy + ry)} ${p(cx - rx, cy + k * ry)} ${p(cx - rx, cy)}Z`
  )
}

function sleepMouth(mood: Mood, animated: boolean, frame: number): string {
  const closed =
    mood === 'happy'
      ? oval(50, 60.5, 6, 0.3, 2.6)
      : mood === 'neutral'
        ? oval(50, 61, 5, 0.3, 0)
        : oval(50, 62, 5, 0.3, -2.2)
  const open = oval(50, 62, 3.4, 4, 0)
  const mid = oval(50, 61.5, 4.4, 2, 0)
  const still = [mid, open, closed][frame % 3] ?? closed
  const anim = animated
    ? `<animate attributeName="d" values="${closed};${open};${open};${closed}" keyTimes="0;0.45;0.6;1" calcMode="spline" keySplines="0.4 0 0.6 1;0 0 1 1;0.4 0 0.6 1" dur="3.4s" repeatCount="indefinite"/>`
    : ''
  return `<path d="${animated ? closed : still}" fill="#a8231e" fill-opacity="0.6" stroke="${RED}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${anim}</path>`
}

const belly = `<path d="M48 87L52 91M52 87L48 91" stroke="${RED}" stroke-width="1.4" stroke-linecap="round"/>`

function sweat(animated: boolean): string {
  return `<path d="M92 40 Q88 47 92 49.5 Q96 47 92 40Z" fill="#8fd0f5" stroke="#5aa9d6" stroke-width="0.8">${
    animated ? `<animate attributeName="opacity" values="1;0.35;1" dur="1.2s" repeatCount="indefinite"/>` : ''
  }</path>`
}

// --- mood cues, the same in every pose -------------------------------------
// Happy (under 50% weekly): a floating note or heart, rosy cheeks, no sweat.
// Neutral (50-80%): the plain look. Worried (over 80%): blue worry lines on
// the forehead, red flushed cheeks, furrowed brows and sweat.

function cheeks(mood: Mood): string {
  const [fill, op, rx] = mood === 'worried' ? ['#ff5a5a', 0.6, 6] : mood === 'happy' ? ['#f48fb1', 0.6, 5.5] : ['#f4a7b4', 0.35, 5]
  return [33, 67].map(x => `<ellipse cx="${x}" cy="55" rx="${rx}" ry="2.8" fill="${fill}" fill-opacity="${op}"/>`).join('')
}

/** Manga worry lines on the forehead, between the eye bumps. */
function gloom(animated: boolean): string {
  const anim = animated ? `<animate attributeName="opacity" values="0.9;0.45;0.9" dur="1s" repeatCount="indefinite"/>` : ''
  return (
    `<g stroke="#5b6fd6" stroke-width="1.6" stroke-linecap="round" opacity="0.9">${anim}` +
    `<path d="M45 26v8M50 25v10M55 26v8"/></g>`
  )
}

/** Furrowed brows above the eye bumps (inner ends raised). */
const brows = `<path d="M18 13L32 8.5M82 13L68 8.5" stroke="${SLEEP_INK}" stroke-width="2" stroke-linecap="round"/>`

/** A symbol floating up beside the head: ♪ when happy at work, ♥ in sleep. */
function floater(symbol: string, color: string, animated: boolean, frame: number): string {
  if (!animated) {
    return frame % 3 === 2 ? '' : `<text x="2" y="${frame % 3 === 0 ? 34 : 26}" font-family="Arial, sans-serif" font-weight="700" font-size="19" fill="${color}">${symbol}</text>`
  }
  return (
    `<text x="0" y="40" font-family="Arial, sans-serif" font-weight="700" font-size="19" fill="${color}" opacity="0">${symbol}` +
    `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.2;0.7;1" dur="2.4s" repeatCount="indefinite"/>` +
    `<animateTransform attributeName="transform" type="translate" values="0 4;3 -14" dur="2.4s" repeatCount="indefinite"/>` +
    `</text>`
  )
}

/** Steam puffing off an overworked head. */
function steam(animated: boolean, frame: number): string {
  const puff = (x: number, delay: number, i: number) =>
    animated
      ? `<circle cx="${x}" cy="6" r="3" fill="#a9b1bb" stroke="#8a929c" stroke-width="0.6" opacity="0">` +
        `<animate attributeName="opacity" values="0;0.95;0" dur="1.2s" begin="${delay}s" repeatCount="indefinite"/>` +
        `<animate attributeName="r" values="2.5;6.5" dur="1.2s" begin="${delay}s" repeatCount="indefinite"/>` +
        `<animate attributeName="cy" values="8;-7" dur="1.2s" begin="${delay}s" repeatCount="indefinite"/></circle>`
      : (frame + i) % 2 === 0
        ? `<circle cx="${x}" cy="0" r="5" fill="#a9b1bb" stroke="#8a929c" stroke-width="0.6" opacity="0.9"/>`
        : ''
  return puff(38, 0, 0) + puff(50, 0.4, 1) + puff(62, 0.8, 2)
}

// Busy: the frog sits behind a big computer, only its spiral eyes peeking over
// the monitor, hands tapping a keyboard at the sides, sweat dripping down.
// The mood shows in how hard it sweats and how fast its eyes spin.
const CASE = '#c3cad2'
const CASE_EDGE = '#7d8790'
const DESK = '#c8a27c'
const DESK_EDGE = '#9c7a56'
const DROP = '#8fd0f5'
const DROP_EDGE = '#5aa9d6'

function drop(x: number, y: number, dx: number, delay: number, dur: number, animated: boolean, shown: boolean): string {
  const shape = `<path d="M${x} ${y} q-3.2 5.2 0 7.2 q3.2 -2 0 -7.2Z" fill="${DROP}" stroke="${DROP_EDGE}" stroke-width="0.7"/>`
  if (!animated) return shown ? `<g transform="translate(${dx / 2} 7)">${shape}</g>` : ''
  return (
    `<g opacity="0">` +
    `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.7;1" dur="${dur}s" begin="${delay}s" repeatCount="indefinite"/>` +
    `<animateTransform attributeName="transform" type="translate" values="0 -2;${dx} 16" calcMode="spline" keyTimes="0;1" keySplines="0.5 0 1 1" dur="${dur}s" begin="${delay}s" repeatCount="indefinite"/>` +
    shape +
    `</g>`
  )
}

function busy(mood: Mood, animated: boolean, frame: number): string {
  const fast = mood === 'worried'
  const eyes = BUMPS.map(([x, y, r], i) => {
    const spin = animated
      ? `<animateTransform attributeName="transform" type="rotate" from="0 ${x} ${y}" to="${fast ? -360 : 360} ${x} ${y}" dur="${fast ? '1.1s' : mood === 'neutral' ? '1.9s' : '2.8s'}" repeatCount="indefinite"/>`
      : ''
    const still = animated ? '' : ` transform="rotate(${frame * 120 + i * 40} ${x} ${y})"`
    return `<g${still}>${spin}<path d="${spiral(x, y, r * 0.68)}" fill="none" stroke="${RED}" stroke-width="1.5" stroke-linecap="round"/></g>`
  }).join('')

  // Screen light on the face above the monitor.
  const glow =
    `<g fill="#bfe3ff" opacity="0.22"><rect x="10" y="20" width="80" height="62" rx="30"/>` +
    BUMPS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('') +
    (animated ? `<animate attributeName="opacity" values="0.12;0.3;0.18;0.28;0.12" dur="2.2s" repeatCount="indefinite"/>` : '') +
    `</g>`

  // Hands tapping on the keyboard at the monitor's sides; arms behind the body.
  // Relaxed when happy, frantic when worried.
  const typing = mood === 'happy' ? 0.45 : mood === 'neutral' ? 0.3 : 0.16
  const tap = (x: number, delay: string, up: boolean) => {
    const anim = animated
      ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -3;0 0" dur="${typing}s" begin="${delay}" repeatCount="indefinite"/>`
      : ''
    const still = !animated && up ? ' transform="translate(0 -3)"' : ''
    return `<g${still}>${anim}${hand(x, 96, 5.5)(EDGE, W / 2)}${hand(x, 96, 5.5)(CREAM, 0)}</g>`
  }
  const arms =
    limb([38, 84], [9, 95], 6, () => '') + limb([62, 84], [91, 95], 6, () => '')

  // Worried: a nervous jitter instead of the calm bob.
  const bob = animated
    ? fast
      ? `<animateTransform attributeName="transform" type="translate" values="0 0;-0.8 0;0.8 0;0 0" dur="0.18s" repeatCount="indefinite"/>`
      : `<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="0.6s" repeatCount="indefinite"/>`
    : ''

  // The back of a big monitor: case, red dot logo, vents, stand.
  const monitor =
    `<rect x="45" y="86" width="10" height="11" fill="${CASE_EDGE}"/>` +
    `<rect x="12" y="38" width="76" height="52" rx="5" fill="${CASE}" stroke="${CASE_EDGE}" stroke-width="2"/>` +
    `<rect x="16" y="42" width="68" height="44" rx="3" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1"/>` +
    `<circle cx="50" cy="62" r="4" fill="${RED}"/>` +
    [74, 78, 82].map(y => `<path d="M38 ${y}h24" stroke="${CASE_EDGE}" stroke-width="1.2" stroke-linecap="round" opacity="0.6"/>`).join('') +
    `<ellipse cx="50" cy="98" rx="14" ry="2.6" fill="${CASE_EDGE}"/>`

  const desk =
    `<rect x="-2" y="99" width="124" height="22" fill="${DESK}"/>` +
    `<path d="M-2 99.5h124" stroke="${DESK_EDGE}" stroke-width="1.6"/>` +
    `<rect x="0" y="94.5" width="22" height="4" rx="1.5" fill="#6d747c"/>` +
    `<rect x="78" y="94.5" width="22" height="4" rx="1.5" fill="#6d747c"/>`

  // Sweat: none when happy, one when neutral, three (faster) when worried.
  const spots: [number, number, number][] = [
    [94, 22, 1.5],
    [5, 22, -1.5],
    [50, 2, 0],
  ]
  const drops = spots
    .slice(0, mood === 'happy' ? 0 : mood === 'neutral' ? 1 : 3)
    .map(([x, y, dx], i) => drop(x, y, dx, i * 0.45, fast ? 0.9 : 1.4, animated, (frame + i) % 2 === 0))
    .join('')

  return (
    `<g>${bob}${arms}${silhouette()}${eyes}${glow}${fast ? gloom(animated) : ''}</g>` +
    monitor +
    desk +
    tap(11, '0s', frame % 2 === 0) +
    tap(89, `${typing / 2}s`, frame % 2 === 1) +
    drops +
    (mood === 'happy' ? floater('♪', '#3fae6a', animated, frame) : '') +
    (fast ? steam(animated, frame) : '')
  )
}

function sleep(mood: Mood, animated: boolean, frame: number): string {
  const eyes = BUMPS.map(
    ([x, y]) =>
      `<path d="M${x - 7} ${y} Q${x} ${y + 6} ${x + 7} ${y}" fill="none" stroke="${SLEEP_INK}" stroke-width="2" stroke-linecap="round"/>`,
  ).join('')
  const arms =
    limb([40, 82], [27, 95], 6, hand(27, 95, 5.5)) + limb([60, 82], [73, 95], 6, hand(73, 95, 5.5))
  // Worried sleepers toss and turn.
  const restless = animated && mood === 'worried'
    ? `<animateTransform attributeName="transform" type="rotate" values="0 50 111;-3 50 111;0 50 111;3 50 111;0 50 111" dur="2.6s" repeatCount="indefinite"/>`
    : ''

  // Snore bubble: a sideways teardrop blown out of the mouth. Its point stays
  // at the mouth's corner while it swells with each slow breath, then pops.
  const tipX = 52.5
  const tipY = 62
  const r = 6.5
  const L = 11
  const teardrop =
    `M0 0 C${r * 0.7} ${-r * 0.45} ${L - r * 0.9} ${-r} ${L} ${-r} ` +
    `A${r} ${r} 0 1 1 ${L} ${r} C${L - r * 0.9} ${r} ${r * 0.7} ${r * 0.45} 0 0Z`
  const swell = animated
    ? `<animateTransform attributeName="transform" type="scale" values="0.12;1;1.08;0.01;0.12" keyTimes="0;0.72;0.78;0.8;1" dur="3.4s" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="0.95;0.95;0.95;0;0.95" keyTimes="0;0.72;0.78;0.8;1" dur="3.4s" repeatCount="indefinite"/>`
    : ''
  const still = [0.55, 1, 0.25][frame % 3] ?? 0.55
  const bubble =
    `<g transform="translate(${tipX} ${tipY})"><g${animated ? '' : ` transform="scale(${still})"`}>${swell}` +
    `<path d="${teardrop}" fill="#cfeaff" fill-opacity="0.65" stroke="#7fb6e0" stroke-width="0.9" stroke-linejoin="round"/>` +
    `<ellipse cx="${L + r * 0.3}" cy="${-r * 0.45}" rx="1.8" ry="1.1" fill="#ffffff" opacity="0.85"/></g></g>`
  const pop = animated
    ? `<g transform="translate(${tipX + L} ${tipY})" stroke="#7fb6e0" stroke-width="0.9" stroke-linecap="round" opacity="0">` +
      `<animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;0.78;0.81;0.9;1" dur="3.4s" repeatCount="indefinite"/>` +
      `<path d="M0 -9l0 -2.5M7 -6l2 -1.5M9 0l2.5 0M7 6l2 1.5M0 9l0 2.5"/></g>`
    : ''

  const breathe = animated
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 1.6;0 0" dur="3.4s" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" repeatCount="indefinite"/>`
    : ''

  const z = (i: number) => {
    const x = 93 + i * 7
    const y = 34 - i * 11
    const size = 11 + i * 4
    if (animated) {
      return (
        `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-weight="700" font-size="${size}" fill="${ZZZ}" opacity="0">z` +
        `<animate attributeName="opacity" values="0;1;0" dur="3s" begin="${i}s" repeatCount="indefinite"/>` +
        `<animateTransform attributeName="transform" type="translate" values="0 6;0 -4" dur="3s" begin="${i}s" repeatCount="indefinite"/>` +
        `</text>`
      )
    }
    const shown = (i + frame) % 3 !== 2
    return shown
      ? `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-weight="700" font-size="${size}" fill="${ZZZ}">z</text>`
      : ''
  }

  return (
    `<g>${restless}` +
    legs() +
    `<g>${breathe}${arms}${silhouette()}${eyes}${cheeks(mood)}${mood === 'worried' ? brows + gloom(animated) : ''}` +
    `${sleepMouth(mood, animated, frame)}${belly}${bubble}${pop}</g></g>` +
    z(0) +
    z(1) +
    z(2) +
    (mood === 'worried' ? sweat(animated) : '') +
    (mood === 'happy' ? floater('♥', '#e5679a', animated, frame) : '')
  )
}

/**
 * The mascot as an SVG document. `animated` adds SMIL motion; without it,
 * `frame` (0, 1, 2) picks a still pose for raster frames.
 */
// Waiting on you (a permission or a question): the frog stands up, looks at
// you with a little "o" mouth and waves one arm, with a "!" bubble bouncing.
function wait(mood: Mood, animated: boolean, frame: number): string {
  const eyes = BUMPS.map(
    ([x, y, r]) =>
      `<path d="${spiral(x, y, r * 0.68)}" fill="none" stroke="${RED}" stroke-width="1.5" stroke-linecap="round"/>`,
  ).join('')
  const restArm = limb([40, 82], [27, 95], 6, hand(27, 95, 5.5))
  const waveAngles = [8, -12, -2]
  const wave = animated
    ? `<animateTransform attributeName="transform" type="rotate" values="8 62 84;-12 62 84;8 62 84" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" dur="0.7s" repeatCount="indefinite"/>`
    : ''
  const still = animated ? '' : ` transform="rotate(${waveAngles[frame % 3] ?? 0} 62 84)"`
  const waveArm = `<g${still}>${wave}${limb([62, 84], [94, 76], 6, hand(94, 76, 5.8))}</g>`
  // Happy: an open smile. Neutral: a little "o". Worried: a wobbly frown.
  const mouth =
    mood === 'happy'
      ? `<path d="M44.5 58.5 Q50 67 55.5 58.5Z" fill="#a8231e" fill-opacity="0.6" stroke="${RED}" stroke-width="1.5" stroke-linejoin="round"/>`
      : mood === 'neutral'
        ? `<path d="${oval(50, 61, 2.6, 3, 0)}" fill="#a8231e" fill-opacity="0.6" stroke="${RED}" stroke-width="1.5"/>`
        : `<path d="M44 63 Q47 59.5 50 63 Q53 66.5 56 63" fill="none" stroke="${RED}" stroke-width="1.8" stroke-linecap="round"/>`
  const bounce = animated
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -3;0 0" dur="0.8s" repeatCount="indefinite"/>`
    : ''
  const bubble =
    `<g${animated ? '' : ` transform="translate(0 ${frame % 2 ? -3 : 0})"`}>${bounce}` +
    (mood === 'worried'
      ? `<circle cx="104" cy="22" r="10" fill="#ff8a80" stroke="#c62828" stroke-width="1.3"/>` +
        `<path d="M100.5 16.5v7M107.5 16.5v7" stroke="#7f0000" stroke-width="2.4" stroke-linecap="round"/>` +
        `<circle cx="100.5" cy="27.4" r="1.4" fill="#7f0000"/><circle cx="107.5" cy="27.4" r="1.4" fill="#7f0000"/>`
      : `<circle cx="104" cy="22" r="9" fill="#ffd36b" stroke="#c9921a" stroke-width="1.2"/>` +
        `<path d="M104 16.5v7" stroke="#5a3d00" stroke-width="2.6" stroke-linecap="round"/>` +
        `<circle cx="104" cy="27.4" r="1.5" fill="#5a3d00"/>`) +
    `</g>`
  return (
    legs() +
    restArm +
    waveArm +
    silhouette() +
    eyes +
    cheeks(mood) +
    (mood === 'worried' ? brows + gloom(animated) : '') +
    mouth +
    belly +
    (mood === 'worried' ? sweat(animated) : '') +
    (mood === 'happy' ? floater('♪', '#3fae6a', animated, frame) : '') +
    bubble
  )
}

export function mascotSvg(mood: Mood, activity: Activity, animated: boolean, frame = 0): string {
  const knit = `<pattern id="k" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M0 1.5h3" stroke="${SHADE}" stroke-width="0.5" stroke-opacity="0.6"/></pattern>`
  const body =
    activity === 'busy' ? busy(mood, animated, frame) : activity === 'wait' ? wait(mood, animated, frame) : sleep(mood, animated, frame)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -8 122 128" width="120" height="126">` +
    `<defs>${knit}</defs>${body}</svg>`
  )
}

/** A one-line face for surfaces that can show no picture. */
export function textFace(mood: Mood, activity: Activity): string {
  if (activity === 'sleep') return '(-‿-) z'
  if (activity === 'wait') return '(@o@)ノ!'
  return mood === 'happy' ? '(@ω@)' : mood === 'neutral' ? '(@_@)' : '(@~@);'
}
