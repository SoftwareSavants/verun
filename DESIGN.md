# Verun interface

## Existing visual system
Use the application's current theme and UnoCSS tokens: surface-0 through surface-3, text-primary, text-secondary, text-muted, text-dim, accent, and semantic status colors. Respect light and dark theme selection. Keep the existing system typography and compact control scale.

## Components and layout
Use the shared Select with compact sizing, existing buttons, and lucide-solid icons. Use ring utilities for container outlines. Preserve the project sidebar while showing the board in the main content area. Board columns scroll vertically; narrow windows can scroll horizontally. Task cards have concise titles, project context, branch details, and a readable state label. Color supplements text rather than replacing it.

## Interaction
Use native buttons for keyboard access, visible focus indicators, and accessible control labels. Live state changes move cards automatically. Preserve mounted task content when opening the board so terminals do not restart.
