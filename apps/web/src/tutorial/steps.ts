// SPDX-License-Identifier: AGPL-3.0-only
// The interactive tutorial's steps. Each step points at an element by its
// `data-tour` attribute; a screen's steps run, in order, the first time the user opens it.
//
// Extension points: Phase 2 adds a `player` screen (volume and mute, theatre mode, quality,
// stats) and Phase 3 the `golive-*` screens (pick a helper, a source, the options; live). Give the
// elements a `data-tour`, register the steps below (or call registerTutorialSteps from the
// feature's module), add the copy under `tutorial.<screen>` in both locales, and call
// useTutorialScreen('<screen>', ready) in the screen.

export type TutorialPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TutorialStep {
  /** Unique within its screen. */
  id: string;
  /** Screen id: progress is stored per screen (lowercase letters, digits and hyphens). */
  screen: string;
  /** The value of the target element's `data-tour` attribute. */
  anchor: string;
  /** i18n keys; keep the copy to two short sentences. */
  titleKey: string;
  bodyKey: string;
  placement: TutorialPlacement;
}

/** When several screens are waiting (the top bar and a page), lower runs first. */
export const SCREEN_ORDER: Record<string, number> = { topbar: 100 };

const step = (
  screen: string,
  id: string,
  anchor: string,
  placement: TutorialPlacement,
): TutorialStep => ({
  id,
  screen,
  anchor,
  titleKey: `tutorial.${screen}.${id}.title`,
  bodyKey: `tutorial.${screen}.${id}.body`,
  placement,
});

const STEPS: TutorialStep[] = [
  step('spaces', 'what', 'spaces-list', 'bottom'),
  step('spaces', 'create', 'spaces-create', 'bottom'),
  step('space', 'rooms', 'space-tab-rooms', 'bottom'),
  // Managers only: a new room starts from a template.
  step('space', 'create', 'space-create-room', 'bottom'),
  step('space', 'quick', 'space-quick-room', 'bottom'),
  step('space', 'invites', 'space-tab-invites', 'bottom'),
  step('space', 'members', 'space-tab-members', 'bottom'),
  // The room page (routes/room/RoomView.tsx): "N here" in the header, the live streams, Go live
  // and the chat next to the room's name, and Join voice (phones show the steps in a sheet, so
  // the placement is for desktop).
  step('room', 'presence', 'room-presence', 'bottom'),
  step('room', 'streams', 'room-streams', 'bottom'),
  step('room', 'golive', 'room-go-live', 'bottom'),
  // Owners and admins: what the room has (stream, voice, text).
  step('room', 'features', 'room-features', 'bottom'),
  // Rooms with voice: Join voice, then, once in, mute and deafen
  // in the "Voice connected" panel (the sidebar's footer, the bottom bar on phones) and the
  // devices on the room's voice status line.
  step('room', 'voice', 'room-voice-bar', 'top'),
  // Rooms with text: the chat beside the stage, or, when it is
  // not on screen (phones, a closed panel), the button that opens it.
  step('room', 'chat', 'room-chat', 'left'),
  step('room', 'chatButton', 'room-chat-toggle', 'bottom'),
  // Once in voice: the "Voice connected" panel, which stays while browsing, its controls, the
  // camera toggle (rooms with cameras) and the devices.
  step('voice', 'panel', 'voice-connected', 'top'),
  step('voice', 'mute', 'voice-mute', 'top'),
  step('voice', 'deafen', 'voice-deafen', 'top'),
  step('voice', 'camera', 'voice-camera', 'top'),
  step('voice', 'devices', 'voice-devices', 'top'),
  // The Go live panel (golive/GoLive.tsx): one screen per step of the flow, as each appears.
  step('golive-helper', 'helpers', 'golive-helpers', 'bottom'),
  step('golive-source', 'sources', 'golive-sources', 'top'),
  step('golive-options', 'preset', 'golive-preset', 'bottom'),
  step('golive-options', 'audio', 'golive-audio', 'bottom'),
  step('golive-options', 'start', 'golive-start', 'top'),
  step('golive-live', 'controls', 'golive-controls', 'bottom'),
  // /admin/users (platform admin only).
  step('admin-users', 'search', 'admin-users-search', 'bottom'),
  step('admin-users', 'filter', 'admin-users-filter', 'bottom'),
  step('admin-users', 'list', 'admin-users-list', 'top'),
  // /admin/settings: the monthly limit cards.
  step('admin-settings', 'budget', 'admin-settings-budget', 'bottom'),
  step('topbar', 'preferences', 'topbar-preferences', 'bottom'),
  step('topbar', 'user', 'topbar-user', 'bottom'),
];

/** Adds steps for a screen (later phases). Steps with an id already registered are replaced. */
export function registerTutorialSteps(steps: readonly TutorialStep[]): void {
  for (const s of steps) {
    const at = STEPS.findIndex((x) => x.screen === s.screen && x.id === s.id);
    if (at >= 0) STEPS[at] = s;
    else STEPS.push(s);
  }
}

export function stepsFor(screen: string): TutorialStep[] {
  return STEPS.filter((s) => s.screen === screen);
}

/** The anchor element of a step, if it is in the page and laid out (not display: none). */
export function anchorOf(s: TutorialStep, root: ParentNode = document): HTMLElement | null {
  const el = root.querySelector<HTMLElement>(`[data-tour="${CSS.escape(s.anchor)}"]`);
  // checkVisibility is false inside display: none (a hidden tab, a desktop-only control).
  if (!el || (typeof el.checkVisibility === 'function' && !el.checkVisibility())) return null;
  return el;
}

/** The steps whose anchor is on the page now; the others are skipped. */
export function presentSteps(
  steps: readonly TutorialStep[],
  root: ParentNode = document,
): TutorialStep[] {
  return steps.filter((s) => anchorOf(s, root) !== null);
}
