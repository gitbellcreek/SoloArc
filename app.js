const LAYER_URL = 'https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/Iphone_Images/FeatureServer/0';
const TOKEN_URL = 'https://www.arcgis.com/sharing/rest/generateToken';

let token = null;
let layerFields = null;

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
    layerFields = (j.fields || []).map((f) => f.name.toLowerCase());
    log(`Layer ready: ${j.name || ''} (${layerFields.length} fields)`);
  } catch (e) {
    log(`Could not read layer metadata: ${e.message}`);
    layerFields = [];
  }
}

async function uploadAll() {
  const files = Array.from($('files').files);
  if (!files.length) { log('No files selected.'); return; }
  $('upload-btn').disabled = true;
  for (const f of files) {
    await uploadOne(f);
  }
  $('upload-btn').disabled = false;
  log('\nDone.');
}

async function uploadOne(file) {
  log(`\n${file.name}`);
  try {
    const exif = await exifr.parse(file, { gps: true, tiff: true, exif: true, ifd0: true });
    if (!exif || exif.latitude == null || exif.longitude == null) {
      log('  ! no GPS in EXIF — skipped');
      return;
    }
    log(`  GPS ${exif.latitude.toFixed(6)}, ${exif.longitude.toFixed(6)}`);

    const attrs = {};
    const when = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate;
    if (when instanceof Date) {
      setIfFieldExists(attrs, ['datetaken', 'date_taken', 'timestamp', 'captured', 'phototime', 'photodate', 'date'], when.getTime());
    }
    if (exif.GPSImgDirection != null) {
      setIfFieldExists(attrs, ['direction', 'bearing', 'heading', 'gpsimgdirection', 'azimuth'], exif.GPSImgDirection);
    }
    if (exif.GPSAltitude != null) {
      setIfFieldExists(attrs, ['altitude', 'elevation', 'gpsaltitude'], exif.GPSAltitude);
    }
    setIfFieldExists(attrs, ['filename', 'name', 'file_name', 'photo', 'image'], file.name);

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
  } catch (e) {
    log(`  ERROR: ${e.message}`);
  }
}

function setIfFieldExists(attrs, candidates, value) {
  if (!layerFields || !layerFields.length) return;
  for (const c of candidates) {
    if (layerFields.includes(c)) { attrs[c] = value; return; }
  }
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
  if (!res || !res.success) throw new Error('addFeatures: ' + JSON.stringify(res || j));
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
