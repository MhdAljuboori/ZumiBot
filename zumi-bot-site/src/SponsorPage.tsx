import { useId } from 'react'
import { Bot } from './Bot.tsx'
import { Heart, SiteFooter, SiteHeader } from './Chrome.tsx'
import { CopyButton } from './CopyButton.tsx'
import { GitHubMark, Glyph } from './Glyph.tsx'
import { CONTACT_EMAIL, GITHUB_URL } from './siteLinks.ts'
import { USDT_TRC20, type CryptoWallet } from './sponsor.ts'

// A QR code needs a quiet zone of four modules and dark modules on light, in either theme, or phones fail to read it.
const QUIET = 4

function QrCode({ wallet }: { wallet: CryptoWallet }) {
  const side = wallet.qrSize + QUIET * 2
  return (
    <svg className="qr" viewBox={`${-QUIET} ${-QUIET} ${side} ${side}`} role="img" aria-label={`QR code of the ${wallet.coin} address`}>
      <rect x={-QUIET} y={-QUIET} width={side} height={side} fill="#ffffff" />
      <path d={wallet.qr} fill="#000000" shapeRendering="crispEdges" />
    </svg>
  )
}

function WalletCard({ wallet }: { wallet: CryptoWallet }) {
  const addrId = useId()
  return (
    <div className="give card" data-testid="sponsor-wallet">
      <div className="give-head">
        <span className="give-coin">{wallet.coin}</span>
        <span className="muted small-14">on {wallet.network}</span>
      </div>
      <div className="give-body">
        <QrCode wallet={wallet} />
        <div className="give-side">
          <span className="lbl">Address</span>
          <code className="give-addr" id={addrId}>
            {wallet.address}
          </code>
          <CopyButton text={wallet.address} label={`${wallet.coin} address`} target={addrId} className="btn h34 give-copy" />
          <p className="small-13 muted">Scan the code or paste the address in any wallet or exchange, then pick the {wallet.network} network.</p>
        </div>
      </div>
      <p className="give-warn" role="note">
        Send only {wallet.coin} on the {wallet.network} network. Another coin, or {wallet.coin} sent on another network, is lost for good.
      </p>
    </div>
  )
}

export function SponsorPage() {
  return (
    <div className="root">
      <SiteHeader onHome={false} />

      <main id="top">
        <section className="sponsor-hero" aria-labelledby="sponsor-h">
          <div className="wrap split">
            <div className="txt">
              <p className="lbl sponsor-lbl">
                <Heart size={13} /> Sponsor
              </p>
              <h1 className="sponsor-h1" id="sponsor-h">
                Help keep ZumiBot going.
              </h1>
              <p className="lede">
                ZumiBot is free, and it stays free. I build it and use it every day. If it saves you time, a sponsorship helps me keep making it
                better.
              </p>
              <ul className="facts">
                <li>Free for everyone to use, change and share. The license only rules out selling it.</li>
                <li>A sponsorship is a gift: it buys no license, support plan or feature.</li>
                <li>Any amount helps, once or every month.</li>
              </ul>
              <p className="sponsor-thanks">
                <Bot zumi size={22} working tilt="b" />
                <span>Thank you, from Mohammed</span>
              </p>
            </div>
            <WalletCard wallet={USDT_TRC20} />
          </div>
        </section>

        <section className="scene sponsor-more" aria-labelledby="help-h">
          <div className="wrap col-20">
            <h2 className="sponsor-h2" id="help-h">
              Other ways to help
            </h2>
            <div className="help-grid">
              <a className="help card" href={GITHUB_URL} rel="noopener noreferrer">
                <span className="tile">
                  <GitHubMark size={17} />
                </span>
                <span className="help-title">Star it on GitHub</span>
                <span className="muted small-14">Stars help other people find ZumiBot.</span>
              </a>
              <a className="help card" href="/">
                <span className="tile">
                  <Glyph name="message" size={17} />
                </span>
                <span className="help-title">Tell someone</span>
                <span className="muted small-14">Know someone who runs Claude Code agents all day? Send them to zumibot.run.</span>
              </a>
              <a className="help card" href={`mailto:${CONTACT_EMAIL}`}>
                <span className="tile">
                  <Glyph name="inbox" size={17} />
                </span>
                <span className="help-title">Report what breaks</span>
                <span className="muted small-14">A clear bug report or a good idea, to {CONTACT_EMAIL}.</span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
