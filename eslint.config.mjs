import globals from "globals";

const foundryGlobals = Object.fromEntries([
  "canvas", "CONFIG", "CONST", "foundry", "fromUuid", "game", "Hooks",
  "libWrapper", "ui", "ChatMessage", "Dialog", "DialogV2", "Roll",
  "DamageRoll", "TextEditor", "Ray", "PIXI", "Handlebars", "renderTemplate",
  "FormDataExtended", "ApplicationV2", "_replace"
].map((name) => [name, "readonly"]));

export default [{
  files: ["scripts/**/*.js", "tests/**/*.mjs", "tools/**/*.mjs"],
  languageOptions: {
    sourceType: "module",
    globals: { ...globals.browser, ...globals.node, ...foundryGlobals }
  },
  rules: {
    "no-undef": "error"
  }
}];
