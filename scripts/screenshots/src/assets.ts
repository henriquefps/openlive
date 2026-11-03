// SPDX-License-Identifier: AGPL-3.0-only
// The pictures in the shots: each person's profile photo and camera, and the stills the helpers
// stream. The real ones are committed in scripts/screenshots/assets/ (JPEG; made-up people, AI-generated,
// fine to publish). Any that is missing is drawn here as a neutral stand-in (a gradient with
// initials, or a simple scene) in the git-ignored scripts/screenshots/.provisional/, and logged,
// so the pipeline runs end to end before the real pictures exist.

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { log } from './stack.ts';

const root = resolve(import.meta.dirname, '..');
export const ASSETS_DIR = join(root, 'assets');
const PROVISIONAL_DIR = join(root, '.provisional');

export const PEOPLE = ['ana', 'bruno', 'carla', 'diego', 'eva', 'felipe'] as const;
export type Person = (typeof PEOPLE)[number];
export const STREAMS = ['game', 'movie', 'desktop'] as const;
export type StreamStill = (typeof STREAMS)[number];

export interface Assets {
  avatar: Record<Person, string>;
  cam: Record<Person, string>;
  stream: Record<StreamStill, string>;
  /** The files that were drawn because the real one is missing. */
  provisional: string[];
}

/** One hue pair per person, so the stand-ins tell people apart. */
const HUES: Record<Person, [number, number]> = {
  ana: [150, 95],
  bruno: [210, 250],
  carla: [330, 15],
  diego: [35, 60],
  eva: [270, 300],
  felipe: [185, 140],
};

const hsl = (h: number, s: number, l: number) => `hsl(${h} ${s}% ${l}%)`;
const name = (p: Person) => p.charAt(0).toUpperCase() + p.slice(1);

function avatarSvg(p: Person, size: number): string {
  const [a, b] = HUES[p];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${hsl(a, 45, 62)}"/><stop offset="1" stop-color="${hsl(b, 40, 38)}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Inter, sans-serif"
    font-weight="600" font-size="${size * 0.42}" fill="white" fill-opacity="0.92">${name(p)[0]}</text>
</svg>`;
}

/** A camera stand-in: a softly lit wall, a head-and-shoulders shape, the initial on it. */
function camSvg(p: Person, w: number, h: number): string {
  const [a, b] = HUES[p];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <radialGradient id="wall" cx="0.3" cy="0.25" r="1">
      <stop offset="0" stop-color="${hsl(b, 25, 78)}"/><stop offset="1" stop-color="${hsl(b, 30, 30)}"/>
    </radialGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hsl(a, 40, 50)}"/><stop offset="1" stop-color="${hsl(a, 45, 28)}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#wall)"/>
  <ellipse cx="${w / 2}" cy="${h * 1.08}" rx="${w * 0.26}" ry="${h * 0.42}" fill="url(#body)"/>
  <circle cx="${w / 2}" cy="${h * 0.42}" r="${h * 0.2}" fill="${hsl(a, 30, 72)}"/>
  <text x="50%" y="${h * 0.42}" dy="0.35em" text-anchor="middle" font-family="Inter, sans-serif"
    font-weight="600" font-size="${h * 0.2}" fill="${hsl(a, 40, 30)}">${name(p)[0]}</text>
</svg>`;
}

