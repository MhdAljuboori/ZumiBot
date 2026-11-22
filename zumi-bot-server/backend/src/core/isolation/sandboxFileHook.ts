import { decodeRoots, runFileGuard } from './fileGuard'

// Child entry of a sandboxed run's PreToolUse hook on the file tools. Exit 2 blocks the call and the CLI shows stderr to the agent.
delete process.env.ELECTRON_RUN_AS_NODE
runFileGuard({ stdin: process.stdin, stderr: process.stderr, exit: (code) => process.exit(code), roots: decodeRoots(process.argv[2]) })
