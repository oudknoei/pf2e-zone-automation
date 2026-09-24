/** Keeps fixed-area geometry identical for direct GM and player-requested creation. */
export function fixedAreaShape(config, center, distancePixels) {
  const x = Number(center.x);
  const y = Number(center.y);
  const scale = Number(distancePixels);
  if (![x, y, scale].every(Number.isFinite) || scale <= 0) throw new Error("Area placement is invalid.");
  if (config.areaShape === "square") {
    const side = Number(config.sideLength) * scale;
    if (!Number.isFinite(side) || side <= 0) throw new Error("Square side length is invalid.");
    return { type: "rectangle", x: x - side / 2, y: y - side / 2, width: side, height: side, rotation: 0, gridBased: true };
  }
  const radius = Number(config.radius) * scale;
  if (!Number.isFinite(radius) || radius <= 0) throw new Error("Area radius is invalid.");
  return { type: "circle", x, y, radius, gridBased: true };
}

/** Recognizes a pure drag so resizing a zone does not imply a path that never occurred. */
export function translatedAreaShapes(before, after) {
  if (before?.length !== 1 || after?.length !== 1) return null;
  const a = before[0];
  const b = after[0];
  if (!a || !b || a.type !== b.type || !["circle", "rectangle"].includes(a.type)) return null;
  const geometry = a.type === "circle" ? ["radius"] : ["width", "height", "rotation"];
  if (geometry.some((key) => Number(a[key] ?? 0) !== Number(b[key] ?? 0))) return null;
  const dx = Number(b.x) - Number(a.x);
  const dy = Number(b.y) - Number(a.y);
  if (![dx, dy].every(Number.isFinite) || (dx === 0 && dy === 0)) return null;
  return { before: a, after: b };
}

/** Uses the token's occupied rectangle so a moving area can affect a creature crossed between endpoints. */
export function tokenBounds(token) {
  const size = token?.getSize?.();
  const x = Number(token?.x);
  const y = Number(token?.y);
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** Finds the closest path point so circular sweeps include near-edge token spaces. */
function segmentPointDistanceSquared(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  const x = a.x + t * dx - p.x;
  const y = a.y + t * dy - p.y;
  return x * x + y * y;
}

/** Handles circle centers near a token edge without relying on its corners. */
function pointRectDistanceSquared(point, box) {
  const x = Math.max(box.x - point.x, 0, point.x - box.x - box.width);
  const y = Math.max(box.y - point.y, 0, point.y - box.y - box.height);
  return x * x + y * y;
}

/** Detects a path through the token footprint before testing circle radius. */
function segmentIntersectsBox(a, b, box) {
  let low = 0;
  let high = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - box.x], [dx, box.x + box.width - a.x],
    [-dy, a.y - box.y], [dy, box.y + box.height - a.y]
  ]) {
    if (p === 0 && q < 0) return false;
    if (p < 0) low = Math.max(low, q / p);
    if (p > 0) high = Math.min(high, q / p);
  }
  return low <= high;
}

/** Preserves a square footprint even if a GM later rotates its Region shape. */
function rectangleCorners(shape) {
  const width = Number(shape.width);
  const height = Number(shape.height);
  const cx = Number(shape.x) + width / 2;
  const cy = Number(shape.y) + height / 2;
  const angle = Number(shape.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]]
    .map(([x, y]) => ({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos }));
}

/** Forms the area covered between both positions of a translated rectangle. */
function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  /** Keeps only exterior corners of the moved rectangle. */
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (const point of sorted.toReversed()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Tests a swept square against the whole token space, not just its center. */
function polygonIntersectsBox(polygon, box) {
  const corners = [
    { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
  ];
  const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    axes.push({ x: b.y - a.y, y: a.x - b.x });
  }
  for (const axis of axes) {
    /** A separating axis proves the swept area missed the token. */
    const project = (point) => point.x * axis.x + point.y * axis.y;
    const p = polygon.map(project);
    const q = corners.map(project);
    if (Math.max(...p) < Math.min(...q) || Math.max(...q) < Math.min(...p)) return false;
  }
  return true;
}

/** Checks the full drag path, including tokens no longer inside the area at its destination. */
export function sweptAreaIntersectsToken(translation, box) {
  if (!translation || !box) return false;
  const { before, after } = translation;
  if (before.type === "rectangle") {
    return polygonIntersectsBox(convexHull([...rectangleCorners(before), ...rectangleCorners(after)]), box);
  }
  const radius = Number(before.radius);
  if (!Number.isFinite(radius) || radius <= 0) return false;
  const a = { x: Number(before.x), y: Number(before.y) };
  const b = { x: Number(after.x), y: Number(after.y) };
  if (segmentIntersectsBox(a, b, box)) return true;
  const corners = [
    { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
  ];
  const distance = Math.min(
    pointRectDistanceSquared(a, box), pointRectDistanceSquared(b, box),
    ...corners.map((corner) => segmentPointDistanceSquared(a, b, corner))
  );
  return distance <= radius * radius;
}
