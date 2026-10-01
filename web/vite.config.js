import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "../server/src/guildport/web_static",
    emptyOutDir: true,
    sourcemap: false,
  },
});
