// Renders the link-preview cards (1200x630, what Slack, X, iMessage and LinkedIn show for a link): the site's
// zumi-bot-site/public/og-image.png and the docs' zumi-bot-docs/public/og-image.png. Run `npm run og-image` after changing
// the Z, the cast, the colours or a card's words.
// Unlike make-icons.mjs it needs a browser, for the text: it draws the card in headless Chrome (the e2e suites' own
// playwright-core, channel 'chrome') and screenshots it. The layout is centred so a square crop (Slack's thumbnail,
// Discord) still shows the Z and the name.
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SHAPES = join(ROOT, 'design', 'zumibot-icon', 'zumibot-svg')
const [W, H] = [1200, 630]

// The site's dark palette (zumi-bot-site/src/styles.css, from the app's tokens.css).
const C = {
  bg: '#13161c',
  tile: '#0d1016',
  fg: '#eef2f8',
  muted: '#9aa3b5',
  accent: '#2f6bf0',
  accentText: '#6ea1ff',
  zumi: '#4a86ff'
}
// The page's demo cast (showcase.ts AGENTS), in the agent colours' dark values; three each side of the Z.
const CAST = [
  ['layers', '#429eff'],
  ['lightning', '#6cdb48'],
  ['magnifier', '#a267ff'],
  ['gear', '#ff984a'],
  ['chat', '#f55baa'],
  ['folder', '#ffc53d']
]
// Both cards carry the slogan, its last part in the accent colour; each names its own host.
const SLOGAN = { lead: 'Your agents. Your workspace.', accent: 'Your rules.' }
const CARDS = [
  {
    out: 'zumi-bot-site/public/og-image.png',
    name: 'ZumiBot',
    host: 'zumibot.run'
  },
  {
    out: 'zumi-bot-docs/public/og-image.png',
    name: 'ZumiBot Docs',
    host: 'docs.zumibot.run'
  }
]

const require = createRequire(import.meta.url)
const font = readFileSync(require.resolve('@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2'))

function shape(name, color, size, opacity = 1) {
  const d = readFileSync(join(SHAPES, `${name}.svg`), 'utf8').match(/ d="([^"]+)"/)[1]
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" style="opacity:${opacity}"><path d="${d}" fill="${color}" fill-rule="evenodd"/></svg>`
}

// Inner bots brighter than outer ones, so the eye lands on the Z.
const fade = [0.7, 0.86, 1]
const left = CAST.slice(0, 3)
  .map(([s, c], i) => shape(s, c, 58, fade[i]))
  .join('')
const right = CAST.slice(3)
  .map(([s, c], i) => shape(s, c, 58, fade[2 - i]))
  .join('')

const html = ({ name, host }, { lead, accent } = SLOGAN) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Bricolage'; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); font-weight: 200 800; }
* { margin: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; }
body {
  font-family: 'Bricolage', sans-serif; color: ${C.fg}; overflow: hidden;
  background:
    radial-gradient(620px 360px at 50% 30%, rgb(47 107 240 / 0.26), transparent 70%),
    radial-gradient(900px 420px at 50% 118%, rgb(162 103 255 / 0.10), transparent 70%),
    ${C.bg};
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.cast { display: flex; align-items: center; gap: 30px; }
.side { display: flex; align-items: center; gap: 26px; }
.tile {
  width: 150px; height: 150px; border-radius: 34px; background: ${C.tile};
  display: grid; place-items: center;
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.07), 0 18px 60px rgb(47 107 240 / 0.35);
}
h1 { margin-top: 34px; font-size: 96px; line-height: 1; font-weight: 750; letter-spacing: -0.035em; }
p { margin-top: 22px; font-size: 36px; font-weight: 450; color: ${C.muted}; letter-spacing: -0.01em; }
p b { color: ${C.accentText}; font-weight: 600; }
.url { position: absolute; bottom: 40px; font-size: 24px; font-weight: 550; color: ${C.muted}; letter-spacing: 0.02em; opacity: 0.8; }
</style></head><body>
<div class="cast">
  <div class="side">${left}</div>
  <div class="tile">${shape('zumi-z', C.zumi, 108)}</div>
  <div class="side">${right}</div>
</div>
<h1>${name}</h1>
<p>${lead} <b>${accent}</b></p>
<div class="url">${host}</div>
</body></html>`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  for (const card of CARDS) {
    const out = join(ROOT, card.out)
    await page.setContent(html(card), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: out, type: 'png' })
    console.log(`${card.out} (${Math.round(statSync(out).size / 1024)} KB)`)
  }
} finally {
  await browser.close()
}
