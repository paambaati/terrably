'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface VersionsManifest {
  latest: string | null;
  versions: string[];
}

// Both env vars are injected at build time by CI.
// In local dev they are both absent → no switcher rendered.
const currentVersion = process.env.NEXT_PUBLIC_DOCS_VERSION ?? 'dev';
const repoBase = process.env.NEXT_PUBLIC_DOCS_REPO_BASE ?? '';

export function VersionSwitcher() {
  const [manifest, setManifest] = useState<VersionsManifest | null>(null);

  useEffect(() => {
    if (!repoBase) return; // local dev — nothing to fetch
    fetch(`${repoBase}/versions.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (
          data &&
          typeof data === 'object' &&
          'versions' in data &&
          Array.isArray((data as VersionsManifest).versions)
        ) {
          setManifest(data as VersionsManifest);
        }
      })
      .catch(() => {}); // non-critical — swallow errors silently
  }, []);

  // Local dev or only one version deployed: show a plain badge.
  if (!manifest || manifest.versions.length <= 1) {
    return (
      <span className="font-mono text-xs px-2 py-0.5 rounded-full bg-fd-muted text-fd-muted-foreground select-none">
        {currentVersion}
      </span>
    );
  }

  const isLatest = currentVersion === manifest.latest;
  const selectValue = isLatest ? '__latest__' : currentVersion;

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const selected = e.target.value;
    const base = window.location.origin + repoBase;
    window.location.href =
      selected === '__latest__' ? `${base}/docs/` : `${base}/${selected}/docs/`;
  }

  return (
    <div className="relative flex items-center">
      <select
        value={selectValue}
        onChange={handleChange}
        aria-label="Switch docs version"
        className="font-mono text-xs rounded-full bg-fd-muted text-fd-muted-foreground px-2 py-0.5 pr-6 appearance-none cursor-pointer border-0 outline-none hover:bg-fd-accent hover:text-fd-accent-foreground focus:bg-fd-accent focus:text-fd-accent-foreground transition-colors"
      >
        <option value="__latest__">{manifest.latest} (latest)</option>
        {manifest.versions
          .filter((v) => v !== manifest.latest)
          .map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
      </select>
      <ChevronDown className="size-3 absolute right-1.5 pointer-events-none text-fd-muted-foreground" />
    </div>
  );
}
