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
