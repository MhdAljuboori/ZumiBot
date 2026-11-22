# isolation — docs

Before changing code here, read `docs/architecture/governance.md` (repo-root path), Part 2 (2.3 Sandboxed, 2.4 Container). After a Claude Code update, run
`npm run probe:sandbox`: it checks the CLI facts this folder rests on against the real CLI.
The container image is `zumi-bot-server/container/Dockerfile` (`npm run container:image`); its tag is `AGENT_IMAGE` in
`containerSupport.ts`, raised with every Dockerfile change.
