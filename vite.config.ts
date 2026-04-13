/// <reference types="vitest" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import UnoCSS from "unocss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const vitePort = Number(process.env.VITE_PORT) || 1420;
// @ts-expect-error process is a nodejs global
const viteHmrPort = Number(process.env.VITE_HMR_PORT) || 1421;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [UnoCSS(), solid()],

  test: {
    environment: "jsdom",
    globals: true,
    transformMode: { web: [/\.[jt]sx?$/] },
  },

  clearScreen: false,
  server: {
    port: vitePort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: viteHmrPort,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
