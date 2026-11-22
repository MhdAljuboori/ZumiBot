; electron-builder includes build/installer.nsh in the NSIS script on its own.

; Always install for the current user and skip the "Only for me / Anyone using this computer" page. The installer
; only replaces an old version installed the same way, so picking a different answer on an update left two installs
; and two desktop shortcuts. Installer only: the uninstaller must still find an older per-machine install.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend
