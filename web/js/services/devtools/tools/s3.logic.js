// Pure logic for the "S3 path" dev tool (no DOM; unit-tested from tests/test_devtools_data.py).

const REGION = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d$/;

/** Percent-encodes a key the way SigV4 does: every byte except A-Z a-z 0-9 - _ . ~ and "/" (so + → %2B, space → %20). */
export function encodeKey(key) {
  return String(key).split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function decodePath(p) {
  return p.split('/').map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } }).join('/');
}

/** Region for a partition-specific ARN / console. */
export const partition = (region) => (region?.startsWith('cn-') ? 'aws-cn' : region?.startsWith('us-gov-') ? 'aws-us-gov' : 'aws');

/** "20240101T120000Z" → Date (UTC) or null. */
export function amzDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

/** Interprets an S3 host name: {bucket|null, region|null} or null when it is not an S3 endpoint. */
function parseHost(host) {
  const h = host.toLowerCase();
  const m = /^(.*?)\.?amazonaws\.com(\.cn)?$/.exec(h);
  if (!m || !m[1]) return null;
  const labels = m[1].split('.');
  let at = -1;
  for (let k = labels.length - 1; k >= 0; k--) if (/^s3(?:$|-)/.test(labels[k])) { at = k; break; }
  if (at < 0) return null;
  const bucket = labels.slice(0, at).join('.') || null;
  const s3label = labels[at];
  const after = labels.slice(at + 1).filter((l) => !['dualstack', 'website'].includes(l));
  let region = null;
  const dash = /^s3-(?:website-|fips-)?(.+)$/.exec(s3label);
  if (dash) region = dash[1];
  else if (after[0]) region = after[0];
  if (region === 'external-1') region = 'us-east-1';
  if (region === 'accelerate' || (region && !REGION.test(region))) region = null;
  return { bucket, region, accelerate: s3label === 's3-accelerate' };
}

/**
 * Parses any common way of writing an S3 location. Returns
 *   { bucket, key, region|null, style, versionId?, presigned?: {version, expiresAt (ms)|null, signedAt (ms)|null, seconds|null},
 *     warnings: [] }
 * or throws an Error with a friendly message.
 */
export function parseS3(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Empty input.');
  const warnings = [];
  let m;
  // s3://bucket/key (and Hadoop's s3a:// s3n://): keys are raw, never percent-decoded
  if ((m = /^s3[an]?:\/\/([^/]+)\/?(.*)$/is.exec(raw))) return finish({ bucket: m[1], key: m[2], region: null, style: 's3 URI', warnings });
  if ((m = /^arn:(aws(?:-cn|-us-gov)?):s3:([a-z0-9-]*):(\d*):([^/]+)\/?(.*)$/is.exec(raw))) {
    if (m[4].startsWith('accesspoint') || m[4].startsWith('outpost')) throw new Error('Access point / Outposts ARNs are not supported — use the bucket ARN (arn:aws:s3:::bucket/key).');
    return finish({ bucket: m[4], key: m[5], region: m[2] || (m[1] === 'aws-cn' ? 'cn-north-1' : null), style: 'ARN', warnings });
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : (/^[^/\s]+\.amazonaws\.com(\.cn)?(\/|$)/i.test(raw) ? `https://${raw}` : ''));
  } catch {
    // bare "bucket/key"
    if ((m = /^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.*)$/is.exec(raw)) && !/\s/.test(m[1])) {
      return finish({ bucket: m[1], key: m[2], region: null, style: 'bucket/key', warnings });
    }
    throw new Error('Not an S3 location. Try s3://bucket/key, an https://…amazonaws.com URL, a console URL or arn:aws:s3:::bucket/key.');
  }
  const host = url.hostname.toLowerCase();
  const q = url.searchParams;
  // console URLs: /s3/object/<bucket>?prefix=<key>&region=… and /s3/buckets/<bucket>?prefix=…
  if (/(^|\.)console\.aws\.amazon\.com$/.test(host) || /(^|\.)console\.amazonaws\.cn$/.test(host)) {
    m = /\/s3\/(?:object|buckets)\/([^/?#]+)/.exec(url.pathname);
    if (!m) throw new Error('This console URL does not point at a bucket or object.');
    const region = q.get('region') || (/^([a-z0-9-]+)\.console/.exec(host)?.[1] ?? null);
    return finish({ bucket: decodeURIComponent(m[1]), key: q.get('prefix') || '', region: region && REGION.test(region) ? region : null, style: 'console URL', warnings });
  }
  const info = parseHost(host);
  if (!info) throw new Error(`${host} is not an S3 endpoint (expected …amazonaws.com).`);
  if (url.pathname.includes('+')) warnings.push('The URL path contains “+”. S3 may read it as a space; a literal plus should be written %2B.');
  let bucket = info.bucket;
  let path = url.pathname.replace(/^\//, '');
  let style = 'virtual-hosted';
  if (!bucket) {
    style = 'path-style';
    const slash = path.indexOf('/');
    bucket = decodePath(slash < 0 ? path : path.slice(0, slash));
    path = slash < 0 ? '' : path.slice(slash + 1);
    if (!bucket) throw new Error('The URL has no bucket name.');
  }
  if (info.accelerate) style += ' (transfer acceleration)';
  const result = { bucket, key: decodePath(path), region: info.region, style, warnings };
  if (q.get('versionId')) result.versionId = q.get('versionId');
  // presigned URLs: SigV4 (X-Amz-*) or SigV2 (AWSAccessKeyId / Expires / Signature)
  const get = (name) => { for (const [k, v] of q) if (k.toLowerCase() === name.toLowerCase()) return v; return null; };
  if (get('X-Amz-Signature')) {
    const signed = amzDate(get('X-Amz-Date'));
    const seconds = Number(get('X-Amz-Expires')) || null;
    const cred = get('X-Amz-Credential')?.split('/');
    if (!result.region && cred?.[2] && REGION.test(cred[2])) result.region = cred[2];
    result.presigned = { version: 'SigV4', signedAt: signed?.getTime() ?? null, seconds, expiresAt: signed && seconds ? signed.getTime() + seconds * 1000 : null };
  } else if (get('Signature') && get('Expires')) {
    const exp = Number(get('Expires'));
    result.presigned = { version: 'SigV2', signedAt: null, seconds: null, expiresAt: Number.isFinite(exp) ? exp * 1000 : null };
  }
  if (result.presigned) warnings.push('This is a presigned URL: it contains a signature that grants access until it expires — share it with care.');
  return finish(result);
}

function finish(r) {
  const b = r.bucket;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b) || /\.\.|^\d+\.\d+\.\d+\.\d+$/.test(b)) {
    r.warnings.push(`“${b}” is not a valid bucket name for new buckets (3–63 lowercase letters, digits, dots, hyphens).`);
  }
  if (b.includes('.')) r.warnings.push('The bucket name has dots: virtual-hosted https URLs fail TLS checks for it — use the path-style URL.');
  return r;
}

