import type { AdapterDeclaration } from "../types";

export const declaration: AdapterDeclaration = {
  api: "triton.model-repository",
  operations: ["loadModel", "unloadModel"],
  requires: { loadModel: ["route:load"], unloadModel: ["route:unload"] },
  uses: { loadModel: ["resident-slot"], unloadModel: ["resident-slot"] },
  capabilities: {},
};
