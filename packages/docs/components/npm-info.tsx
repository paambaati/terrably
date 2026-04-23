import { use } from 'react';
import { Download, Tag } from 'lucide-react';

interface NpmData {
  version: string;
  weeklyDownloads: number;
}

const formatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const promises: Record<string, Promise<NpmData>> = {};

async function fetchNpmInfo(pkg: string): Promise<NpmData> {
  const [regRes, dlRes] = await Promise.all([
    fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      next: { revalidate: 3600 },
    }),
    fetch(`https://api.npmjs.org/downloads/point/last-week/${pkg}`, {
      next: { revalidate: 3600 },
    }),
  ]);

  if (!regRes.ok) throw new Error(`Failed to fetch npm data for ${pkg}`);

  const reg = await regRes.json();
  const dl = dlRes.ok ? await dlRes.json() : { downloads: 0 };

  return {
    version: reg.version as string,
    weeklyDownloads: (dl.downloads as number) ?? 0,
  };
}

export function NpmInfo({ pkg }: { pkg: string }) {
  const { version, weeklyDownloads } = use(
    (promises[pkg] ??= fetchNpmInfo(pkg)),
  );

  return (
    <a
      href={`https://www.npmjs.com/package/${pkg}`}
      rel="noreferrer noopener"
      target="_blank"
      className="flex flex-col gap-1.5 p-2 rounded-lg text-sm text-fd-foreground/80 transition-colors hover:text-fd-accent-foreground hover:bg-fd-accent"
    >
      <p className="flex items-center gap-2 truncate">
        {/* npm square logomark */}
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-3.5 shrink-0">
          <title>npm</title>
          <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474C23.214 24 24 23.214 24 22.237V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
        </svg>
        {pkg}
      </p>
      <div className="flex text-xs items-center gap-1 text-fd-muted-foreground">
        <Tag className="size-3" />
        <span>{version}</span>
        <Download className="size-3 ms-2" />
        <span>{formatter.format(weeklyDownloads)}/wk</span>
      </div>
    </a>
  );
}
