; Each resumed session's tab runs hangar-resume.exe for as long as the session lasts, and Windows won't overwrite an
; exe that is running: an update with sessions open would keep the old helper without a word. A running exe can be
; renamed, though, so the installed one steps aside first, under a name of its own, and the new one takes its place.
; The ones left aside go once nothing runs them: on the next install, or on uninstall.
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\hangar-resume.old*.exe"
  IfFileExists "$INSTDIR\hangar-resume.exe" 0 hangar_resume_done
    Push $0
    System::Call "kernel32::GetTickCount() i .r0"
    Rename "$INSTDIR\hangar-resume.exe" "$INSTDIR\hangar-resume.old-$0.exe"
    Pop $0
  hangar_resume_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\hangar-resume.old*.exe"
!macroend
