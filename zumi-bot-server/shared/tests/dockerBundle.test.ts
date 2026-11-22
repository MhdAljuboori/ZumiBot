import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DOCKER_BUNDLE,
  DOCKER_BUNDLE_DIR,
  DOCKER_BUNDLE_FILES,
  DOCKER_IMAGE,
  bundleCompose,
  isBundleImage
} from '@zumibot/shared/dockerBundle'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')
const HEX = 'a'.repeat(64)
const ref = `${DOCKER_IMAGE}:1.2.3@sha256:${HEX}`

/** The `build:` block: the line and every following line indented more than two spaces. */
function withoutBuild(lines: string[]): string[] {
  const at = lines.indexOf('  build:')
  let end = at + 1
  while (end < lines.length && /^ {3,}/.test(lines[end]!)) end++
  return [...lines.slice(0, at), ...lines.slice(end)]
}

describe('bundle constants', () => {
  it('names the image, the archive and its files', () => {
    expect(DOCKER_IMAGE).toBe('docker.io/mhdaljuboori/zumibot')
    expect(DOCKER_BUNDLE).toBe('zumibot-docker.tar.gz')
    expect(DOCKER_BUNDLE_DIR).toBe('zumibot-docker')
    expect(DOCKER_BUNDLE_FILES).toEqual([
      'docker-compose.yml',
      'docker/Caddyfile',
      'docker/Caddyfile.local',
      'docker/install.sh',
      '.env.example',
      'VERSION'
    ])
  })
})

