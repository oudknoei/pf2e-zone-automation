const EPSILON = 1e-7;

/** Reads a finite canvas point without accepting partially missing coordinates. */
function point(x, y) {
  const resolved = { x: Number(x), y: Number(y) };
  return Number.isFinite(resolved.x) && Number.isFinite(resolved.y) ? resolved : null;
}

/** Returns a TokenDocument's occupied center in canvas pixels without requiring its rendered object. */
export function tokenCenter(token) {
  const rendered = point(token?.object?.center?.x, token?.object?.center?.y)
    ?? point(token?.center?.x, token?.center?.y);
  if (rendered) return rendered;

  const size = token?.getSize?.();
  const origin = point(token?.x, token?.y);
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!origin || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { x: origin.x + width / 2, y: origin.y + height / 2 };
}

/** Uses the placed area's center as its point of origin, with the source Token as a legacy fallback. */
export function zoneOrigin(region, payload, sourceToken) {
  if (payload?.config?.mode !== "area") return tokenCenter(sourceToken);
  const shape = Array.from(region?.shapes ?? [])[0];
  if (!shape) return tokenCenter(sourceToken);
  if (shape.type === "circle") return point(shape.x, shape.y) ?? tokenCenter(sourceToken);
  if (shape.type === "rectangle") {
    return point(Number(shape.x) + Number(shape.width) / 2, Number(shape.y) + Number(shape.height) / 2)
      ?? tokenCenter(sourceToken);
  }
  return tokenCenter(sourceToken);
}

/** Extracts the two endpoints stored by either a WallDocument or its rendered Wall. */
function wallSegment(wall) {
  const coordinates = wall?.document?.c ?? wall?.c;
  if (!Array.isArray(coordinates) || coordinates.length < 4) return null;
  const a = point(coordinates[0], coordinates[1]);
  const b = point(coordinates[2], coordinates[3]);
  return a && b ? { a, b } : null;
}

/** Identifies core walls that represent a closed physical barrier to movement. */
export function isPhysicalBarrier(wall) {
  const document = wall?.document ?? wall;
  const moveNone = globalThis.CONST?.WALL_SENSE_TYPES?.NONE ?? 0;
  if (document?.move === moveNone) return false;

  const doorNone = globalThis.CONST?.WALL_DOOR_TYPES?.NONE ?? 0;
  const doorOpen = globalThis.CONST?.WALL_DOOR_STATES?.OPEN ?? 1;
  if (document?.door !== undefined && document.door !== doorNone && document.ds === doorOpen) return false;
  return Boolean(wallSegment(wall));
}

/** Tests two closed line segments while ignoring contact only at the zone or target point itself. */
function segmentsBlockPath(origin, target, wallStart, wallEnd) {
  const pathX = target.x - origin.x;
  const pathY = target.y - origin.y;
  const wallX = wallEnd.x - wallStart.x;
  const wallY = wallEnd.y - wallStart.y;
  const denominator = pathX * wallY - pathY * wallX;
  const offsetX = wallStart.x - origin.x;
  const offsetY = wallStart.y - origin.y;

  if (Math.abs(denominator) > EPSILON) {
    const pathPosition = (offsetX * wallY - offsetY * wallX) / denominator;
    const wallPosition = (offsetX * pathY - offsetY * pathX) / denominator;
    return pathPosition > EPSILON && pathPosition < 1 - EPSILON
      && wallPosition >= -EPSILON && wallPosition <= 1 + EPSILON;
  }

  // Parallel segments only intersect when they are collinear. Project any
  // overlap onto the longer path axis so walls laid along the path still block.
  if (Math.abs(offsetX * pathY - offsetY * pathX) > EPSILON) return false;
  const pathLengthSquared = pathX * pathX + pathY * pathY;
  if (pathLengthSquared <= EPSILON) return false;
  const first = (offsetX * pathX + offsetY * pathY) / pathLengthSquared;
  const second = ((wallEnd.x - origin.x) * pathX + (wallEnd.y - origin.y) * pathY) / pathLengthSquared;
  const overlapStart = Math.max(EPSILON, Math.min(first, second));
  const overlapEnd = Math.min(1 - EPSILON, Math.max(first, second));
  return overlapStart <= overlapEnd;
}

/** Applies core WallDocument movement restrictions without depending on a viewed canvas or another module. */
export function hasLineOfEffect(scene, origin, target) {
  if (!origin || !target) return true;
  const walls = scene?.walls?.contents ?? scene?.walls ?? [];
  for (const wall of walls) {
    if (!isPhysicalBarrier(wall)) continue;
    const segment = wallSegment(wall);
    if (segment && segmentsBlockPath(origin, target, segment.a, segment.b)) return false;
  }
  return true;
}
