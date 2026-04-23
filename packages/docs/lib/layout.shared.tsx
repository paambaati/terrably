import Image from 'next/image';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import iconSvg from '../public/icon.svg';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <Image
            src={iconSvg}
            alt="terrably"
            width={20}
            height={20}
            className="shrink-0"
            loading="eager"
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
