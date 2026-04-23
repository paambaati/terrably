import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: {
    template: '%s | terrably',
    default: 'terrably — TypeScript Terraform provider framework',
  },
  description: 'TypeScript-native framework for building Terraform providers.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        {/*
          Static search: the /api/search route is pre-rendered as a JSON file
          during `next build`. The search UI fetches it client-side via Orama.
        */}
        <RootProvider
          search={{
            options: {
              type: 'static',
            },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
