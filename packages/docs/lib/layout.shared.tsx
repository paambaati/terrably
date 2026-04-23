import Image from 'next/image';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import iconSvg from '../public/icon.svg';

// Injected at build time by the CI workflow.
// Falls back to 'dev' during local development.
const version = process.env.NEXT_PUBLIC_DOCS_VERSION ?? 'dev';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <Image
            src={iconSvg}
            alt="terrably logo"
            width={20}
            height={20}
            className="shrink-0"
            unoptimized
          />
          terrably
        </span>
      ),
      transparentMode: 'top',
    },
    links: [],
  };
}
