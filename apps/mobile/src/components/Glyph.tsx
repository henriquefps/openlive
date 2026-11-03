// SPDX-License-Identifier: AGPL-3.0-only
import {
  Broadcast,
  CameraRotate,
  EarSlash,
  GearSix,
  Headphones,
  Microphone,
  MicrophoneSlash,
  PhoneDisconnect,
  Play,
  SpeakerHigh,
  SpeakerSlash,
  VideoCamera,
  VideoCameraSlash,
  type Icon,
  type IconWeight,
} from 'phosphor-react-native';
import { View } from 'react-native';

// Icons of the room screen: Phosphor, the hfps icon family (regular weight, filled for the active
// and playing states, as on the web). The ones that can be switched off swap to their slashed
// variant. Always decorative: the control or row around them carries the accessibility label.

export type GlyphName =
  'mic' | 'sound' | 'headphones' | 'camera' | 'flip' | 'settings' | 'leave' | 'play' | 'broadcast';

export const MIC: GlyphName = 'mic';
export const SOUND: GlyphName = 'sound';
export const HEADPHONES: GlyphName = 'headphones';
export const CAMERA: GlyphName = 'camera';
export const FLIP: GlyphName = 'flip';
export const SETTINGS: GlyphName = 'settings';
export const LEAVE: GlyphName = 'leave';
export const PLAY: GlyphName = 'play';
export const BROADCAST: GlyphName = 'broadcast';
const HIDE_CHILDREN = 'no-hide-descendants';

/** The glyph for a participant state icon (stateIcons in voice/view.ts). */
export function stateGlyph(icon: string): GlyphName {
  return icon === 'deafened' ? HEADPHONES : MIC;
}

const ICON: Record<GlyphName, { on: Icon; off: Icon }> = {
  mic: { on: Microphone, off: MicrophoneSlash },
  sound: { on: SpeakerHigh, off: SpeakerSlash },
  headphones: { on: Headphones, off: EarSlash },
  camera: { on: VideoCamera, off: VideoCameraSlash },
  flip: { on: CameraRotate, off: CameraRotate },
  settings: { on: GearSix, off: GearSix },
  leave: { on: PhoneDisconnect, off: PhoneDisconnect },
  play: { on: Play, off: Play },
  broadcast: { on: Broadcast, off: Broadcast },
};

export function Glyph({
  name,
  size = 20,
  slashed = false,
  color,
  weight = 'regular',
}: {
  name: GlyphName;
  size?: number;
  /** Switched off, muted: the slashed variant. */
  slashed?: boolean;
  color: string;
  weight?: IconWeight;
}) {
  const Component = slashed ? ICON[name].off : ICON[name].on;
  return (
    <View accessible={false} importantForAccessibility={HIDE_CHILDREN}>
      <Component size={size} color={color} weight={weight} />
    </View>
  );
}
