import { resolve } from 'node:path'

import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    // Workspace packages use NodeNext's explicit .js specifiers while publishing TypeScript sources.
    extensionAlias: {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    },
  },
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
}

export default nextConfig
