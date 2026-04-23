import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

// `force-static` is required for Next.js to include this Route Handler in
// output: 'export'. It pre-renders the search indexes as a static JSON file
// at build time; the Orama client fetches it at runtime for in-browser search.
export const dynamic = 'force-static';

export const { staticGET: GET } = createFromSource(source);
