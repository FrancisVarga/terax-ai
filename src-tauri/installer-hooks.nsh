; "Open in Camelot" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCamelot" "" "Open in Camelot"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCamelot" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCamelot" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCamelot\command" "" '"$INSTDIR\terax.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCamelot" "" "Open in Camelot"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCamelot" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCamelot" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCamelot\command" "" '"$INSTDIR\terax.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCamelot" "" "Open in Camelot"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCamelot" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCamelot" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCamelot\command" "" '"$INSTDIR\terax.exe" "%V"'

  ; "Open with Terax Camelot" for any file (`*`). %1 = clicked file path; the
  ; app cd's into the file's parent dir and opens the file in the editor.
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithCamelot" "" "Open with Terax Camelot"
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithCamelot" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithCamelot" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithCamelot\command" "" '"$INSTDIR\terax.exe" "%1"'

  ; Desktop shortcut (current-user). Tauri NSIS makes the Start Menu item; this adds the desktop icon.
  CreateShortcut "$DESKTOP\Terax-Camelot.lnk" "$INSTDIR\terax.exe" "" "$INSTDIR\terax.exe" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCamelot"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCamelot"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInCamelot"
  DeleteRegKey HKCU "Software\Classes\*\shell\OpenWithCamelot"

  Delete "$DESKTOP\Terax-Camelot.lnk"
!macroend
