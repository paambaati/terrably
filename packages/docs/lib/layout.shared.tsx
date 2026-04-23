import Image from 'next/image';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import iconSvg from '../public/icon.svg';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex shrink-0 size-6 items-center justify-center rounded-md bg-[#1a1a1a] dark:bg-[#2a2a2a] shadow-sm">
            <Image src={iconSvg} alt="" width={16} height={16} loading="eager" unoptimized aria-hidden />
          </span>
          <span className="text-base font-semibold">terrably</span>
        </span>
      ),
      transparentMode: 'top',
    },
    links: [],
  };
}
