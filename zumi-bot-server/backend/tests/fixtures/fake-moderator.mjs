#!/usr/bin/env node
// Fake moderator: drains stdin, then prints FAKE_MODERATOR_OUT or hangs.
// FAKE_MODERATOR_SPLIT=1 writes the output as separate chunks cut inside the first multi-byte character.
// FAKE_MODERATOR_EXIT sets the exit code (default 0), like the real CLI exiting non-zero on an error result.
if (process.env.FAKE_MODERATOR_HANG) {
  process.stdin.resume()
  setInterval(() => {}, 1000)
} else {
  process.stdin.resume()
  process.stdin.on('end', () => {
    const out = process.env.FAKE_MODERATOR_OUT ?? '{}'
    process.exitCode = Number(process.env.FAKE_MODERATOR_EXIT ?? 0)
    if (!process.env.FAKE_MODERATOR_SPLIT) return void process.stdout.write(out)
    const buf = Buffer.from(out)
    const lead = buf.findIndex((b) => b >= 0xc0)
    const cut = lead < 0 ? Math.floor(buf.length / 2) : lead + 1
    process.stdout.write(buf.subarray(0, cut))
    setTimeout(() => process.stdout.write(buf.subarray(cut)), 50)
  })
}
