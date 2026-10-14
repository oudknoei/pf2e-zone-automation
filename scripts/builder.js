import { openZoneBuilderController } from "./builder-controller.js";

/** Keeps the module and macro builder entry point stable while delegating editor operations. */
export async function openZoneBuilder() {
  return openZoneBuilderController();
}
