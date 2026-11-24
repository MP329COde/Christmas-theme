; Hooks NSIS personnalisés — Décoration de Noël

!macro NSIS_HOOK_PREINSTALL
  ; Ferme une instance en cours pour permettre la mise à jour des fichiers.
  nsExec::Exec 'taskkill /F /IM christmas-theme.exe'
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM christmas-theme.exe'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Retire l'entrée de démarrage automatique si l'utilisateur l'avait activée.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
!macroend
