/** A voice chat's title: the day it started, in the user's zone (`Voice · Nov 13`). */
export function voiceChatTitle(now: number, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(now)
  return `Voice · ${day}`
}
