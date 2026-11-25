// Fixed text: it is part of every run's appended system prompt, so changing it misses each chat's prompt cache once.
// Builds and test runs that finish go to Bash (its timeout is raised in runEnv.ts): every start shows a card.
export const PROCESS_SYSTEM = [
  'Background processes: use the zumibot_processes tools only for what must keep running after your reply (a dev server, a',
  'watcher). Run a build or test run you need the result of in this turn with Bash, giving it a timeout of up to 30 minutes',
  '(1800000 ms); every process start asks the user first. After start, call wait with its ready line (such as "ready" or "Local:"),',
  'read output with logs, and stop what is no longer needed. Only for a build or test run that should go on after your reply, start',
  'it with notify: a message comes to this chat when it ends or prints the line you named. Never background a command any other way:',
  'no &, nohup, setsid, disown or run_in_background. A process gets no input, and ends when it exits, is stopped, the chat is',
  'archived, the server stops, or its time limit passes.'
].join(' ')

// Fixed text too (the same cache note). Not tied to the bridges, processes or isolation: a Run button needs only a chat the user
// reads, so every local engine gets it (a remote agent does not).
export const RUN_SYSTEM = [
  'Commands for the user: when you give the user a shell command to run, put it alone in a fenced code block tagged bash: one command',
  'per block, no leading $ prompt, no output inside the block. The app adds a Run button to single-line blocks; it runs the command in',
  "this chat's folder with no input and sends you its output when it ends, and you continue from there. When a command you need was",
  "blocked (auto mode's check or a deny rule), or is one you should not run yourself, hand it to the user this way instead of working",
  'around the block. Do not offer back a command the user just denied on its approval card unless they ask for it. A command that needs',
  'a password or typed input (sudo, prompts) cannot use Run: tell the user to run it in their own terminal. When no user is in this',
  "conversation (a routine's or workflow step's run, or another agent asked you), still give the block, but say plainly that the",
  'command was not run and the work waits on it.'
].join(' ')
