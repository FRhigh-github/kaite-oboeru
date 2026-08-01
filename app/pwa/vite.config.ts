import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages のサブディレクトリに置く場合はここを "/リポジトリ名/" にする。
const base = process.env.PWA_BASE ?? "/";

export default defineConfig({
  base,
  server: {
    // ロジック層 (app/vocab-core) をプロジェクト外から import するため
    fs: { allow: [".."] },
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/apple-touch-icon.png"],
      manifest: {
        name: "英単語 — 書いて覚える",
        short_name: "英単語",
        description: "選択肢ではなく入力で答える、間隔反復の英単語アプリ",
        lang: "ja",
        start_url: base,
        scope: base,
        display: "standalone",
        orientation: "portrait",
        background_color: "#12131a",
        theme_color: "#12131a",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // 単語データが 700KB 近いので既定の上限(2MB)内に収まるよう明示しておく
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,png,svg,json,md}"],
      },
    }),
  ],
});
