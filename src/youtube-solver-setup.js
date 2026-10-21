"use strict";

// The upstream solver exposes its parser/generator bundle as `lib`; the core
// expects those names on the global object when its static script executes.
Object.assign(globalThis, globalThis.lib || {});

// The solver prepends an environment shim to the player that assigns
// `globalThis.location = new URL(…youtube.com…)`. Under Node/Deno that just
// defines a global, but here `globalThis` is the sandbox frame's window, so the
// assignment *navigates the frame away*: the first solve still answers, then the
// sandbox unloads with its MessagePort and every later YouTube download waits
// on a dead channel. Redirect that write to an inert property. The core binds
// `meriyah` when its script loads, so this wrapper must be installed first.
if (globalThis.meriyah && typeof globalThis.meriyah.parse === "function") {
  const parse = globalThis.meriyah.parse;
  globalThis.meriyah = {
    ...globalThis.meriyah,
    parse(code, options) {
      if (typeof code === "string") {
        code = code.replace(/\bglobalThis\.location\s*=/g, "globalThis.__xvdSolverLocation =");
      }
      return parse.call(this, code, options);
    },
  };
}
