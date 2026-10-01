const MODULE_ID = "pf2e-zone-automation";
const OUTLINE = Symbol("pf2eZoneOutline");

/** Limits the visual change to Regions created by this module. */
function isZoneRegion(region) {
  return Boolean(region?.document?.getFlag?.("world", "pf2eZone"));
}

/** Accepts Foundry's Number-based Color objects as well as saved CSS strings. */
function outlineColor(value) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 0xffffff) return numeric;
  const text = String(value ?? "").trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(text);
  return match ? Number.parseInt(match[1], 16) : 0xffffff;
}

/** Draws the resolved boundary, including holes and wall-clipped edges, without a fill. */
export function drawZoneOutline(region) {
  if (!isZoneRegion(region) || !region.document?.polygonTree || !region.addChild) return;
  const paths = [...region.document.polygonTree]
    .map((node) => node.path)
    .filter((path) => path?.length >= 2);
  let outline = region[OUTLINE];
  if (!outline || outline.destroyed || outline.parent !== region) {
    if (outline && !outline.destroyed) outline.destroy();
    outline = new PIXI.Graphics();
    outline.eventMode = "none";
    region[OUTLINE] = outline;
    region.addChild(outline);
  }
  outline.clear();
  const color = outlineColor(region.document.color);
  for (const [width, stroke, alpha] of [[6, 0x000000, 0.9], [3, color, 1]]) {
    outline.lineStyle(width, stroke, alpha);
    for (const path of paths) {
      outline.moveTo(path[0].x, path[0].y);
      for (const point of path.slice(1)) outline.lineTo(point.x, point.y);
      outline.closePath();
    }
  }
}

/** Falls back to Foundry's fill if a future canvas change prevents drawing a line. */
function tryDrawZoneOutline(region) {
  try {
    drawZoneOutline(region);
  } catch (error) {
    region[OUTLINE]?.destroy();
    delete region[OUTLINE];
    console.warn("PF2e Zone could not draw a Region outline", error);
  }
}

/** Adds the line to Regions already drawn before the ready hook or a Scene switch. */
function drawViewedZones() {
  for (const region of canvas?.regions?.placeables ?? []) tryDrawZoneOutline(region);
}

/** Suppresses only this module's Region fill meshes and keeps its boundaries current. */
export function installZoneOutlines() {
  if (game.system.id !== "pf2e") return;
  if (!globalThis.libWrapper?.register) throw new Error("libWrapper is unavailable.");
  const registered = [];
  /** Tracks each successful wrapper so installation can be rolled back on failure. */
  function register(target, wrapper, mode) {
    registered.push(libWrapper.register(MODULE_ID, target, wrapper, mode) ?? target);
  }
  try {
    /** Leaves the native fill available until a zone has a working outline. */
    register("foundry.canvas.placeables.regions.RegionMesh.prototype._render", function(wrapped, ...args) {
      const region = this.region;
      if (isZoneRegion(region) && region[OUTLINE]?.parent === region && !region[OUTLINE].destroyed) return;
      return wrapped(...args);
    }, "MIXED");
    /** Adds the boundary after Foundry has drawn the Region. */
    register("CONFIG.Region.objectClass.prototype._draw", async function(wrapped, ...args) {
      const result = await wrapped(...args);
      tryDrawZoneOutline(this);
      return result;
    }, "WRAPPER");
    for (const method of ["_refreshGeometry", "_onTokenAnimationFrame"]) {
      /** Follows edited areas and moving token emanations. */
      register(`CONFIG.Region.objectClass.prototype.${method}`, function(wrapped, ...args) {
        const result = wrapped(...args);
        tryDrawZoneOutline(this);
        return result;
      }, "WRAPPER");
    }
    Hooks.on("canvasReady", drawViewedZones);
    drawViewedZones();
  } catch (error) {
    for (const target of registered.reverse()) libWrapper.unregister?.(MODULE_ID, target);
    throw error;
  }
}
