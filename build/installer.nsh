; Included by electron-builder (package.json build.nsis.include).
; On uninstall, but not when an update replaces the app, run Claude Pet once with --remove-hooks. It takes its hooks
; out of Claude Code's settings and removes its startup entry, which the standard uninstaller would leave behind.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing Claude Pet's Claude Code hooks"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-hooks' $0
    ${if} $0 != 0
      DetailPrint "Claude Pet could not remove its hooks (exit code $0). Details are in claude-pet.log in %APPDATA%\claude-pet."
    ${endIf}
  ${endIf}
!macroend
