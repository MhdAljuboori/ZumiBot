# zumi-bot-docs

Before changing pages or config here, read `docs/architecture/user-docs.md` (repo-root path; it covers how the site builds, the writing rules and the leak list).

Quick rules for this folder:

- Public end-user docs for `https://docs.zumibot.run`, an Astro Starlight site. Pages are written for people who use ZumiBot: no file names, internal paths, development-only settings or links into the repo or its releases. The repo's home page (`https://github.com/MhdAljuboori/ZumiBot`) and `contact@zumibot.run` are the exceptions: the header icons, the FAQ's Contact section and Troubleshooting.
- A change that alters what users see updates its page here in the same change.
- A new page needs nothing for search engines: Starlight lists every page in `sitemap-index.xml` itself (it needs `site` in `astro.config.mjs`), and `public/robots.txt` points crawlers to it. Never hand-write a sitemap. Details: "Search engines" in the user-docs doc.
- Run Astro with Node 22.23.4 or newer (`engines.node` is `22.x`, which Vercel reads).