describe('isBundleImage', () => {
  it('accepts only this version pinned by a sha256 digest', () => {
    expect(isBundleImage(ref, '1.2.3')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(isBundleImage(ref, '1.2.4')).toBe(false)
    expect(isBundleImage(`${DOCKER_IMAGE}:1.2.3`, '1.2.3')).toBe(false)
    expect(isBundleImage(`${DOCKER_IMAGE}:1.2.3@sha256:${'A'.repeat(64)}`, '1.2.3')).toBe(false)
    expect(isBundleImage(`${DOCKER_IMAGE}:1.2.3@sha256:${'a'.repeat(63)}`, '1.2.3')).toBe(false)
    expect(isBundleImage(`docker.io/other/server:1.2.3@sha256:${HEX}`, '1.2.3')).toBe(false)
    expect(isBundleImage(`${ref}\n`, '1.2.3')).toBe(false)
  })
})

describe('bundleCompose', () => {
  const out = bundleCompose(compose, ref)

  it('drops the build and the tag variable', () => {
    expect(out.split('\n').some((l) => /^\s+build:/.test(l))).toBe(false)
    expect(out).not.toContain('CLAUDE_CODE_VERSION')
    expect(out).not.toContain('zumibot:${ZUMIBOT_IMAGE_TAG')
  })

  it('pins the image once, inside the x-zumibot block', () => {
    const line = `\n  image: ${ref}\n`
    expect(out.split(line)).toHaveLength(2)
    expect(out.indexOf(line)).toBeLessThan(out.indexOf('  restart: unless-stopped'))
    expect(out.indexOf(line)).toBeGreaterThan(out.indexOf('x-zumibot: &zumibot'))
  })

  it("leaves caddy's image alone", () => {
    expect(out).toContain('  image: caddy:2.11-alpine@sha256:')
  })

  it('keeps every other line, in order', () => {
    const rest = withoutBuild(compose.split('\n')).filter((l) => !l.startsWith('  image: zumibot:'))
    const got = out.split('\n').filter((l) => l !== `  image: ${ref}` && !/^\s*#.*digest/i.test(l))
    expect(got).toEqual(rest)
  })

  it('throws on a shape it does not know', () => {
    expect(() => bundleCompose(compose.replace('  build:', '  bld:'), ref)).toThrow()
    expect(() => bundleCompose(`${compose}\n  build:\n    context: .\n`, ref)).toThrow()
    expect(() => bundleCompose(compose.replace('  image: zumibot:', '  image: other:'), ref)).toThrow()
  })
})

describe('docker-bundle.mjs run against a scratch release dir', () => {
  // Windows' own tar (bsdtar), the one a Windows shell finds: Git Bash's GNU tar reads a C: archive path as a remote host.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const env =
    process.platform === 'win32'
      ? { ...process.env, [pathKey]: [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32'), process.env[pathKey]].join(delimiter) }
      : process.env
  // ENOENT is the only error that says the program is missing.
  const haveTar = spawnSync('tar', ['--version'], { stdio: 'ignore', env }).error === undefined
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22
  const gnuTar = haveTar && spawnSync('tar', ['--sort=name', '--help'], { stdio: 'ignore', env }).status === 0
  const script = join(ROOT, 'zumi-bot-server/deploy/docker-bundle.mjs')
  const repo = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
  const serverLine = `${'c'.repeat(64)}  zumibot-server.tar.gz`
  const run = (dir: string, version: string, image: string) =>
    spawnSync('node', ['--experimental-strip-types', '--no-warnings', script, version, image, dir], { encoding: 'utf8', env })
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zumibot-docker-bundle-test-'))
    writeFileSync(join(dir, 'SHA256SUMS'), `${serverLine}\n`)
    return dir
  }
  const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
  const image = `${DOCKER_IMAGE}:9.9.9@sha256:${'b'.repeat(64)}`

  it.skipIf(!haveTar || !nodeOk)('packs the bundle and records its hash', () => {
    const dir = scratch()
    try {
      const r = run(dir, '9.9.9', image)
      expect(r.status, r.stderr + r.stdout).toBe(0)
      const archive = join(dir, DOCKER_BUNDLE)
      const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', env })
        .stdout.split(/\r?\n/)
        .filter((l) => l && !l.endsWith('/'))
        .sort()
      expect(listed).toEqual(DOCKER_BUNDLE_FILES.map((f) => `${DOCKER_BUNDLE_DIR}/${f}`).sort())

      const out = join(dir, 'x')
      mkdirSync(out)
      expect(spawnSync('tar', ['-xzf', archive, '-C', out], { env }).status).toBe(0)
      const packed = (f: string): string => readFileSync(join(out, DOCKER_BUNDLE_DIR, f), 'utf8')
      expect(packed('docker-compose.yml')).toBe(bundleCompose(compose, image))
      expect(packed('docker/install.sh')).toBe(repo('docker/install.sh'))
      expect(packed('docker/Caddyfile')).toBe(repo('docker/Caddyfile'))
      expect(packed('docker/Caddyfile.local')).toBe(repo('docker/Caddyfile.local'))
      expect(packed('.env.example')).toBe(repo('.env.example'))
      expect(packed('VERSION')).toBe('9.9.9\n')

      const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)
      expect(sums).toEqual([serverLine, `${sha(archive)}  ${DOCKER_BUNDLE}`])

      // A second run replaces the bundle line instead of adding one.
      expect(run(dir, '9.9.9', image).status).toBe(0)
      const again = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)
      expect(again.filter((l) => l.endsWith(`  ${DOCKER_BUNDLE}`))).toHaveLength(1)
      expect(again[0]).toBe(serverLine)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!gnuTar || !nodeOk)('packs the same bytes every time', () => {
    const dir = scratch()
    try {
      expect(run(dir, '9.9.9', image).status).toBe(0)
      const first = sha(join(dir, DOCKER_BUNDLE))
      expect(run(dir, '9.9.9', image).status).toBe(0)
      expect(sha(join(dir, DOCKER_BUNDLE))).toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!haveTar || !nodeOk)('refuses a wrong version, a ref without a digest and a version that is not x.y.z', () => {
    for (const [version, ref] of [
      ['9.9.9', `${DOCKER_IMAGE}:1.0.0@sha256:${'b'.repeat(64)}`],
      ['9.9.9', `${DOCKER_IMAGE}:9.9.9`],
      ['9.9', `${DOCKER_IMAGE}:9.9@sha256:${'b'.repeat(64)}`]
    ] as const) {
      const dir = scratch()
      try {
        const r = run(dir, version, ref)
        expect(r.status, `${version} ${ref}`).not.toBe(0)
        expect(existsSync(join(dir, DOCKER_BUNDLE))).toBe(false)
        expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe(`${serverLine}\n`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
