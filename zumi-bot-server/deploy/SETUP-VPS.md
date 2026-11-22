# VPS setup

The server is installed by `install.sh` as a systemd user service, with no sudo for the app itself. Follow the
installer's steps in `docs/architecture/install.md` (Phase 3), then do the proxy below. That step needs root, so
the installer never does it for you.

1. **(you)** DNS: an `A` record (and `AAAA` if the VPS has IPv6) for your host, such as `zumibot-server.example.com`, pointing at the VPS.
2. Run `install.sh --origin https://<your host>` as a plain user. It writes `<dir>/proxy/Caddyfile` and `<dir>/proxy/nginx-zumibot.conf` with your host already filled in (`<dir>` is `~/zumibot` by default).
3. Open ports 80 and 443 (allow SSH first): `sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable`.
4. Put the proxy in front of `127.0.0.1:4317`. If `systemctl is-active nginx` prints `active`, use nginx, otherwise Caddy.
   - nginx + certbot:
     ```sh
     sudo cp ~/zumibot/proxy/nginx-zumibot.conf /etc/nginx/sites-available/zumibot
     sudo ln -s /etc/nginx/sites-available/zumibot /etc/nginx/sites-enabled/
     sudo nginx -t && sudo systemctl reload nginx
     sudo apt-get install -y certbot python3-certbot-nginx
     sudo certbot --nginx --redirect -d <your host>   # adds the TLS lines
     ```
   - Caddy (gets certificates itself). Install it from the [official apt repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian), then add the site as its own file so existing sites stay:
     ```sh
     sudo cp ~/zumibot/proxy/Caddyfile /etc/caddy/zumibot.caddy
     grep -qx 'import zumibot.caddy' /etc/caddy/Caddyfile || printf '\nimport zumibot.caddy\n' | sudo tee -a /etc/caddy/Caddyfile
     sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
     ```
5. Open `https://<your host>/setup` and paste the one-time code from `journalctl --user -u zumibot -n 20`.

Optional extras (the sections at the end of each doc): [computer use](../../docs/architecture/computer-use.md), [Codex](../../docs/architecture/codex.md), [the vault key backup](../../docs/architecture/vault.md) and [the agent browser](../../docs/architecture/browser.md). Then clone the repos your agents work in, as the server user, and set up the MCP servers, skills and plugins they need. A group run starts several `claude` processes at once, so check `free -m`: under 2 GB, add swap.

Updates ship as a release: the in-app **Update**, or `~/zumibot/bin/zumibot-update`. Both download from the showcase site with no token. To copy your chats and
agents between your PC and the VPS, use `npm run sync` (it restarts the server with `systemctl --user restart zumibot`).
