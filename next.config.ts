import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs は同梱の標準CMap（cmaps/*.bcmap）を実行時にファイルから読むため、
  // バンドルせず node_modules のまま実行させる。
  serverExternalPackages: ["pdfjs-dist"],
  // 上記CMap・標準フォントはJSからimportされないためトレースに乗らない。
  // 明示的にサーバー関数へ同梱する（無いと日本語PDFの文字が復元できない）。
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/pdfjs-dist/standard_fonts/**",
    ],
  },
};

export default nextConfig;
