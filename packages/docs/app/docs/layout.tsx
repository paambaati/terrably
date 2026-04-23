import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';
import { GithubInfo } from 'fumadocs-ui/components/github-info';
import { NpmInfo } from '@/components/npm-info';
import { VersionSwitcher } from '@/components/version-switcher';

export default function Layout({ children }: { children: ReactNode }) {
  const opts = baseOptions();
  return (
    <DocsLayout
      tree={source.pageTree}
      {...opts}
      links={[
        ...(opts.links ?? []),
        {
          type: 'custom',
          children: <VersionSwitcher />,
        },
        {
          type: 'custom',
          children: (
            <GithubInfo owner="paambaati" repo="terrably" />
          ),
        },
        {
          type: 'custom',
          children: (
            <NpmInfo pkg="terrably" />
          ),
        },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
