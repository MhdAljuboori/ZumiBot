import { Heart } from '../Chrome.tsx'
import { SPONSOR_PATH } from '../siteLinks.ts'

/**
 * The ask at the end of the page, after the server scene. Not a numbered scene: it has no `data-scene`, so the header
 * cast keeps following the last one.
 */
export function SponsorBand() {
  return (
    <section id="sponsor" className="scene band sponsor-band" aria-labelledby="sponsor-band-h">
      <div className="wrap sponsor-band-in">
        <div className="txt">
          <p className="lbl">Free, and it stays free</p>
          <h2 className="sponsor-h2" id="sponsor-band-h">
            If ZumiBot saves you time, help keep it going.
          </h2>
        </div>
        <a className="btn big sponsor-band-btn" href={SPONSOR_PATH}>
          <Heart size={18} />
          Sponsor ZumiBot
        </a>
      </div>
    </section>
  )
}
