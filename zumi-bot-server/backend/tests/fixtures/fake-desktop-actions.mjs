// The desktop action tools whose ask rules the fake desktop claude expects in `--settings`. Kept apart from
// DESKTOP_ACTION_TOOLS on purpose, so the e2e checks the app against its own list; a unit test pins the two together.
export const DESKTOP_ACTIONS = ['desktop_click', 'desktop_drag', 'desktop_scroll', 'desktop_move', 'desktop_type', 'desktop_key', 'desktop_launch', 'desktop_focus']
// The ask rule every main run's one `--settings` carries beside them, computer use or not (PROCESS_START_TOOL, pinned the same way).
export const PROCESS_START = 'mcp__zumibot_processes__start'
