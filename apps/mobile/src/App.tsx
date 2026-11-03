// SPDX-License-Identifier: AGPL-3.0-only
import './i18n/index.ts';
import { useIsRestoring } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BUSTER, persister, queryClient, wireQueryEnvironment } from './cache/client.ts';
import { MAX_AGE_MS, pruneUnknown } from './lib/cache.ts';
import { parseAppLink, type AppLink } from './lib/deeplink.ts';
import {
  addRoute,
  INITIAL_STACK,
  instanceRemoved,
  instanceRoute,
  pop as popStack,
  push as pushStack,
  reset as resetStack,
  roomRoute,
  type Route,
  sessionLost,
  spaceRoute,
  type Stack,
  top,
} from './lib/navigation.ts';
import { AddInstanceScreen } from './screens/AddInstanceScreen.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { InstanceScreen } from './screens/InstanceScreen.tsx';
import { RoomScreen } from './screens/RoomScreen.tsx';
import { ScanScreen } from './screens/ScanScreen.tsx';
import { SpaceScreen } from './screens/SpaceScreen.tsx';
import { VoiceDebugScreen } from './screens/VoiceDebugScreen.tsx';
import { InstancesProvider, useInstances } from './state.tsx';
import { useTheme } from './theme.ts';
import { SwitchDialog, VoiceBar } from './voice/ui/VoiceBar.tsx';
import { useVoiceNotice } from './voice/notice.ts';

wireQueryEnvironment();

export default function App() {
  return (
    <SafeAreaProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, maxAge: MAX_AGE_MS, buster: BUSTER }}
      >
        <InstancesProvider>
          <Navigator />
        </InstancesProvider>
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}

/** A small stack: the instance list at the bottom, Android's back button pops. */
const ADD: Route = { name: 'add' };
const SCAN: Route = { name: 'scan' };
const VOICE_DEBUG: Route = { name: 'voice-debug' };

function Navigator() {
  const { dark } = useTheme();
  const { ready, instances } = useInstances();
  const [stack, setStack] = useState<Stack>(INITIAL_STACK);
  const [current, setCurrent] = useState<string | null>(null);
  // Bumped when a room closes: the space behind it reads its unread counts again.
  const [roomsClosed, setRoomsClosed] = useState(0);
  const route = top(stack);
  useVoiceNotice();

  // What the phone saved is only used for servers and users that are signed in now.
  const restoring = useIsRestoring();
  useEffect(() => {
    if (restoring || !ready) return;
    pruneUnknown(
      queryClient,
      instances.flatMap((i) => (i.user ? [{ origin: i.origin, userId: i.user.userId }] : [])),
    );
  }, [restoring, ready, instances]);

  const push = useCallback((next: Route) => setStack((s) => pushStack(s, next)), []);
  const pop = useCallback(() => {
    setStack((s) => popStack(s));
    setRoomsClosed((n) => n + 1);
  }, []);
  const reset = useCallback((next: Route) => setStack(resetStack(next)), []);

  // A session that ended (401, revoked) closes the instance's spaces and rooms.
  const settled = instances.reduce(
    (s, instance) => (instance.user ? s : sessionLost(s, instance.origin)),
    stack,
  );
  if (settled !== stack) setStack(settled);

  const open = useCallback(
    (origin: string, invite?: string) => {
      setCurrent(origin);
      reset(instanceRoute(origin, invite));
    },
    [reset],
  );

  /** An openlive://join link or a scanned code: straight to the instance if it is known. */
  const follow = useCallback(
    (link: Extract<AppLink, { kind: 'join' }>) => {
      if (instances.some((i) => i.origin === link.instance)) open(link.instance, link.invite);
      else reset(addRoute(link.instance, link.invite));
    },
    [instances, open, reset],
  );

  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  // Links wait for the saved instances, to know whether the instance is already there.
  useEffect(() => {
    if (!ready) return;
    const handle = (url: string | null | undefined) => {
      const link = url ? parseAppLink(url) : null;
      if (link?.kind === 'join') followRef.current(link);
    };
    void Linking.getInitialURL().then(handle);
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => subscription.remove();
  }, [ready]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length <= 1) return false;
      pop();
      return true;
    });
    return () => subscription.remove();
  }, [stack.length, pop]);

  const removed = (origin: string) => {
    setCurrent(null);
    setStack((s) => instanceRemoved(s, origin));
  };

  if (!ready) return null;

  let screen;
  switch (route.name) {
    case 'home':
      screen = (
        <HomeScreen
          current={current}
          onOpen={open}
          onAdd={() => push(ADD)}
          onVoiceDebug={() => push(VOICE_DEBUG)}
        />
      );
      break;
    case 'add':
      screen = (
        <AddInstanceScreen
          key={route.origin ?? 'typed'}
          initialOrigin={route.origin}
          onBack={pop}
          onScan={() => push(SCAN)}
          onReady={(origin) => open(origin, route.invite)}
        />
      );
      break;
    case 'scan':
      screen = <ScanScreen onBack={pop} onResult={follow} />;
      break;
    case 'voice-debug':
      screen = <VoiceDebugScreen onBack={pop} />;
      break;
    case 'instance':
      screen = (
        <InstanceScreen
          key={route.origin}
          origin={route.origin}
          invite={route.invite}
          expired={route.expired === true}
          onBack={pop}
          onRemoved={() => removed(route.origin)}
          onInviteDone={() => reset(instanceRoute(route.origin))}
          onOpenSpace={(space) => push(spaceRoute(route.origin, space.id, space.name))}
        />
      );
      break;
    case 'space':
      screen = (
        <SpaceScreen
          key={`${route.origin}/${route.spaceId}`}
          origin={route.origin}
          spaceId={route.spaceId}
          spaceName={route.spaceName}
          serverName={instances.find((i) => i.origin === route.origin)?.name ?? ''}
          refreshKey={roomsClosed}
          onBack={pop}
          onOpenRoom={(roomId, roomName) =>
            push(roomRoute(route.origin, route.spaceId, roomId, roomName))
          }
        />
      );
      break;
    case 'room': {
      const instance = instances.find((i) => i.origin === route.origin);
      if (!instance) return null;
      screen = (
        <RoomScreen
          key={`${route.origin}/${route.roomId}`}
          instance={instance}
          spaceId={route.spaceId}
          roomId={route.roomId}
          roomName={route.roomName}
          onBack={pop}
        />
      );
      break;
    }
  }
  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <View style={{ flex: 1 }}>{screen}</View>
      <VoiceBar
        onOpenRoom={(roomId, link) =>
          push(roomRoute(link.origin, link.spaceId, roomId, link.roomName))
        }
      />
      <SwitchDialog />
    </>
  );
}
