import { useSyncExternalStore } from 'react'
import type { DirListing } from '@zumibot/shared/types'
import { rpc } from '../api'
import { pickerHost } from '../net/folderPickerHost'
import { FolderPicker } from './FolderPicker'

const list = (path: string | null): Promise<DirListing> => rpc.call('fs:listDirs', [path]) as Promise<DirListing>
const makeDir = (parent: string, name: string): Promise<string> => rpc.call('fs:makeDir', [parent, name]) as Promise<string>

/** Mounted once by App: shows the picker whenever api.app.pickFolder asks for one. */
export function FolderPickerHost() {
  const req = useSyncExternalStore(pickerHost.subscribe, pickerHost.get)
  if (!req) return null
  return <FolderPicker key={req.start} start={req.start} list={list} makeDir={makeDir} onResolve={req.resolve} />
}
