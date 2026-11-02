// SPDX-License-Identifier: AGPL-3.0-only
// The per-environment secrets file (apps/api/.secrets.<env>), in the .dev.vars format:
// KEY=VALUE lines, `#` comments, optional quotes. Errors name the line and key, never a value.

const KEY = /^[A-Z][A-Z0-9_]*$/;
const PLAIN_VALUE = /^[A-Za-z0-9_\-.:/+=@,~]*$/;

export class SecretsFileError extends Error {}

interface ParsedLine {
  key: string;
  value: string;
}

function parseLine(raw: string, lineNo: number): ParsedLine | null {
  const line = raw.trim();
  if (line === '' || line.startsWith('#')) return null;
  const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
  const eq = body.indexOf('=');
  if (eq <= 0) throw new SecretsFileError(`line ${lineNo}: expected KEY=VALUE`);
  const key = body.slice(0, eq).trim();
  if (!KEY.test(key)) throw new SecretsFileError(`line ${lineNo}: invalid key name`);
  const rest = body.slice(eq + 1).trim();
  return { key, value: unquote(rest, key, lineNo) };
}

function unquote(rest: string, key: string, lineNo: number): string {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    if (rest.length < 2 || rest[rest.length - 1] !== quote) {
      throw new SecretsFileError(`line ${lineNo}: unterminated quote in ${key}`);
    }
    if (quote === "'") return rest.slice(1, -1);
    try {
      return JSON.parse(rest) as string;
    } catch {
      throw new SecretsFileError(`line ${lineNo}: invalid double-quoted value in ${key}`);
    }
  }
  // An unquoted value ends at an inline comment, as in .dev.vars.
  const hash = rest.search(/\s#/);
  return (hash === -1 ? rest : rest.slice(0, hash)).trim();
}

/** Parses the file; keys with an empty value are kept (they are placeholders to fill in). */
export function parseSecretsFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const parsed = parseLine(raw, i + 1);
    if (!parsed) return;
    if (entries.has(parsed.key)) {
      throw new SecretsFileError(`line ${i + 1}: duplicate key ${parsed.key}`);
    }
    entries.set(parsed.key, parsed.value);
  });
  return entries;
}

/** The keys that have a non-empty value. */
export function filledSecrets(entries: Map<string, string>): Map<string, string> {
  return new Map([...entries].filter(([, v]) => v !== ''));
}

function formatValue(value: string): string {
  return PLAIN_VALUE.test(value) ? value : JSON.stringify(value);
}

/**
 * Sets one key, keeping comments and the order of the other lines: replaces the key's line if
 * it exists (an empty placeholder included), otherwise appends it.
 */
export function setSecret(text: string, key: string, value: string): string {
  if (!KEY.test(key)) throw new SecretsFileError(`invalid key name ${key}`);
  const lines = text.split(/\r?\n/);
  const newLine = `${key}=${formatValue(value)}`;
  const index = lines.findIndex((raw, i) => parseLine(raw, i + 1)?.key === key);
  if (index !== -1) {
    lines[index] = newLine;
    return lines.join('\n');
  }
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.push(newLine, '');
  return lines.join('\n');
}
