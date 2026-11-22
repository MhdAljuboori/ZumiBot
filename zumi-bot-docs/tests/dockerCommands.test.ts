import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The Docker steps copy what the Docker installer prints and what the compose file names, so a change there must
// show up in the pages. Those files are the source of truth: the folder, the two services, the rollback line, the
// volumes and where the container mounts them.
const ROOT = join(import.meta.dirname, '../..')
const DOCS = join(import.meta.dirname, '../src/content/docs')
const read = (path: string) => readFileSync(path, 'utf8')
const script = read(join(ROOT, 'docker/install.sh'))
const compose = read(join(ROOT, 'docker-compose.yml'))
const caddyLocal = read(join(ROOT, 'docker/Caddyfile.local'))
const installPage = read(join(DOCS, 'get-started/install-server.mdx'))
const updatesPage = read(join(DOCS, 'server/updates.mdx'))
const backupsPage = read(join(DOCS, 'server/data-and-backups.mdx'))
const DIR = '~/zumibot-docker'
const GO_BACK = 'mv $DIR $DIR.failed && mv $DIR.prev $DIR && cd $DIR && docker compose up -d'

describe('Docker installer facts the pages rely on', () => {
  it('uses the folder and services the pages name', () => {
    expect(script).toContain('DIR=${ZUMIBOT_DOCKER_DIR:-$HOME/zumibot-docker}')
    expect(script).toContain('domain) SVC=zumibot ;;')
    expect(script).toContain('local) SVC=zumibot-local ;;')
    expect(script).toContain('cd $DIR && docker compose logs $SVC')
    expect(script).toContain('cd $DIR && docker compose exec $SVC claude')
    expect(script).toContain('sh $DIR/docker/install.sh')
    expect(script).toContain(GO_BACK)
  })

  it('names the volumes and mounts the backup steps use', () => {
    // Volumes are named <project>_<volume>, so the project name is part of every volume name on the pages.
    expect(compose).toMatch(/^name: zumibot$/m)
    for (const mount of ['data:/data', 'claude:/home/zumibot/.claude', 'vault:/vault']) expect(compose).toContain(`- ${mount}`)
    for (const volume of ['data', 'claude', 'vault', 'caddy-data', 'caddy-config']) expect(compose).toMatch(new RegExp(`^  ${volume}:$`, 'm'))
  })
})

describe('install page, Docker tab', () => {
  it('shows the commands the installer prints', () => {
    // [what the page shows, what the installer says]
    const pairs = [
      ['curl -fsSL https://zumibot.run/releases/latest/docker/install.sh -o install.sh', 'curl -fsSL https://zumibot.run/releases/latest/docker/install.sh -o install.sh'],
      ['sh install.sh --origin https://mac.tail1234.ts.net:8443', 'such as https://mac.tail1234.ts.net:8443'],
      ['tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443', 'tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443'],
      ['ssh -L 8443:127.0.0.1:8443', 'ssh -L 8443:127.0.0.1:8443'],
      ['sh install.sh --domain zumibot.example.com', 'sh install.sh --domain zumibot.example.com']
    ]
    for (const [shown, said] of pairs) {
      expect(script, said).toContain(said)
      expect(installPage, shown).toContain(shown)
    }
    for (const svc of ['zumibot-local', 'zumibot']) expect(installPage).toContain(`cd ${DIR} && docker compose logs ${svc}`)
    expect(installPage).toContain(`cd ${DIR} && docker compose exec zumibot-local claude`)
    expect(installPage).toContain(`sh ${DIR}/docker/install.sh`)
    expect(installPage).toContain(GO_BACK.replaceAll('$DIR', DIR))
  })

  it("shows the local CA's copy command from the local Caddyfile", () => {
    const copy = 'docker compose cp caddy-local:/data/caddy/pki/authorities/local/root.crt ./zumibot-local-ca.crt'
    expect(caddyLocal).toContain(copy)
    expect(installPage).toContain(copy)
  })
})

describe('update page, Docker section', () => {
  it('updates and goes back the way the installer does', () => {
    expect(updatesPage).toContain(`sh ${DIR}/docker/install.sh`)
    expect(updatesPage).toContain(GO_BACK.replaceAll('$DIR', DIR))
    for (const svc of ['zumibot-local', 'zumibot']) expect(updatesPage).toContain(`cd ${DIR} && docker compose logs ${svc}`)
  })
})

describe('backups page, Docker section', () => {
  it('names the volumes compose makes and the paths it mounts', () => {
    for (const volume of ['zumibot_data', 'zumibot_claude', 'zumibot_vault', 'zumibot_caddy-data', 'zumibot_caddy-config']) {
      expect(backupsPage).toContain(volume)
    }
    expect(backupsPage).toContain('docker volume rm zumibot_data zumibot_claude zumibot_vault')
    for (const path of ['-C /data .', '-C /home/zumibot/.claude .', 'cat /vault/vault.key', '-C /data <', '-C /home/zumibot/.claude <', 'cat > /vault/vault.key']) {
      expect(backupsPage, path).toContain(path)
    }
  })
})
