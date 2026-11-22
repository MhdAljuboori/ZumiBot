#!/usr/bin/env node
// Fake `cua-driver mcp` (stdio MCP server) for desktop tests. Results follow the shapes recorded by
// the spike (docs/superpowers/verification/2026-11-04-computer-use-spike.md, sections 3-6): PNG
// screenshots with structuredContent, integer window ids, `s<8 hex>:<n>` element tokens, and
// errors as isError plus structuredContent.code. Input only lands in desktop scope, as on Xvnc.
//
// Env:
//   FAKE_CUA_LOG    JSON lines: {type:'env', keys, values} at start, then {tool, args} per call
//   FAKE_CUA_NOISE  write a non-JSON line and a non-JSON-RPC line before every response
//   FAKE_CUA_SILENT never answer (to test start timeouts and aborts)
//   FAKE_CUA_EXIT   exit with this code at start
//   FAKE_CUA_STUCK_ONCE  a flag file: the first start (no flag yet) creates it, leaves a folder the
//                   desktop cannot delete in $XDG_RUNTIME_DIR/stuck (mode 0500) and exits 3
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--version') { process.stdout.write('cua-driver 0.38.0-fake\n'); process.exit(0) }
if (process.argv[2] !== 'mcp') { process.stderr.write('fake cua-driver: only `mcp` and `--version`\n'); process.exit(2) }
if (process.env.FAKE_CUA_EXIT) process.exit(Number(process.env.FAKE_CUA_EXIT))
if (process.env.FAKE_CUA_STUCK_ONCE && !existsSync(process.env.FAKE_CUA_STUCK_ONCE)) {
  writeFileSync(process.env.FAKE_CUA_STUCK_ONCE, '')
  const stuck = join(process.env.XDG_RUNTIME_DIR, 'stuck')
  mkdirSync(stuck)
  writeFileSync(join(stuck, 'file'), '')
  chmodSync(stuck, 0o500)
  process.exit(3)
}

const log = (entry) => { if (process.env.FAKE_CUA_LOG) appendFileSync(process.env.FAKE_CUA_LOG, JSON.stringify(entry) + '\n') }
const shown = /^(CUA_|DO_NOT_TRACK$|DISPLAY$|XAUTHORITY$|HOME$|XDG_|DBUS_|GIO_|GVFS_|LANG$)/
log({ type: 'env', keys: Object.keys(process.env), values: Object.fromEntries(Object.entries(process.env).filter(([k]) => shown.test(k))) })

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
const W = 1280, H = 800
const apps = []
const mousepad = () => ({ app_name: 'Mousepad', bounds: { height: 480, width: 640, x: 5, y: 56 }, height: 480, is_on_screen: true, pid: apps[0] ?? 4242,
  title: 'Untitled 1 - Mousepad', width: 640, window_id: 37748739, x: 5, y: 56, z_index: 3 })
const panel = { app_name: 'Xfce4-panel', bounds: { height: 3, width: 3, x: -9999, y: -9999 }, height: 3, is_on_screen: true, pid: 4100,
  title: 'xfce4-panel', width: 3, window_id: 16777223, x: -9999, y: -9999, z_index: 1 }
const windows = () => [mousepad(), panel]
let snapshot = 0
const token = /^s[0-9a-f]{8}:[0-9]+$/

const ok = (text, structuredContent) => ({ content: [{ type: 'text', text }], structuredContent })
const fail = (code, text) => ({ content: [{ type: 'text', text }], structuredContent: { code }, isError: true })
const desktopScope = (a) => a.scope === 'desktop' || a.target?.kind === 'desktop'
const action = (route, summary) => ok(`✅ ${summary}`, { delivery: { mode: route === 'global_input' ? 'not_applicable' : 'background' }, effect: 'unverifiable', route, summary })
const xtestOnly = (name, a, summary) => desktopScope(a) || a.delivery_mode === 'foreground'
  ? action('global_input', summary)
  : fail('background_unavailable', `${name}: background delivery is unavailable on this display.`)