/** A stream stand-in: a simple scene per kind, no text, so it reads as a picture. */
function streamSvg(kind: StreamStill, w: number, h: number): string {
  if (kind === 'movie') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1d2b53"/><stop offset="0.55" stop-color="#c8577a"/><stop offset="1" stop-color="#f6b26b"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#sky)"/>
  <circle cx="${w * 0.62}" cy="${h * 0.6}" r="${h * 0.12}" fill="#ffe3a3"/>
  <path d="M0 ${h * 0.72} L${w * 0.2} ${h * 0.55} L${w * 0.38} ${h * 0.7} L${w * 0.58} ${h * 0.5} L${w * 0.8} ${h * 0.68} L${w} ${h * 0.58} L${w} ${h} L0 ${h} Z" fill="#2a1f3d"/>
  <path d="M0 ${h * 0.85} L${w * 0.3} ${h * 0.76} L${w * 0.6} ${h * 0.86} L${w} ${h * 0.78} L${w} ${h} L0 ${h} Z" fill="#140f22"/>
  <rect width="100%" height="${h * 0.1}" fill="black"/><rect y="${h * 0.9}" width="100%" height="${h * 0.1}" fill="black"/>
</svg>`;
  }
  if (kind === 'game') {
    const lines = Array.from({ length: 14 }, (_, i) => {
      const x = (w / 13) * i;
      return `<line x1="${x}" y1="${h * 0.55}" x2="${w / 2 + (x - w / 2) * 3}" y2="${h}" stroke="#ff4fd8" stroke-opacity="0.55" stroke-width="3"/>`;
    }).join('');
    const rows = Array.from({ length: 8 }, (_, i) => {
      const y = h * 0.55 + (h * 0.45 * (i + 1) ** 2) / 64;
      return `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#ff4fd8" stroke-opacity="0.55" stroke-width="3"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0b0628"/><stop offset="1" stop-color="#4b1263"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#sky)"/>
  <circle cx="${w / 2}" cy="${h * 0.5}" r="${h * 0.22}" fill="#ffb347"/>
  <rect y="${h * 0.55}" width="100%" height="${h * 0.45}" fill="#12052b"/>${lines}${rows}
  <polygon points="${w * 0.46},${h * 0.9} ${w * 0.5},${h * 0.78} ${w * 0.54},${h * 0.9}" fill="#39f3ff"/>
</svg>`;
  }
  const win = (x: number, y: number, ww: number, wh: number, c: string) =>
    `<g><rect x="${x}" y="${y}" width="${ww}" height="${wh}" rx="14" fill="#f7f7f4"/>
    <rect x="${x}" y="${y}" width="${ww}" height="48" rx="14" fill="#e6e6df"/>
    <rect x="${x + 32}" y="${y + 90}" width="${ww * 0.5}" height="22" rx="6" fill="${c}"/>
    <rect x="${x + 32}" y="${y + 140}" width="${ww * 0.8}" height="16" rx="6" fill="#d4d4cc"/>
    <rect x="${x + 32}" y="${y + 176}" width="${ww * 0.7}" height="16" rx="6" fill="#d4d4cc"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#5d6b4a"/><stop offset="1" stop-color="#26301f"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  ${win(w * 0.08, h * 0.1, w * 0.5, h * 0.6, '#7c8a5c')}${win(w * 0.45, h * 0.3, w * 0.45, h * 0.55, '#4f6d8f')}
  <rect y="${h - 72}" width="100%" height="72" fill="#1b1f17" fill-opacity="0.9"/>
</svg>`;
}

async function ensure(file: string, draw: () => string, provisional: string[]): Promise<string> {
  const real = join(ASSETS_DIR, file);
  if (existsSync(real)) return real;
  const stand = join(PROVISIONAL_DIR, file);
  if (!existsSync(stand)) await sharp(Buffer.from(draw())).jpeg({ quality: 88 }).toFile(stand);
  provisional.push(file);
  return stand;
}

/** The path of every picture: the real one in assets/, or a drawn stand-in. */
export async function loadAssets(): Promise<Assets> {
  mkdirSync(PROVISIONAL_DIR, { recursive: true });
  const provisional: string[] = [];
  const avatar = {} as Record<Person, string>;
  const cam = {} as Record<Person, string>;
  const stream = {} as Record<StreamStill, string>;
  for (const p of PEOPLE) {
    avatar[p] = await ensure(`avatar-${p}.jpg`, () => avatarSvg(p, 512), provisional);
    cam[p] = await ensure(`cam-${p}.jpg`, () => camSvg(p, 1280, 720), provisional);
  }
  for (const s of STREAMS) {
    stream[s] = await ensure(`stream-${s}.jpg`, () => streamSvg(s, 2560, 1440), provisional);
  }
  if (provisional.length) {
    log(
      `PROVISIONAL stand-ins (missing in scripts/screenshots/assets/): ${provisional.join(', ')}`,
    );
  }
  return { avatar, cam, stream, provisional };
}

/** The profile photo as the web sends it: a 256 x 256 WebP, cropped to the centre. */
export function avatarUpload(file: string): Promise<Buffer> {
  return sharp(file).resize(256, 256, { fit: 'cover' }).webp({ quality: 86 }).toBuffer();
}

/** A camera picture as a 1280 x 720 JPEG data URL, for the fake camera in the page. */
export async function camDataUrl(file: string): Promise<string> {
  const jpeg = await sharp(file)
    .resize(1280, 720, { fit: 'cover' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}
