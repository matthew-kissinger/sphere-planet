import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const outputDir = path.join(root, 'output', 'audio');
const proofPath = path.join(outputDir, 'audio-asset-proof.json');
const eventsPath = path.join(root, 'src', 'audio', 'events.ts');

const MiB = 1024 * 1024;
const MUSIC_MAX_FILE_BYTES = Math.floor(3.1 * MiB);
const MUSIC_MAX_TOTAL_BYTES = 36 * MiB;
const SFX_MAX_FILE_BYTES = 96 * 1024;
const AMBIENCE_MAX_FILE_BYTES = 512 * 1024;

const failures = [];

function fail(message) {
  failures.push(message);
}

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function assertFfprobe() {
  const result = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || result.error?.message || 'ffprobe unavailable';
    throw new Error(`ffprobe is required for audio asset proof: ${detail.trim()}`);
  }
}

function ffprobe(file) {
  const args = [
    '-v', 'error',
    '-show_entries',
    'format=duration,bit_rate,size,format_name:format_tags:stream=index,codec_name,codec_type,sample_rate,channels,bit_rate,disposition',
    '-of', 'json',
    file,
  ];
  const result = spawnSync('ffprobe', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || result.error?.message || 'unknown ffprobe error';
    fail(`${rel(file)} could not be probed: ${detail.trim()}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    fail(`${rel(file)} returned invalid ffprobe JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parseRuntimeCatalog() {
  const source = readFileSync(eventsPath, 'utf8');
  const musicUrls = extractCatalogPaths(source, 'music');
  const sfxUrls = extractCatalogPaths(source, 'sfx');
  const ambienceUrls = extractCatalogPaths(source, 'ambience');
  if (musicUrls.length !== 14) fail(`expected 14 runtime music tracks, found ${musicUrls.length}`);
  if (new Set(musicUrls).size !== musicUrls.length) fail('runtime music catalog contains duplicate URLs');
  if (new Set([...sfxUrls, ...ambienceUrls]).size !== sfxUrls.length + ambienceUrls.length) {
    fail('runtime SFX/ambience catalog contains duplicate URLs');
  }
  return { musicUrls, sfxUrls, ambienceUrls };
}

function extractCatalogPaths(source, group) {
  const helper = [...source.matchAll(new RegExp(`url:\\s*audioUrl\\(\\s*'audio/${group}/([^']+\\.mp3)'`, 'g'))].map((m) => m[1]);
  const literal = [...source.matchAll(new RegExp(`url:\\s*'/?audio/${group}/([^']+\\.mp3)'`, 'g'))].map((m) => m[1]);
  return [...helper, ...literal];
}

function listedMp3s(folder) {
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.mp3'))
    .sort((a, b) => a.localeCompare(b));
}

function checkExactFolderCatalog(folder, expectedNames, label) {
  const actual = listedMp3s(folder);
  const expected = [...expectedNames].sort((a, b) => a.localeCompare(b));
  for (const name of expected) {
    if (!actual.includes(name)) fail(`${label} catalog references missing file ${name}`);
  }
  for (const name of actual) {
    if (!expected.includes(name)) fail(`${label} folder has unreferenced MP3 ${name}`);
  }
  return actual;
}

function audioSummary(file) {
  const data = ffprobe(file);
  if (!data) return null;
  const audioStreams = (data.streams ?? []).filter((stream) => stream.codec_type === 'audio');
  const stream = audioStreams[0];
  const attachedPictures = (data.streams ?? []).filter((stream) => stream.disposition?.attached_pic === 1);
  const format = data.format ?? {};
  const tags = format.tags ?? {};
  if (audioStreams.length !== 1) fail(`${rel(file)} should have exactly one audio stream, found ${audioStreams.length}`);
  if (attachedPictures.length > 0) fail(`${rel(file)} contains attached artwork streams`);
  return {
    file: rel(file),
    bytes: statSync(file).size,
    durationSeconds: Number(Number(format.duration ?? 0).toFixed(3)),
    codec: stream?.codec_name ?? 'unknown',
    sampleRate: Number(stream?.sample_rate ?? 0),
    channels: Number(stream?.channels ?? 0),
    streamBitrate: Number(stream?.bit_rate ?? 0),
    formatBitrate: Number(format.bit_rate ?? 0),
    formatName: format.format_name ?? '',
    tags: Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function inRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function checkBaseMp3(summary, label) {
  if (!summary) return;
  if (summary.codec !== 'mp3') fail(`${summary.file} should be mp3, found ${summary.codec}`);
  if (summary.sampleRate !== 44100) fail(`${summary.file} should be 44.1 kHz, found ${summary.sampleRate}`);
  if (summary.channels !== 2) fail(`${summary.file} should be stereo, found ${summary.channels} channels`);
  if (Object.keys(summary.tags).some((tag) => tag !== 'encoder')) {
    fail(`${summary.file} has non-shipping metadata tags: ${Object.keys(summary.tags).join(', ')}`);
  }
  if (!inRange(summary.streamBitrate, 126000, 130000)) {
    fail(`${summary.file} ${label} should be near 128 kbps, found ${summary.streamBitrate}`);
  }
}

function checkMusic(file) {
  const summary = audioSummary(file);
  checkBaseMp3(summary, 'music');
  if (!summary) return null;
  if (summary.bytes > MUSIC_MAX_FILE_BYTES) fail(`${summary.file} exceeds music file budget: ${summary.bytes}`);
  if (!inRange(summary.durationSeconds, 90, 240)) {
    fail(`${summary.file} should be a short streamed cue-length track between 90s and 240s, found ${summary.durationSeconds}s`);
  }
  return summary;
}

function checkSfx(file) {
  const summary = audioSummary(file);
  checkBaseMp3(summary, 'SFX');
  if (!summary) return null;
  if (summary.bytes > SFX_MAX_FILE_BYTES) fail(`${summary.file} exceeds SFX file budget: ${summary.bytes}`);
  if (!inRange(summary.durationSeconds, 0.1, 2.5)) {
    fail(`${summary.file} should be short SFX between 0.1s and 2.5s, found ${summary.durationSeconds}s`);
  }
  return summary;
}

function checkAmbience(file) {
  const summary = audioSummary(file);
  checkBaseMp3(summary, 'ambience');
  if (!summary) return null;
  if (summary.bytes > AMBIENCE_MAX_FILE_BYTES) fail(`${summary.file} exceeds ambience file budget: ${summary.bytes}`);
  if (!inRange(summary.durationSeconds, 8, 30)) {
    fail(`${summary.file} should be an ambience loop between 8s and 30s, found ${summary.durationSeconds}s`);
  }
  return summary;
}

assertFfprobe();

const catalog = parseRuntimeCatalog();
const musicDir = path.join(root, 'public', 'audio', 'music');
const sfxDir = path.join(root, 'public', 'audio', 'sfx');
const ambienceDir = path.join(root, 'public', 'audio', 'ambience');

const actualMusic = checkExactFolderCatalog(musicDir, catalog.musicUrls, 'music');
checkExactFolderCatalog(sfxDir, catalog.sfxUrls, 'SFX');
checkExactFolderCatalog(ambienceDir, catalog.ambienceUrls, 'ambience');

const music = actualMusic.map((name) => checkMusic(path.join(musicDir, name))).filter(Boolean);
const sfx = catalog.sfxUrls.map((name) => {
  const file = path.join(sfxDir, name);
  if (!existsSync(file)) return null;
  return checkSfx(file);
}).filter(Boolean);
const ambience = catalog.ambienceUrls.map((name) => {
  const file = path.join(ambienceDir, name);
  if (!existsSync(file)) return null;
  return checkAmbience(file);
}).filter(Boolean);

const musicTotalBytes = music.reduce((sum, item) => sum + item.bytes, 0);
const sfxTotalBytes = sfx.reduce((sum, item) => sum + item.bytes, 0);
const ambienceTotalBytes = ambience.reduce((sum, item) => sum + item.bytes, 0);
if (musicTotalBytes > MUSIC_MAX_TOTAL_BYTES) fail(`music album exceeds total budget: ${musicTotalBytes}`);

const proof = {
  generatedAt: new Date().toISOString(),
  status: failures.length === 0 ? 'pass' : 'fail',
  budgets: {
    musicMaxFileBytes: MUSIC_MAX_FILE_BYTES,
    musicMaxTotalBytes: MUSIC_MAX_TOTAL_BYTES,
    sfxMaxFileBytes: SFX_MAX_FILE_BYTES,
    ambienceMaxFileBytes: AMBIENCE_MAX_FILE_BYTES,
  },
  totals: {
    musicTracks: music.length,
    musicTotalBytes,
    musicTotalMiB: Number((musicTotalBytes / MiB).toFixed(2)),
    sfxAssets: sfx.length,
    sfxTotalBytes,
    ambienceAssets: ambience.length,
    ambienceTotalBytes,
  },
  runtimeCatalog: {
    music: catalog.musicUrls.map((name) => `/audio/music/${name}`),
    sfx: catalog.sfxUrls.map((name) => `/audio/sfx/${name}`),
    ambience: catalog.ambienceUrls.map((name) => `/audio/ambience/${name}`),
  },
  assets: { music, sfx, ambience },
  failures,
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);

if (failures.length > 0) {
  console.error(`Audio asset proof failed; wrote ${rel(proofPath)}`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Audio asset proof passed; wrote ${rel(proofPath)}`);
console.log(`Music: ${music.length} tracks, ${proof.totals.musicTotalMiB} MiB, MP3 44.1 kHz stereo 128 kbps`);
console.log(`SFX: ${sfx.length} files, ambience: ${ambience.length} loop(s)`);
