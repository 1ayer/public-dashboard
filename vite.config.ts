import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";
export default defineConfig({
  base: "./",
  plugins: [sites()],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
  },
});
