import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { transformerTwoslash } from 'fumadocs-twoslash';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';

// Source content from the root docs/ directory.
// Path is relative to this config file (packages/docs/ → ../../docs/).
export const docs = defineDocs({
  dir: '../../docs',
  docs: {
    postprocess: {
      // Required for getLLMText() — exposes processed Markdown for llms.txt
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkNpmOptions: {
      packageManagers: [
        { name: 'npm', command: (cmd) => cmd },
        {
          name: 'pnpm',
          command: (cmd) =>
            cmd
              .split('\n')
              .map((line) =>
                line
                  .replace(/^npm install\b/, 'pnpm install')
                  .replace(/^npm i\b/, 'pnpm add')
                  .replace(/^npm run\b/, 'pnpm run')
                  .replace(/^npx\b/, 'pnpm dlx'),
              )
              .join('\n'),
        },
        {
          name: 'yarn',
          command: (cmd) =>
            cmd
              .split('\n')
              .map((line) =>
                line
                  .replace(/^npm install\b/, 'yarn install')
                  .replace(/^npm i\b/, 'yarn add')
                  .replace(/^npm run\b/, 'yarn')
                  .replace(/^npx\b/, 'yarn dlx'),
              )
              .join('\n'),
        },
      ],
    },
    rehypeCodeOptions: {
      themes: { light: 'github-light', dark: 'github-dark' },
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTwoslash(),
      ],
      langs: ['js', 'jsx', 'ts', 'tsx'],
    },
  },
});
