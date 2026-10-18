/**
 * Copy Vercel Blob objects to a new store and rewrite MySQL URL columns.
 *
 *   BLOB_SOURCE_TOKEN=... BLOB_DEST_TOKEN=... DATABASE_URL=... \
 *     npx tsx scripts/migrate-vercel-blob.ts --phase=all
 *
 * Flags: --phase=export|copy|rewrite|verify|all  --dry-run  --resume
 *        --manifest=path  --mapping=path  --sample=20  --from=db|blob|both
 *
 * Same-store VPS cutover does not need this script. See deploy/BLOB_MIGRATION.md.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

type Phase = 'export' | 'copy' | 'rewrite' | 'verify' | 'all';

type ManifestRow = {
  oldUrl: string;
  pathname?: string;
  table: string | null;
  column: string | null;
  primaryKey: string | number | null;
};

const URL_COLUMNS: { table: string; column: string; pk: string }[] = [
  { table: 'gyms', column: 'logoUrl', pk: 'id' },
  { table: 'members', column: 'photoUrl', pk: 'id' },
  { table: 'pos_products', column: 'imageUrl', pk: 'id' },
  { table: 'pos_product_images', column: 'url', pk: 'id' },
  { table: 'marketing_image_versions', column: 'imageUrl', pk: 'id' },
];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function isBlobUrl(value: string): boolean {
  return /^https?:\/\/[^/]*vercel-storage\.com\//i.test(value);
}

function pathnameOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/+/, '');
    return p || undefined;
  } catch {
    return undefined;
  }
}

async function exportFromDb(prisma: PrismaClient): Promise<ManifestRow[]> {
  const rows: ManifestRow[] = [];
  for (const spec of URL_COLUMNS) {
    const sql = `SELECT \`${spec.pk}\` AS pk, \`${spec.column}\` AS url FROM \`${spec.table}\` WHERE \`${spec.column}\` IS NOT NULL AND \`${spec.column}\` <> ''`;
    const found = await prisma.$queryRawUnsafe<Array<{ pk: bigint | number | string; url: string }>>(sql);
    for (const row of found) {
      const oldUrl = String(row.url).trim();
      if (!isBlobUrl(oldUrl)) continue;
      rows.push({
        oldUrl,
        pathname: pathnameOf(oldUrl),
        table: spec.table,
        column: spec.column,
        primaryKey: typeof row.pk === 'bigint' ? row.pk.toString() : row.pk,
      });
    }
  }
  return rows;
}

async function exportFromBlobList(token: string): Promise<ManifestRow[]> {
  const { list } = await import('@vercel/blob');
  const rows: ManifestRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ token, cursor, limit: 1000 });
    for (const blob of page.blobs) {
      rows.push({
        oldUrl: blob.url,
        pathname: blob.pathname,
        table: null,
        column: null,
        primaryKey: null,
      });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return rows;
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

async function copyBlobs(manifest: ManifestRow[], destToken: string, mappingPath: string, dryRun: boolean, resume: boolean) {
  const { put } = await import('@vercel/blob');
  const mapping = readJson<Record<string, string>>(mappingPath, {});
  const failures: { oldUrl: string; error: string }[] = [];
  const seen = new Set<string>();

  for (const row of manifest) {
    if (seen.has(row.oldUrl)) continue;
    seen.add(row.oldUrl);
    if (resume && mapping[row.oldUrl]) continue;

    const pathname = row.pathname;
    if (!pathname) {
      failures.push({ oldUrl: row.oldUrl, error: 'missing pathname' });
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] copy ${row.oldUrl} -> ${pathname}`);
      continue;
    }

    try {
      const res = await fetch(row.oldUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const blob = await put(pathname, body, {
        access: 'public',
        token: destToken,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      mapping[row.oldUrl] = blob.url;
      fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
      console.log(`copied ${pathname}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ oldUrl: row.oldUrl, error });
      console.error(`FAIL ${row.oldUrl}: ${error}`);
    }
  }

  const failPath = mappingPath.replace(/\.json$/i, '') + '.failures.json';
  fs.writeFileSync(failPath, JSON.stringify(failures, null, 2));
  console.log(`mapping ${Object.keys(mapping).length} urls, failures ${failures.length} -> ${failPath}`);
  if (failures.length) process.exitCode = 1;
}

async function rewriteDb(prisma: PrismaClient, manifest: ManifestRow[], mappingPath: string, dryRun: boolean) {
  const mapping = readJson<Record<string, string>>(mappingPath, {});
  let updated = 0;
  for (const row of manifest) {
    if (!row.table || !row.column || row.primaryKey == null) continue;
    const next = mapping[row.oldUrl];
    if (!next || next === row.oldUrl) continue;
    const spec = URL_COLUMNS.find((c) => c.table === row.table && c.column === row.column);
    if (!spec) continue;
    if (dryRun) {
      console.log(`[dry-run] ${spec.table}.${spec.column} pk=${row.primaryKey}`);
      updated += 1;
      continue;
    }
    const sql = `UPDATE \`${spec.table}\` SET \`${spec.column}\` = ? WHERE \`${spec.pk}\` = ? AND \`${spec.column}\` = ?`;
    const count = await prisma.$executeRawUnsafe(sql, next, row.primaryKey, row.oldUrl);
    updated += Number(count) || 0;
  }
  console.log(`rewritten rows: ${updated}`);
}

async function verify(mappingPath: string, sampleSize: number) {
  const mapping = readJson<Record<string, string>>(mappingPath, {});
  const urls = Object.values(mapping);
  if (!urls.length) {
    console.error('mapping file is empty; nothing to verify');
    process.exitCode = 1;
    return;
  }
  const step = Math.max(1, Math.floor(urls.length / sampleSize));
  const sample: string[] = [];
  for (let i = 0; i < urls.length && sample.length < sampleSize; i += step) {
    sample.push(urls[i]);
  }
  let ok = 0;
  for (const url of sample) {
    const res = await fetch(url, { method: 'GET' });
    const type = res.headers.get('content-type') || '';
    const good = res.status === 200 && type.startsWith('image/');
    console.log(`${good ? 'OK' : 'BAD'} ${res.status} ${type} ${url}`);
    if (good) ok += 1;
    else process.exitCode = 1;
  }
  console.log(`verified ${ok}/${sample.length}`);
}

async function main() {
  const phase = (arg('phase') || 'all') as Phase;
  const dryRun = hasFlag('dry-run');
  const resume = hasFlag('resume');
  const from = arg('from') || 'db';
  const manifestPath = path.resolve(arg('manifest') || 'blob-migration-manifest.json');
  const mappingPath = path.resolve(arg('mapping') || 'blob-migration-mapping.json');
  const sample = Number(arg('sample') || '20');
  const sourceToken = process.env.BLOB_SOURCE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || '';
  const destToken = process.env.BLOB_DEST_TOKEN || '';

  const needsDb = phase === 'export' || phase === 'rewrite' || phase === 'all' || from !== 'blob';
  const prisma = needsDb ? new PrismaClient() : null;

  try {
    let manifest: ManifestRow[] = [];
    if (phase === 'export' || phase === 'all') {
      if (from === 'db' || from === 'both') {
        if (!prisma) throw new Error('DATABASE_URL required for db export');
        manifest.push(...(await exportFromDb(prisma)));
      }
      if (from === 'blob' || from === 'both') {
        if (!sourceToken) throw new Error('BLOB_SOURCE_TOKEN (or BLOB_READ_WRITE_TOKEN) required for list()');
        const listed = await exportFromBlobList(sourceToken);
        const known = new Set(manifest.map((r) => r.oldUrl));
        for (const row of listed) {
          if (!known.has(row.oldUrl)) manifest.push(row);
        }
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`wrote ${manifest.length} rows to ${manifestPath}`);
    } else {
      manifest = readJson<ManifestRow[]>(manifestPath, []);
    }

    if (phase === 'copy' || phase === 'all') {
      if (!destToken && !dryRun) throw new Error('BLOB_DEST_TOKEN required');
      await copyBlobs(manifest, destToken, mappingPath, dryRun, resume);
    }
    if (phase === 'rewrite' || phase === 'all') {
      if (!prisma) throw new Error('DATABASE_URL required');
      await rewriteDb(prisma, manifest, mappingPath, dryRun);
    }
    if (phase === 'verify' || phase === 'all') {
      if (!dryRun) await verify(mappingPath, sample);
    }
  } finally {
    await prisma?.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
