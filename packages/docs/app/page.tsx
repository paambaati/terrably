'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Server-side redirect() doesn't work in static export (no runtime server).
// A client-side redirect is the correct approach for output: 'export'.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/docs');
  }, [router]);
  return null;
}