/** Splits a key into folder prefix, file name and extension. */
export function keyParts(key) {
  const slash = key.lastIndexOf('/');
  const prefix = key.slice(0, slash + 1);
  const filename = key.slice(slash + 1);
  const dot = filename.lastIndexOf('.');
  return { prefix, filename, extension: dot > 0 ? filename.slice(dot + 1) : '' };
}

/** Quotes for a POSIX shell only when needed. */
export const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Every way to write the location. region falls back to opts.region (the remembered default).
 * Returns [{id, label, value}].
 */
export function forms({ bucket, key, region, versionId }, { defaultRegion = '' } = {}) {
  const r = region || defaultRegion || '';
  const enc = encodeKey(key);
  const dom = r.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  const s3uri = `s3://${bucket}/${key}`;
  const isFolder = !key || key.endsWith('/');
  const consoleHost = r.startsWith('cn-') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';
  const consoleQ = new URLSearchParams();
  if (r) consoleQ.set('region', r);
  if (key) consoleQ.set('prefix', key);
  const consoleUrl = `https://s3.${consoleHost}/s3/${isFolder ? 'buckets' : 'object'}/${encodeURIComponent(bucket)}${consoleQ.size ? `?${consoleQ.toString().replace(/\+/g, '%20')}` : ''}`;
  const ver = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
  const regionFlag = r ? ` --region ${r}` : '';
  const q = shellQuote(s3uri);
  return [
    { id: 's3', label: 'S3 URI', value: s3uri },
    { id: 'virtual', label: 'Virtual-hosted URL', value: `https://${bucket}.s3${r ? `.${r}` : ''}.${dom}/${enc}${ver}` },
    { id: 'path', label: 'Path-style URL', value: `https://s3${r ? `.${r}` : ''}.${dom}/${bucket}/${enc}${ver}` },
    { id: 'arn', label: 'ARN', value: `arn:${partition(r)}:s3:::${bucket}/${key}` },
    { id: 'console', label: 'Console URL', value: consoleUrl },
    isFolder
      ? { id: 'cli-cp', label: 'aws s3 cp (download folder)', value: `aws s3 cp ${q} ${shellQuote(keyParts(key.replace(/\/$/, '')).filename || bucket)}/ --recursive${regionFlag}` }
      : { id: 'cli-cp', label: 'aws s3 cp (download)', value: `aws s3 cp ${q} .${regionFlag}` },
    { id: 'cli-ls', label: 'aws s3 ls', value: `aws s3 ls ${shellQuote(`s3://${bucket}/${isFolder ? key : keyParts(key).prefix}`)}${regionFlag}` },
  ];
}

/** Bulk mode: one parsed row per non-empty line. */
export function parseMany(text, opts = {}) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    try {
      const p = parseS3(line);
      const f = Object.fromEntries(forms(p, opts).map((x) => [x.id, x.value]));
      return { input: line, bucket: p.bucket, key: p.key, region: p.region || opts.defaultRegion || '', ...f, ...keyParts(p.key), error: null };
    } catch (e) {
      return { input: line, error: e.message };
    }
  });
}
