type Point = { x: number; y: number }
type Size = { width: number; height: number }

/** Keep a floating element of `size` opened at `pos` fully inside the viewport. */
export function clampToViewport(pos: Point, size: Size, viewport: Size, margin = 8): Point {
  const x = Math.max(margin, Math.min(pos.x, viewport.width - size.width - margin))
  const y = Math.max(margin, Math.min(pos.y, viewport.height - size.height - margin))
  return { x, y }
}
