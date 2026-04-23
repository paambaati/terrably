import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

// Source content from the root docs/ directory.
// Path is relative to this config file (packages/docs/ → ../../docs/).
export const docs = defineDocs({
  dir: '../../docs',
});

export default defineConfig();
