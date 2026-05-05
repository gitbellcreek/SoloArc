const LAYER_URL = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Iphone_Images/FeatureServer/0';
const TOKEN_URL = 'https://www.arcgis.com/sharing/rest/generateToken';

let token = null;
// Map of lowercased field name -> { name, type, length }
let fieldMap = new Map();

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $('log'); el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight; };

$('signin').onclick = signIn;
$('upload-btn').onclick = uploadAll;
$('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });

async function signIn() {
  const username = $('user').value.trim();
  const password = $('pass').value;
  if (!username || !password) { $('auth-status').textContent = 'Enter credentials.'; return; }
  $('signin').disabled = true;
  $('auth-status').textContent = 'Signing in...';
  try {
    const body = new URLSearchParams({
      username,
      password,
      referer: location.origin,
      client: 'referer',
      expiration: '120',
      f: 'json',
    });
    const r = await fetch(TOKEN_URL, { method: 'POST', body });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (!j.token) throw new Error('No token returned');
    token = j.token;
    $('pass').value = '';
    $('auth').hidden = true;
    $('upload').hidden = false;
    $('who').textContent = `Signed in as ${username}`;
    await loadLayerInfo();
  } catch (e) {
    $('auth-status').textContent = 'Sign-in failed: ' + e.message;
    $('signin').disabled = false;
  }
}

async function loadLayerInfo() {
  try {
    const r = await fetch(`${LAYER_URL}?f=json&token=${encodeURIComponent(token)}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    fieldMap = new Map();
    for (const f of (j.fields || [])) {
      fieldMap.set(f.name.toLowerCase(), { name: f.name, type: f.type, length: f.length });
    }
    log(`Layer: ${j.name || '(unnamed)'} — fields: ${[...fieldMap.values()].map(f => f.name).join(', ')}`);
  } catch (e) {
    log(`Could not read layer metadata: ${e.message}`);
    fieldMap = new Map();
  }
}

async function uploadAll() {
  const files = Array.from($('files').files);
  if (!files.length) { log('No files selected.'); return; }
  $('upload-btn').disabled = true;
  let ok = 0, fail = 0, skip = 0;
  for (let i = 0; i < files.length; i++) {
    const result = await uploadOne(files[i], i + 1, files.length);
    if (result === 'ok') ok++;
    else if (result === 'skip') skip++;
    else fail++;
  }
  log(`\nDone. ${ok} uploaded, ${skip} skipped, ${fail} failed.`);
  // Reset selection so the user can pick more without leftover queue.
  $('files').value = '';
  $('upload-btn').disabled = false;
}

async function uploadOne(file, idx, total) {
  log(`\n[${idx}/${total}] ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`);
  try {
    const exif = await exifr.parse(file, { gps: true, tiff: true, exif: true, ifd0: true });
    if (!exif || exif.latitude == null || exif.longitude == null) {
      log('  ! no GPS in EXIF — skipped');
      return 'skip';
    }
    log(`  GPS ${exif.latitude.toFixed(6)}, ${exif.longitude.toFixed(6)}`);

    const attrs = {};
    const when = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate;
    if (when instanceof Date) {
      setField(attrs, ['datetaken', 'date_taken', 'timestamp', 'captured', 'phototime', 'photodate', 'date'], when);
    }
    if (exif.GPSImgDirection != null) {
      setField(attrs, ['direction', 'bearing', 'heading', 'gpsimgdirection', 'azimuth'], exif.GPSImgDirection);
    }
    if (exif.GPSAltitude != null) {
      setField(attrs, ['altitude', 'elevation', 'gpsaltitude'], exif.GPSAltitude);
    }
    setField(attrs, ['filename', 'name', 'file_name', 'photo', 'image'], file.name);

    if (Object.keys(attrs).length) {
      log(`  attrs: ${JSON.stringify(attrs)}`);
    } else {
      log('  attrs: (none — no matching fields on layer)');
    }

    const oid = await addFeature(exif.longitude, exif.latitude, attrs);
    log(`  feature OID ${oid}`);

    let blob = file;
    let outName = file.name;
    const isHeic = /\.hei[cf]$/i.test(file.name) || file.type === 'image/heic' || file.type === 'image/heif';
    if (isHeic) {
      log('  converting HEIC to JPEG...');
      blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
      outName = file.name.replace(/\.hei[cf]$/i, '.jpg');
    }
    await addAttachment(oid, blob, outName);
    log('  attachment uploaded');
    return 'ok';
  } catch (e) {
    log(`  ERROR: ${e.message}`);
    return 'fail';
  }
}

function setField(attrs, candidates, value) {
  if (!fieldMap.size) return;
  for (const c of candidates) {
    const f = fieldMap.get(c);
    if (!f) continue;
    attrs[f.name] = coerceForField(value, f);
    return;
  }
}

function coerceForField(value, field) {
  const t = field.type;
  if (t === 'esriFieldTypeDate') {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const d = new Date(value);
    return isNaN(d) ? null : d.getTime();
  }
  if (t === 'esriFieldTypeInteger' || t === 'esriFieldTypeSmallInteger' || t === 'esriFieldTypeOID') {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'esriFieldTypeDouble' || t === 'esriFieldTypeSingle') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'esriFieldTypeString') {
    let s = value instanceof Date ? value.toISOString() : String(value);
    if (field.length && s.length > field.length) s = s.slice(0, field.length);
    return s;
  }
  return value;
}

async function addFeature(lon, lat, attributes) {
  const body = new URLSearchParams({
    f: 'json',
    token,
    rollbackOnFailure: 'true',
    features: JSON.stringify([{
      geometry: { x: lon, y: lat, spatialReference: { wkid: 4326 } },
      attributes,
    }]),
  });
  const r = await fetch(`${LAYER_URL}/addFeatures`, { method: 'POST', body });
  const j = await r.json();
  if (j.error) throw new Error('addFeatures: ' + j.error.message);
  const res = j.addResults && j.addResults[0];
  if (!res || !res.success) {
    const err = (res && res.error && res.error.description) || JSON.stringify(res || j);
    throw new Error('addFeatures: ' + err);
  }
  return res.objectId;
}

async function addAttachment(oid, blob, filename) {
  const fd = new FormData();
  fd.append('f', 'json');
  fd.append('token', token);
  fd.append('attachment', blob, filename);
  const r = await fetch(`${LAYER_URL}/${oid}/addAttachment`, { method: 'POST', body: fd });
  const j = await r.json();
  if (j.error) throw new Error('addAttachment: ' + j.error.message);
  if (!j.addAttachmentResult || !j.addAttachmentResult.success) {
    throw new Error('addAttachment: ' + JSON.stringify(j));
  }
}
