# engines — docs

Before changing code here, read `docs/architecture/engines.md` (repo-root path).

A turn's session and action are the shared part (`engine.ts`); each engine's own configuration stays in its adapter. Before
changing how a start point becomes a resume or a fork, read `docs/architecture/edit-resend-fork.md` too, and for the Codex
adapter's thread and hooks, `docs/architecture/codex.md`.
