/** One sidebar group: its label and the folder under `src/content/docs` it lists. Order here is the order shown. */
export interface SidebarGroup {
  label: string
  directory: string
}

export const SIDEBAR: SidebarGroup[] = [
  { label: 'Get started', directory: 'get-started' },
  { label: 'Chatting', directory: 'chatting' },
  { label: 'Agents', directory: 'agents' },
  { label: 'Group rooms', directory: 'rooms' },
  { label: 'Projects & code', directory: 'projects' },
  { label: 'Automation', directory: 'automation' },
  { label: 'Voice', directory: 'voice' },
  { label: 'Connect', directory: 'connect' },
  { label: 'Agents at the computer', directory: 'computer' },
  { label: 'Safety & cost', directory: 'safety' },
  { label: 'Advanced engines', directory: 'engines' },
  { label: 'Desktop app', directory: 'desktop' },
  { label: 'Run your server', directory: 'server' }
]
