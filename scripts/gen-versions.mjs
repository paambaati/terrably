#!/usr/bin/env node
/**
 * Reads all `v*` git tags and writes packages/docs/public/versions.json.
 * Run by CI before each docs build so the VersionSwitcher knows which
 * versions have been deployed to GitHub Pages.
 */
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

const raw = execSync('git tag --list "v*" --sort=-version:refname').toString().trim();
const versions = raw ? raw.split('\n').filter(Boolean) : [];
const latest = versions[0] ?? null;

const manifest = { latest, versions };
writeFileSync(
  'packages/docs/public/versions.json',
  JSON.stringify(manifest, null, 2) + '\n',
);

console.log(`Generated versions.json: latest=${latest}, count=${versions.length}`);
