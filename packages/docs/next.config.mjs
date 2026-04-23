import { createMDX } from 'fumadocs-mdx/next';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  trailingSlash: true,
  // Set NEXT_PUBLIC_BASE_PATH to the repo name at build time, e.g. "/terrably".
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
