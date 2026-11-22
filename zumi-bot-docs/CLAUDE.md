# zumi-bot-docs

Before changing pages or config here, read `docs/architecture/user-docs.md` (repo-root path; it covers how the site builds, the writing rules and the leak list).

Quick rules for this folder:

- Public end-user docs for `https://docs.zumibot.run`, an Astro Starlight site. Pages are written for people who use ZumiBot: no file names, internal paths, development-only settings or links into the repo or its releases. The repo's home page (`https://github.com/MhdAljuboori/ZumiBot`) and `contact@zumibot.run` are the exceptions: the header icons, the FAQ's Contact section and Troubleshooting.
- A change that alters what users see updates its page here in the same change.
- Run Astro with Node 22.23.4 or newer (`engines.node` is `22.x`, which Vercel reads).
