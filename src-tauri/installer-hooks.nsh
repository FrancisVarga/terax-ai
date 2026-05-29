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

  ; Desktop shortcut (current-user). Tauri NSIS makes the Start Menu item; this adds the desktop icon.
  CreateShortcut "$DESKTOP\Terax-Camelot.lnk" "$INSTDIR\terax.exe" "" "$INSTDIR\terax.exe" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCamelot"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCamelot"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInCamelot"

  Delete "$DESKTOP\Terax-Camelot.lnk"
!macroend
