import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
export default definePluginEntry({
    id: "voice-mode",
    name: "Voice Mode",
    description: "Injects voice-mode guidance into the system prompt for voice sessions",
    register(api) {
        const config = api.config?.plugins?.entries?.["voice-mode"]?.config ?? {};
        const prefix = config.sessionKeyPrefix ?? "agent:voice:";
        const guidancePath = join(dirname(fileURLToPath(import.meta.url)), "voice-guidance.md");
        const guidance = readFileSync(guidancePath, "utf-8");
        api.on("before_prompt_build", (_event, ctx) => {
            if (!ctx.sessionKey?.startsWith(prefix))
                return {};
            return { appendSystemContext: guidance };
        }, { priority: 5 });
    },
});
