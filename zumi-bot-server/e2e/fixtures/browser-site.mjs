import { createServer } from 'node:http'

// Synthetic only: no external requests, personal profiles, or credentials.
export async function browserSite() {
  const oversized = { bytes: 0, finished: false, closed: false }
  const timers = new Set()
  const server = createServer((req, res) => {
    if (req.url.startsWith('/slow')) return
    if (req.url === '/oversized') {
      res.setHeader('Content-Disposition', 'attachment; filename=oversized.bin')
      const timer = setInterval(() => {
        oversized.bytes += 131072
        res.write(Buffer.alloc(131072))
        if (oversized.bytes >= 64 * 1024 * 1024) {
          oversized.finished = true
          clearInterval(timer)
          timers.delete(timer)
          res.end()
        }
      }, 5)
      timers.add(timer)
      res.on('close', () => {
        oversized.closed = true
        clearInterval(timer)
        timers.delete(timer)
      })
      return
    }
    if (req.url === '/unknown-length') {
      res.setHeader('Content-Disposition', 'attachment; filename=unknown.txt')
      res.write('unknown ')
      setTimeout(() => res.end('length bytes'), 20)
      return
    }
    if (req.url === '/download') {
      res.setHeader('Content-Disposition', 'attachment; filename="network.txt"')
      res.end('network bytes')
      return
    }
    if (req.url === '/anchor') {
      res.end('anchor bytes')
      return
    }
    if (req.url === '/files') {
      res.end(`<!doctype html><title>Files fixture</title>
      <a href="/oversized">Oversized download</a><a href="/unknown-length">Unknown length download</a>
      <a href="/download">Network download</a><a href="/anchor" download="anchor.txt">Anchor download</a>
      <button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['blob bytes']));a.download='blob.txt';a.click()">Blob download</button>
      <label>Upload file<input type="file" aria-label="Upload file" onchange="document.querySelector('#result').textContent=this.files[0]?.name"></label>
      <button onclick="document.querySelector('#result').textContent=prompt('Synthetic prompt','default')">Prompt</button><div id="result"></div>`)
      return
    }
    res.setHeader('Content-Type', 'text/html')
    if (req.url.startsWith('/navigation-dialog')) {
      res.end(
        `<script>alert('Synthetic navigation dialog');${req.url.includes('double') ? "alert('Synthetic second dialog');" : ''}</script><button onclick="document.querySelector('#result').textContent='After dialog clicked'">After alert</button><div id="result"></div>`
      )
      return
    }
    // `?echo=1` adds a line that repeats what is typed into Password, as a careless page might (the vault e2e checks the
    // agent's next observe gets it scrubbed); plain /login stays as the adapter tests know it.
    if (req.url === '/login' || req.url === '/login?echo=1') {
      const echo = req.url.endsWith('?echo=1')
      res.end(`<!doctype html><title>Login fixture</title>
      <label>Username<input name="username" aria-label="Username"></label>
      <label>Password<input type="password" aria-label="Password"${echo ? ` oninput="document.querySelector('#echo').textContent='Typed '+this.value"` : ''}></label>
      <label>Nickname<input type="text" aria-label="Nickname"></label>
      <button>Sign in</button>${echo ? '<p id="echo"></p>' : ''}`)
      return
    }
    if (req.url === '/login-redirect') {
      res.end(`<!doctype html><title>Redirecting login fixture</title>
      <label>Password<input type="password" aria-label="Password"></label>
      <label>Notes<input type="text" aria-label="Notes"></label>
      <script>document.querySelector('[aria-label=Password]').addEventListener('focus', () => document.querySelector('[aria-label=Notes]').focus())</script>`)
      return
    }
    if (req.url === '/fields') {
      res.end(`<!doctype html><title>Fields fixture</title>
      <label>Amount<input type="number" aria-label="Amount"></label>
      <label>Clearing<input type="text" aria-label="Clearing" oninput="this.value=''"></label>`)
      return
    }
    // A value padded so the observation's own cuts fall 6 characters into it: the element name at 256, the page text at 32000.
    if (req.url.startsWith('/straddle-')) {
      const v = (new URL(req.url, 'http://x').searchParams.get('v') ?? '').replace(/[^A-Za-z0-9_ -]/g, '')
      res.end(
        req.url.startsWith('/straddle-name')
          ? `<!doctype html><title>Straddle</title><button aria-label="${'x'.repeat(249)} ${v}"></button>`
          : `<!doctype html><title>Straddle</title><p>${'a'.repeat(31993)} ${v} end</p>`
      )
      return
    }
    // Two copies of a 4 200-character value early on, then a card number that starts 7 characters before the worker's own cut
    // (page text: 32000 + 8192 with no elements; an element name: 256 + 8192), so only its first digits are handed over.
    if (req.url.startsWith('/shrink-')) {
      const params = new URL(req.url, 'http://x').searchParams,
        safe = (v) => (v ?? '').replace(/[^A-Za-z0-9_ -]/g, '')
      const seed = safe(params.get('v')) || 'v',
        value = seed.repeat(Math.ceil(4200 / seed.length)).slice(0, 4200),
        card = safe(params.get('c'))
      res.end(
        req.url.startsWith('/shrink-name')
          ? `<!doctype html><title>Shrink</title><button aria-label="${value} ${value} ${'x'.repeat(8441 - 8403)} ${card}"></button>`
          : `<!doctype html><title>Shrink</title><p>${value} ${value} ${'a'.repeat(40185 - 8403)} ${card} end</p>`
      )
      return
    }
    // A hostile page: many elements with a huge role and nothing else, each cheap against the 32 000 budget, then a plain button.
    if (req.url.startsWith('/hostile')) {
      const params = new URL(req.url, 'http://x').searchParams,
        n = Math.min(Number(params.get('n')) || 0, 400),
        len = Math.min(Number(params.get('len')) || 0, 20000)
      res.end(`<!doctype html><title>Hostile</title>${`<div role="${'r'.repeat(len)}">.</div>`.repeat(n)}<button>After</button>`)
      return
    }
    // Tab title, URL and dialog text each longer than the limit an agent gets plus the scrub margin; `v` sits 6 characters before
    // each final limit (title 500, URL 8192, dialog 2000).
    if (req.url.startsWith('/long-status')) {
      const v = (new URL(req.url, 'http://x').searchParams.get('v') ?? '').replace(/[^A-Za-z0-9_ -]/g, '')
      const title = `${'T'.repeat(493)} ${v} ${'T'.repeat(9000)}`,
        message = `${'M'.repeat(1993)} ${v} ${'M'.repeat(12000)}`
      res.end(`<!doctype html><title>${title}</title><button onclick="alert(${JSON.stringify(message).replace(/"/g, '&quot;')})">Alert</button>
      <script>const base=location.href.split('#')[0];history.replaceState(null,'','#'+'f'.repeat(8192-base.length-8)+' ${v} '.replace(/ /g,'_')+'f'.repeat(10000))</script>`)
      return
    }
    if (req.url === '/tricky') {
      res.end(`<!doctype html><title>Tricky fields</title>
      <label>Morphing<input type="password" aria-label="Morphing password" oninput="this.type='text'"></label>
      <label>Replaced<input type="password" aria-label="Replaced password" onfocus="const n=document.createElement('input');n.type='password';n.setAttribute('aria-label','Replacement');this.replaceWith(n)"></label>
      <label>Stripping<input type="password" aria-label="Stripping password" oninput="this.value=this.value.replace(/[.-]/g,'')"></label>
      <label>Formatted<input aria-label="Formatted card" oninput="this.value=this.value.replace(/(\\d{4})(?=\\d)/g,'$1 ')"></label>`)
      return
    }
    // Fields a page reformats as they are typed: a phone formatter, upper-cased names and postcodes, a lower-cased email, a
    // spaced-out 2FA code, and two password fields that change what they get.
    if (req.url === '/reformat') {
      res.end(`<!doctype html><title>Reformatting fields</title>
      <label>Phone<input type="tel" aria-label="Phone" oninput="const d=this.value.replace(/\\D/g,'');if(d.length===11)this.value='+'+d[0]+' ('+d.slice(1,4)+') '+d.slice(4,7)+'-'+d.slice(7)"></label>
      <label>Holder<input aria-label="Holder" oninput="this.value=this.value.toUpperCase()"></label>
      <label>Email<input type="email" aria-label="Email" oninput="this.value=this.value.toLowerCase()"></label>
      <label>Code<input aria-label="Code" oninput="const d=this.value.replace(/\\D/g,'');if(d.length===6)this.value=d.slice(0,3)+' '+d.slice(3)"></label>
      <label>Postcode<input aria-label="Postcode" oninput="this.value=this.value.toUpperCase()"></label>
      <label>Shouting<input type="password" aria-label="Shouting password" oninput="this.value=this.value.toUpperCase()"></label>
      <label>Spacing<input type="password" aria-label="Spacing password" oninput="this.value=this.value.replace(/(.{4})(?=.)/g,'$1 ')"></label>`)
      return
    }
    if (req.url.startsWith('/checkout')) {
      const params = new URL(req.url, 'http://x').searchParams,
        clean = (v) => (v ?? '').replace(/[^A-Za-z0-9:/._-]/g, '')
      const origin = params.get('frame') ?? '',
        ad = params.get('ad'),
        many = Math.min(Number(params.get('many')) || 0, 400)
      const label = (params.get('label') ?? '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 60) || 'Extra'
      // A focus thief: the top page itself (grab=1) or a third-party ad frame keeps taking focus for its own input.
      const grab =
        "const m=document.getElementById('mine');const c=new MessageChannel();c.port1.onmessage=()=>{if(document.activeElement!==m||!document.hasFocus())m.focus();c.port2.postMessage(0)};c.port2.postMessage(0)"
      res.end(`<!doctype html><title>Checkout fixture</title>
      <h1>Checkout</h1><button>Place order</button>
      ${`<button>${label}</button>`.repeat(many)}
      <iframe title="Card" width="400" height="300" src="${clean(origin)}/card-frame"></iframe>
      ${ad ? `<iframe title="Ad" width="300" height="60" src="${clean(ad)}/ad-frame"></iframe>` : ''}
      ${params.get('grab') ? `<input id="mine" aria-label="Notes"><script>${grab}</script>` : ''}`)
      return
    }
    if (req.url === '/ad-frame') {
      res.end(`<!doctype html><title>Ad</title><input id="mine" aria-label="Ad input">
      <script>const m=document.getElementById('mine');const c=new MessageChannel();c.port1.onmessage=()=>{if(document.activeElement!==m||!document.hasFocus())m.focus();c.port2.postMessage(0)};c.port2.postMessage(0)</script>`)
      return
    }
    if (req.url === '/card-frame') {
      res.end(`<!doctype html><title>Card frame</title>
      <label>Card number<input aria-label="Card number" oninput="document.querySelector('#echo').textContent='Typed '+this.value"></label>
      <label>Expiry<input aria-label="Expiry"></label>
      <label>CVC<input aria-label="CVC"></label>
      <select aria-label="Expiry month" onchange="document.querySelector('#echo').textContent='Month '+this.value"><option value="01">01</option><option value="02">02</option><option value="03">03</option></select>
      <button aria-label="Echo" id="echo"></button>`)
      return
    }
    if (req.url === '/select') {
      res.end(`<!doctype html><title>Select fixture</title>
      <select aria-label="Requested By" style="width:300px" onchange="document.querySelector('#result').textContent='Picked '+this.value">
        <option value="" disabled selected>Select an option ...</option><option value="omima">Omima Ghanem</option>
        <option>Fadi Selo</option><option disabled>Retired</option><option>Inas Nasri</option></select>
      <select aria-label="Locked" disabled><option>Locked</option></select>
      <button>Plain button</button><div id="result"></div>`)
      return
    }
    if (req.url === '/large') {
      res.end('<button onclick="this.textContent=\'Large action clicked\'">Action</button><p>' + 'Synthetic text '.repeat(8000) + '</p>')
      return
    }
    // Known CSS for the audit tools: an inline-styled box, font lists either side of the worker's cut (304 and 9 016 characters
    // against 200 + 8 192), a :hover colour, and a button under another element; the spacer makes the page taller than the viewport.
    // Few long font names, not many short ones: every unknown family is a font lookup at each paint (900 took a second).
    if (req.url === '/style') {
      const fonts = (n, len) => Array.from({ length: n }, (_, k) => `Font${k}`.padEnd(len, 'x')).join(', ')
      res.end(`<!doctype html><title>Style fixture</title>
      <style>body{margin:0}#hover{background-color:rgb(0, 0, 255)}#hover:hover{background-color:rgb(255, 0, 0)}</style>
      <button id="box" style="position:absolute;left:40px;top:30px;box-sizing:border-box;width:200px;height:50px;padding:4px 8px;border:0;border-radius:6px;font-size:16px;color:#fff;background-color:#336699">Styled</button>
      <button style="position:absolute;left:40px;top:100px;font-family:${fonts(3, 100)}">Short fonts</button>
      <button style="position:absolute;left:200px;top:100px;font-family:${fonts(9, 1000)}">Long fonts</button>
      <button id="hover" style="position:absolute;left:40px;top:160px;width:120px;height:40px;border:0">Hover me</button>
      <button style="position:absolute;left:40px;top:240px;width:120px;height:40px" onmouseover="alert('Hover dialog')">Hover alert</button>
      <button style="position:absolute;left:300px;top:30px;width:100px;height:40px">Covered</button>
      <div style="position:absolute;left:290px;top:20px;width:140px;height:60px;background:#ccc"></div>
      <div style="height:1500px"></div>`)
      return
    }
    // Random pixels a PNG can't compress, taller than the viewport: a whole-page shot passes 5 MiB, the viewport alone does not.
    // The canvas has a role so an observation lists it, for an element shot of it.
    if (req.url === '/noise') {
      res.end(`<!doctype html><title>Noise fixture</title><style>body{margin:0}canvas{display:block}</style>
      <canvas role="img" aria-label="Noise" width="1280" height="2000"></canvas>
      <script>const c=document.querySelector('canvas'),x=c.getContext('2d'),d=x.createImageData(c.width,c.height);for(let i=0;i<d.data.length;i++)d.data[i]=i%4===3?255:Math.random()*256|0;x.putImageData(d,0,0)</script>`)
      return
    }
    res.end(`<!doctype html><title>Browser fixture</title>
      <label>Account<input aria-label="Account"></label>
      <input type="password" aria-label="Password" value="fixture-private-password">
      <button onclick="document.querySelector('#result').textContent='Clicked'">Click me</button>
      <button onclick="document.querySelector('#result').textContent=document.querySelector('input').value">Show account</button>
      <button onclick="const windows=[window.open('about:blank'),window.open('about:blank')];setTimeout(()=>windows.forEach(w=>w.location='/navigation-dialog'),100)">Popup dialogs</button>
      <button onclick="alert('Synthetic dialog')">Dialog</button>
      <button onclick="for(let i=0;i<6;i++)window.open('/popup?'+i)">Popups</button>
      <button onclick="document.cookie='fixture=persisted;max-age=3600';location.reload()">Set cookie</button>
      <div id="result"></div><p id="cookie"></p>
      <div style="position:fixed;left:600px;top:200px;width:100px;height:100px"
        onmousemove="document.querySelector('#result').textContent='Buttons '+event.buttons">Pointer area</div>
      <script>document.querySelector('#cookie').textContent=document.cookie;
      let n=0;setInterval(()=>document.body.style.background=n++%2?'#fff':'#eee',100)</script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    oversized,
    url: `http://127.0.0.1:${port}`,
    hostUrl: `http://localhost:${port}`,
    close: async () => {
      for (const timer of timers) clearInterval(timer)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
