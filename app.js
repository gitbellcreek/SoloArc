const LAYERS = {
  solocator: {
    label: 'Solocator (Iphone_Images)',
    url: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Iphone_Images/FeatureServer/0',
    userInputs: ['notes'],
  },
  generic: {
    label: 'Generic point layer (El_Rat_Generic)',
    url: 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/El_Rat_Generic/FeatureServer/0',
    userInputs: ['feature', 'notes'],
  },
};
let activeLayerKey = 'solocator';
const layerUrl = () => LAYERS[activeLayerKey].url;

const TOKEN_URL = 'https://www.arcgis.com/sharing/rest/generateToken';

let token = null;
// Map of lowercased field name -> { name, type, length }
let fieldMap = new Map();

const $ = (id) => document.getElementById(id);
const log = (msg) => { const el = $('log'); if (!el) return; el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight; };

window.addEventListener('error', (e) => log(`JS error: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`Unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`));

function setAuthStatus(msg) {
  const el = $('auth-status');
  if (el) el.textContent = msg;
  if (msg) log(msg);
}

window.addEventListener('load', () => {
  if (typeof exifr === 'undefined') log('Library exifr did not load (check ad/content blockers).');
  if (typeof heic2any === 'undefined') log('Library heic2any did not load (check ad/content blockers).');
});

const queue = [];

$('signin').onclick = signIn;
$('signin-token').onclick = signInWithToken;
$('show-token').onclick = () => { $('auth-pw').hidden = true; $('auth-token').hidden = false; $('auth-status').textContent = ''; };
$('show-pw').onclick = () => { $('auth-pw').hidden = false; $('auth-token').hidden = true; $('auth-status').textContent = ''; };
$('upload-btn').onclick = uploadAll;
$('clear-btn').onclick = () => { queue.length = 0; renderQueue(); };
$('files').addEventListener('change', onFilesPicked);
$('reload-btn').onclick = () => { location.replace(location.pathname + '?cb=' + Date.now()); };
$('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') signInWithToken(); });
document.querySelectorAll('input[name="layer"]').forEach((r) => r.addEventListener('change', onLayerToggle));

function onLayerToggle(e) {
  activeLayerKey = e.target.value;
  applyLayerInputs();
  if (token) loadLayerInfo();
}

function applyLayerInputs() {
  const inputs = LAYERS[activeLayerKey].userInputs;
  $('feature-row').hidden = !inputs.includes('feature');
}

function onFilesPicked(e) {
  const picked = Array.from(e.target.files || []);
  for (const f of picked) {
    const key = `${f.name}|${f.size}|${f.lastModified}`;
    if (!queue.some((q) => q._key === key)) {
      f._key = key;
      queue.push(f);
    }
  }
  e.target.value = '';
  renderQueue();
}

function renderQueue() {
  const ul = $('queue');
  ul.innerHTML = '';
  queue.forEach((f, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${f.name}  (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '✕';
    btn.title = 'Remove';
    btn.onclick = () => { queue.splice(i, 1); renderQueue(); };
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
  $('upload-btn').textContent = queue.length ? `Upload ${queue.length} file${queue.length === 1 ? '' : 's'}` : 'Upload queue';
}

async function requestToken(username, password, referer) {
  const body = new URLSearchParams({
    username,
    password,
    referer,
    client: 'referer',
    expiration: '120',
    f: 'json',
  });
  const r = await fetch(TOKEN_URL, { method: 'POST', body });
  const j = await r.json();
  return j;
}

async function signIn() {
  const username = $('user').value.trim();
  const password = $('pass').value;
  if (!username || !password) { setAuthStatus('Enter credentials.'); return; }
  $('signin').disabled = true;
  setAuthStatus('Signing in...');
  try {
    let j = await requestToken(username, password, location.origin);
    if (j.error || !j.token) {
      const j2 = await requestToken(username, password, location.origin + '/');
      if (!j2.error && j2.token) j = j2;
    }
    if (j.error) {
      const msg = j.error.message || JSON.stringify(j.error);
      const details = (j.error.details && j.error.details.join('; ')) || '';
      throw new Error(`${msg}${details ? ' — ' + details : ''}`);
    }
    if (!j.token) throw new Error('No token returned (response: ' + JSON.stringify(j).slice(0, 200) + ')');
    token = j.token;
    $('pass').value = '';
    onSignedIn(username);
  } catch (e) {
    setAuthStatus('Sign-in failed: ' + (e.message || e) + ' — if your org uses SSO, use "Use a token instead".');
    $('signin').disabled = false;
  }
}

async function signInWithToken() {
  const t = $('token-input').value.trim();
  if (!t) { setAuthStatus('Paste a token.'); return; }
  $('signin-token').disabled = true;
  setAuthStatus('Validating token...');
  try {
    const r = await fetch(`${layerUrl()}?f=json&token=${encodeURIComponent(t)}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    token = t;
    $('token-input').value = '';
    onSignedIn('(token)');
  } catch (e) {
    setAuthStatus('Token rejected: ' + (e.message || e));
    $('signin-token').disabled = false;
  }
}

function onSignedIn(label) {
  $('auth').hidden = true;
  $('upload').hidden = false;
  $('who').textContent = `Signed in as ${label}`;
  setAuthStatus('');
  applyLayerInputs();
  loadLayerInfo();
}

async function loadLayerInfo() {
  try {
    const r = await fetch(`${layerUrl()}?f=json&token=${encodeURIComponent(token)}`);
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
  if (!queue.length) { log('Queue is empty.'); return; }
  $('upload-btn').disabled = true;
  $('clear-btn').disabled = true;
  const layerRadios = document.querySelectorAll('input[name="layer"]');
  layerRadios.forEach((r) => { r.disabled = true; });
  log(`\nUploading to: ${LAYERS[activeLayerKey].label}`);
  const total = queue.length;
  let ok = 0, fail = 0, skip = 0;
  // Drain the queue, removing each as it finishes.
  for (let i = 0; i < total; i++) {
    const file = queue[0];
    const result = await uploadOne(file, i + 1, total);
    if (result === 'ok') ok++;
    else if (result === 'skip') skip++;
    else fail++;
    queue.shift();
    renderQueue();
  }
  log(`\nDone. ${ok} uploaded, ${skip} skipped, ${fail} failed.`);
  $('upload-btn').disabled = false;
  $('clear-btn').disabled = false;
  layerRadios.forEach((r) => { r.disabled = false; });
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
      setField(attrs, ['direction', 'bearing', 'heading', 'gpsimgdirection', 'azimuth', 'esrisnsr_azimuth'], exif.GPSImgDirection);
    }
    if (exif.GPSAltitude != null) {
      setField(attrs, ['altitude', 'elevation', 'gpsaltitude'], exif.GPSAltitude);
    }
    setField(attrs, ['filename', 'name', 'file_name', 'photo', 'image'], file.name);

    const feature = ($('feature').value || '').trim();
    if (feature) setField(attrs, ['feature', 'feature_name', 'featurename', 'name'], feature);

    const notes = ($('notes').value || '').trim();
    if (notes) setField(attrs, ['notes', 'note', 'description', 'comments', 'comment'], notes);

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
  const r = await fetch(`${layerUrl()}/addFeatures`, { method: 'POST', body });
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
  const r = await fetch(`${layerUrl()}/${oid}/addAttachment`, { method: 'POST', body: fd });
  const j = await r.json();
  if (j.error) throw new Error('addAttachment: ' + j.error.message);
  if (!j.addAttachmentResult || !j.addAttachmentResult.success) {
    throw new Error('addAttachment: ' + JSON.stringify(j));
  }
}
