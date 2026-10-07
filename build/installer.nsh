!macro customInstall
  ; Only an installed NSIS build participates in automatic updates.
  FileOpen $0 "$INSTDIR\resources\installed.txt" w
  FileWrite $0 "nsis"
  FileClose $0
!macroend
