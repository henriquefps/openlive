// SPDX-License-Identifier: AGPL-3.0-only
import enShared from '@openlive/client/locales/en/translation.json';
import ptBRShared from '@openlive/client/locales/pt-BR/translation.json';

// The player's text: the shared `player.*` strings (@openlive/client, the same the web shows for
// the screens, the queue and the stats) plus the few the phone adds.

export const playerTexts = {
  en: {
    player: enShared.player,
    mobile: {
      player: {
        title: 'Stream',
        landscape: 'Landscape',
        portrait: 'Portrait',
        quality: 'Quality',
        stats: 'Stats',
        mute: 'Mute',
        unmute: 'Unmute',
        volumeDown: 'Volume down',
        volumeUp: 'Volume up',
        background: {
          title: 'Paused while the app was away',
          description:
            'The stream stopped and your slot went back to the room. Open the app again to keep watching.',
        },
        signedOut: 'Your sign-in on this instance expired. Sign in again from the instance screen.',
      },
    },
  },
  'pt-BR': {
    player: ptBRShared.player,
    mobile: {
      player: {
        title: 'Transmissão',
        landscape: 'Paisagem',
        portrait: 'Retrato',
        quality: 'Qualidade',
        stats: 'Estatísticas',
        mute: 'Silenciar',
        unmute: 'Ativar o som',
        volumeDown: 'Diminuir o volume',
        volumeUp: 'Aumentar o volume',
        background: {
          title: 'Pausado enquanto o app esteve fora',
          description:
            'A transmissão parou e sua vaga voltou para a sala. Abra o app de novo para continuar assistindo.',
        },
        signedOut: 'Seu login nesta instância expirou. Entre de novo pela tela da instância.',
      },
    },
  },
} as const;
