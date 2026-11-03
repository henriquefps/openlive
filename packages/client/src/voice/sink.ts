// SPDX-License-Identifier: AGPL-3.0-only
// Which output is the voice sink (docs/PROTOCOL.md 8.4); what the helper reports is the web's.

/**
 * The output that is the voice sink: its label is the sink's description. Labels are empty until
 * the microphone was allowed; some platforms add a suffix ("… (Virtual)").
 */
export function findVoiceSinkDevice(
  devices: readonly { kind: string; label: string; deviceId: string }[],
  label: string,
): string | null {
  const want = label.trim();
  if (!want) return null;
  const outputs = devices.filter(
    (d) => d.kind === 'audiooutput' && d.deviceId !== '' && d.deviceId !== 'default',
  );
  const exact = outputs.find((d) => d.label.trim() === want);
  const prefixed = outputs.find((d) => d.label.trim().startsWith(`${want} (`));
  return (exact ?? prefixed)?.deviceId ?? null;
}
