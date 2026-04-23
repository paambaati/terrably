import { createMDX } from 'fumadocs-mdx/next';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  // Required for GitHub Pages: generates folder/index.html files so CDN path
  // routing works correctly without server-side rewrites.
  trailingSlash: true,
  // basePath and assetPrefix must match for GitHub Pages sub-path deployments.
  // Set NEXT_PUBLIC_BASE_PATH to e.g. "/terrably" (repo name) at build time.
  basePath,
  assetPrefix: basePath,
  reactStrictMode: true,
  images: {
    // Required for `output: 'export'` — Next.js image optimisation needs a server.
    unoptimized: true,
  },
  serverExternalPackages: ['typescript', 'twoslash'],
};

const withMDX = createMDX();

export default withMDX(config);
