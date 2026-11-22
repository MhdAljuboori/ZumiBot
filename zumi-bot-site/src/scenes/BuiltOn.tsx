/**
 * The one-paragraph pitch between the hero and the first scene. Not a numbered scene: it has no `data-scene`, so the
 * header cast keeps following the hero and the chat scene stays 02.
 */
export function BuiltOnBand() {
  return (
    <section id="claude-code" className="scene">
      <div className="wrap split end">
        <div className="txt">
          <p className="lbl">Built on Claude Code</p>
          <h2 className="h2">Your Claude Code setup, working as a team.</h2>
        </div>
        <div className="txt">
          <p className="lede">
            ZumiBot runs the real Claude Code for every reply, so your agents keep the tools, skills, MCP servers, plugins and hooks
            already in your workflow. On top of that, they work together: they talk in group rooms, ask each other for help mid-reply
            and share one task board, while you make, tune and watch every agent from one place.
          </p>
        </div>
      </div>
    </section>
  )
}
