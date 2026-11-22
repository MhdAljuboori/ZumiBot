import { main } from './cli'
import { hideChildWindows } from './windowsHide'

hideChildWindows()
// Always runs: the entry is reached through symlinks (the deploy bin script), so no "am I the entry" check.
main()
