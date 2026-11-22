// `npm run container:image`: builds the agent image with rootless Podman. The tag must match AGENT_IMAGE in
// backend/src/core/isolation/containerSupport.ts (a test checks it).
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
export const TAG = 'localhost/zumibot-agent:1'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = spawnSync('podman', ['build', '-t', TAG, dirname(fileURLToPath(import.meta.url))], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
