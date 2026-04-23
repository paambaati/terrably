import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';

// Cache indefinitely — content only changes on rebuild.
export const revalidate = false;

export function GET() {
  return new Response(llms(source).index());
}
