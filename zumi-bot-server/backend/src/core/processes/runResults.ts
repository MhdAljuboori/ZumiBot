import { runResultText, type RunMark } from '@zumibot/shared/runBlocks'
import type { RunEndEvent } from './processService'

export interface RunResultsDeps {
  /** Posts the hidden result message through the chat's task queue as `'run'`: its claim, queue, pause hold and limit wait. */
  submit(chatId: string, text: string, run: RunMark): Promise<unknown>
  /** null once the chat is gone. */
  chat(chatId: string): Promise<{ archived: boolean; room: boolean } | null>
}

/**
 * The agent's copy of a Run's end (docs/architecture/run-blocks.md): the block's author gets the command and the output tail in a
 * hidden message. A closed chat gets nothing, and a failure only logs a code, never the command or its output.
 */
export class RunResults {
  constructor(private readonly d: RunResultsDeps) {}

  ended(e: RunEndEvent): void {
    if (e.end === null) return
    const end = e.end
    void this.send(e, end).catch((err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code
      console.error('run result failed:', typeof code === 'string' ? code : 'error')
    })
  }

  private async send(e: RunEndEvent, end: NonNullable<RunEndEvent['end']>): Promise<void> {
    const chat = await this.d.chat(e.chatId)
    if (!chat || chat.archived) return
    // In a room the result names its author, or the moderator could pick anyone to read it.
    const text = runResultText({ command: e.command, output: e.output, cut: e.cut, end, mention: chat.room ? e.agent : undefined })
    // Not awaited past this point by `ended`: a single chat's submit settles at its turn's end.
    await this.d.submit(e.chatId, text, { processId: e.id })
  }
}
