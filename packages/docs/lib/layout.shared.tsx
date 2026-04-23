import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

// Injected at build time by the CI workflow.
// Falls back to 'dev' during local development.
const version = process.env.NEXT_PUBLIC_DOCS_VERSION ?? 'dev';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'terrably',
      transparentMode: 'top',
    },
    links: [
      {
        text: version,
        url: 'https://github.com/paambaati/terrably/releases',
        external: true,
        secondary: false,
      },
    ],
  };
}
