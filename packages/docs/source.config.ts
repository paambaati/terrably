import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import lastModified from 'fumadocs-mdx/plugins/last-modified';
import { transformerTwoslash } from 'fumadocs-twoslash';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';

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
  plugins: [lastModified()],
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
          name: 'bun',
          command: (cmd) =>
            cmd
              .split('\n')
              .map((line) =>
                line
                  .replace(/^npm install\b/, 'bun install')
                  .replace(/^npm i\b/, 'bun install')
                  .replace(/^npm run\b/, 'bun')
                  .replace(/^npx\b/, 'bunx'),
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
