import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.resolve(process.cwd(), '..');
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  // sdílený kód (src/core, src/shared, config) leží mimo složku web/
  turbopack: { root },
  outputFileTracingRoot: root,
  devIndicators: false,
  // sdílený kód importuje './x.js' (NodeNext) – webpack to musí přeložit na .ts
  webpack(config) {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${gateway}/api/:path*` }];
  },
};

export default nextConfig;
