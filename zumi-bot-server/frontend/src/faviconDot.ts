const FAVICON = '/favicon.png'
const SIZE = 64

let drawn: { color: string; url: string } | null = null

// The Routines tab dot's colour, resolved: canvas cannot read light-dark() or a custom property.
function warningColor(): string {
  const probe = document.createElement('span')
  probe.style.color = 'var(--warning)'
  probe.style.display = 'none'
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color || '#ffb700'
}

function draw(color: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, SIZE, SIZE)
      const r = SIZE * 0.2
      ctx.beginPath()
      ctx.arc(SIZE - r - 2, r + 2, r, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => resolve(null)
    img.src = FAVICON
  })
}

function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/png'
    document.head.append(link)
  }
  return link
}

let wanted = false

/** The normal icon, or the icon with an amber dot while something waits on the user. */
export async function setFaviconDot(on: boolean): Promise<void> {
  wanted = on
  if (!on) {
    iconLink().href = FAVICON
    return
  }
  const color = warningColor()
  if (drawn?.color !== color) {
    const url = await draw(color)
    if (url) drawn = { color, url }
  }
  // The count may have dropped to 0 while the image loaded.
  if (wanted && drawn) iconLink().href = drawn.url
}
