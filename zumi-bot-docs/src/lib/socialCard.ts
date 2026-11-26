// The link-preview image for every page (Slack, X, iMessage, LinkedIn). Starlight writes the page's own og:title,
// og:description, og:url and twitter:card itself, but no image, so a pasted link unfurled with an empty picture.
// The PNG is drawn by `npm run og-image` at the repo root; never edit it by hand.
export const OG_IMAGE = 'og-image.png'

interface MetaTag {
  tag: 'meta'
  attrs: { property?: string; name?: string; content: string }
}

/** Starlight `head` entries. Crawlers need an absolute image URL, so it is built from the config's `site`. */
export function socialHead(site: string): MetaTag[] {
  const image = `${site.replace(/\/$/, '')}/${OG_IMAGE}`
  const og = (property: string, content: string): MetaTag => ({ tag: 'meta', attrs: { property, content } })
  return [
    og('og:image', image),
    og('og:image:type', 'image/png'),
    og('og:image:width', '1200'),
    og('og:image:height', '630'),
    og('og:image:alt', 'The ZumiBot Docs logo and the slogan: Your agents. Your workspace. Your rules.'),
    { tag: 'meta', attrs: { name: 'twitter:image', content: image } }
  ]
}
