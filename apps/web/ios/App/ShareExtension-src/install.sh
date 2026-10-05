#!/bin/sh
# After adding the "ShareExtension" target in Xcode (see README › Share to
# ReconNotes), run this to put ReconNotes' share-extension code in place of
# Xcode's template.
set -e
cd "$(dirname "$0")"
DEST=../ShareExtension
if [ ! -d "$DEST" ]; then
  echo "No ios/App/ShareExtension folder yet – first add the target in Xcode: File › New › Target… › Share Extension, named ShareExtension."
  exit 1
fi
cp ShareViewController.swift "$DEST/ShareViewController.swift"
cp Info.plist "$DEST/Info.plist"
echo "Done. Now add the App Group to both targets in Xcode (README › Share to ReconNotes) and build."
