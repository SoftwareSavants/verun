#!/usr/bin/env bash
# Remove .VolumeIcon.icns from a DMG so it doesn't show in Finder.
# Usage: ./scripts/clean-dmg.sh path/to/App.dmg
set -euo pipefail

DMG_PATH="$1"
DMG_DIR="$(dirname "$DMG_PATH")"
DMG_NAME="$(basename "$DMG_PATH")"
DMG_RW="$DMG_DIR/rw_${DMG_NAME}"

echo "Cleaning $DMG_NAME..."

# Convert to read-write
hdiutil convert "$DMG_PATH" -format UDRW -o "$DMG_RW" -quiet

# Mount
DEV_NAME=$(hdiutil attach -mountrandom /tmp -readwrite -noverify -noautoopen -nobrowse "$DMG_RW" \
  | grep -E '^/dev/' | head -1 | awk '{print $1}')
MOUNT_DIR=$(hdiutil info | grep -A1 "$DEV_NAME" | tail -1 | awk '{$1=$2=""; print $0}' | xargs)

# Remove the volume icon file
if [ -f "$MOUNT_DIR/.VolumeIcon.icns" ]; then
  rm "$MOUNT_DIR/.VolumeIcon.icns"
  # Clear the custom icon flag on the volume
  SetFile -a c "$MOUNT_DIR" 2>/dev/null || true
  echo "Removed .VolumeIcon.icns"
else
  echo "No .VolumeIcon.icns found"
fi

# Unmount
hdiutil detach "$DEV_NAME" -quiet

# Convert back to compressed read-only, replacing original
hdiutil convert "$DMG_RW" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" -quiet -ov
rm -f "$DMG_RW"

echo "Done: $DMG_PATH"
