import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	resolve: {
		// 运行时也要认识 `@/`，否则只修 tsconfig 会导致 Vite 解析失败。
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	plugins: [tailwindcss(), react(), cloudflare()],
});