const tools = {
  get_desktop_state(a) {
    const max = Number(a.max_image_dimension) || 0
    const scale = max > 0 && max < W ? W / max : 1
    const sw = Math.round(W / scale), sh = Math.round(H / scale)
    return { content: [{ type: 'image', mimeType: 'image/png', data: PNG }, { type: 'text', text: `✅ Desktop screenshot ${sw}x${sh} (screen ${W}x${H})` }],
      structuredContent: { capture_id: `capture_${'0'.repeat(32)}_${'0'.repeat(16)}`, display: 'primary', frame_scale: scale, platform: 'linux', scale_factor: 1,
        screen_width: W, screen_height: H, screenshot_width: sw, screenshot_height: sh, screenshot_mime_type: 'image/png', windows: windows() } }
  },
  get_screen_size: () => ok(`${W}x${H}`, { width: W, height: H, scale_factor: 1 }),
  list_windows: () => ok(`Found 2 windows:\n${windows().map(w => `  window_id=${w.window_id} pid=${w.pid} "${w.title}" ${w.width}x${w.height}+${w.x}+${w.y} app=${w.app_name}`).join('\n')}`, { windows: windows() }),
  get_window_state(a) {
    if (!Number.isInteger(a.pid) || !Number.isInteger(a.window_id)) return fail('invalid_arguments', 'pid and window_id are required')
    const id = `s${(++snapshot).toString(16).padStart(8, '0')}`
    const elements = [
      { actions: ['click'], depth: 4, element_index: 0, element_token: `${id}:0`, enabled: true, frame: { h: 27, w: 39, x: 5, y: 56 }, label: 'File', role: 'menu', screenshot_frame: { h: 27, w: 39, x: 0, y: 0 } },
      { depth: 5, element_index: 17, element_token: `${id}:17`, enabled: true, frame: { h: 447, w: 638, x: 6, y: 86 }, role: 'text', screenshot_frame: { h: 447, w: 638, x: 1, y: 30 }, unlabelled: true, value: '' }
    ]
    const content = [{ type: 'text', text: `window_id=${a.window_id} pid=${a.pid} elements=2 snapshot_id=${id}` }]
    if (a.include_screenshot !== false) content.push({ type: 'image', mimeType: 'image/png', data: PNG })
    return { content, structuredContent: { snapshot_id: id, window_id: a.window_id, pid: a.pid, coordinate_frame: 'window', element_count: 2, elements, tree_format: a.tree_format ?? 'markdown',
      window_bounds: mousepad().bounds, window_title: 'Untitled 1 - Mousepad', screenshot_mime_type: 'image/png' } }
  },
  list_apps: () => ok('Apps: Mousepad', { apps: [
    { active: false, bundle_id: 'org.xfce.mousepad', kind: 'desktop', last_used: null, launch_path: 'mousepad', name: 'Mousepad', pid: 0, running: apps.length > 0, windows: [] },
    { active: false, bundle_id: null, kind: 'process', last_used: null, launch_path: null, name: 'systemd', pid: 1, running: true, windows: [] }
  ], processes: [{ name: 'systemd', pid: 1 }] }),
  launch_app(a) {
    if (!a.name && !a.launch_path) return fail('invalid_arguments', 'name or launch_path is required')
    // A launched app is a child of cua-driver, in its process group, like the real one.
    const child = spawn('sleep', ['600'], { stdio: 'ignore' })
    apps.unshift(child.pid)
    return ok(`✅ Launched ${a.name ?? a.launch_path} (pid ${child.pid}) in background.`, { active: false, bundle_id: null, launcher_pid: process.pid, name: a.name ?? a.launch_path, pid: child.pid, running: true, windows: [mousepad()] })
  },
  click(a) {
    if (a.element_token !== undefined) {
      if (!token.test(a.element_token)) return fail('invalid_element_token', 'element_token is malformed')
      return a.delivery_mode === 'foreground' ? action('global_input', 'Clicked element') : action('accessibility', 'Clicked element')
    }
    return xtestOnly('click', a, `Sent screen-absolute click at (${a.x},${a.y}) (desktop scope).`)
  },
  double_click: (a) => desktopScope(a) ? fail('invalid_action_target', 'double_click does not accept a per-call target') : xtestOnly('double_click', a, 'Double clicked'),
  right_click: (a) => desktopScope(a) ? fail('invalid_action_target', 'right_click does not accept a per-call target') : xtestOnly('right_click', a, 'Right clicked'),
  drag: (a) => xtestOnly('drag', a, `Dragged from (${a.from_x},${a.from_y}) to (${a.to_x},${a.to_y}).`),
  scroll: (a) => xtestOnly('scroll', a, `Scrolled ${a.direction} ${a.amount ?? 3}.`),
  move_cursor: (a) => desktopScope(a) ? action('global_input', `Moved the pointer to (${a.x},${a.y}).`) : action('overlay', 'Moved the agent cursor overlay.'),
  type_text: (a) => xtestOnly('type_text', a, `Typed ${[...String(a.text ?? '')].length} character(s).`),
  press_key: (a) => xtestOnly('press_key', a, `Pressed ${a.key}.`),
  hotkey: (a) => Array.isArray(a.keys) && a.keys.length >= 2 ? xtestOnly('hotkey', a, `Pressed ${a.keys.join('+')}.`) : fail('invalid_arguments', 'keys needs at least 2 items'),
  bring_to_front: (a) => Number.isInteger(a.pid) ? ok('Brought to front.', { platform: 'linux', prior_active: null, window_id: a.window_id }) : fail('invalid_arguments', 'pid is required'),
  zoom(a) {
    if (!Number.isInteger(a.window_id)) return fail('invalid_arguments', 'window_id is required')
    return { content: [{ type: 'image', mimeType: 'image/jpeg', data: JPEG }, { type: 'text', text: `Zoom (${a.x1},${a.y1})–(${a.x2},${a.y2}) → 500×47 px JPEG.` }],
      structuredContent: { format: 'jpeg', mime_type: 'image/jpeg', width: 500, height: 47 } }
  },
  check_permissions: () => ok('X11 DISPLAY set; org.a11y.Bus reachable', { ok: true })
}

const send = (msg) => {
  if (process.env.FAKE_CUA_NOISE) process.stdout.write('SpiRegistry daemon is running with well-known name - org.a11y.atspi.Registry\n{"not":"json-rpc"}\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (process.env.FAKE_CUA_SILENT) return
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined || m.id === null) return
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cua-driver', version: '0.38.0-fake' } } })
    case 'ping':
      return send({ id: m.id, result: {} })
    case 'tools/list':
      return send({ id: m.id, result: { tools: Object.keys(tools).map(name => ({ name, description: name, inputSchema: { type: 'object' } })) } })
    case 'tools/call': {
      const name = m.params?.name, args = m.params?.arguments ?? {}
      log({ tool: name, args })
      const tool = tools[name]
      return send({ id: m.id, result: tool ? tool(args) : fail('unknown_tool', `Unknown tool ${name}`) })
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
})
// The real cua-driver exits on stdin EOF.
rl.on('close', () => process.exit(0))
