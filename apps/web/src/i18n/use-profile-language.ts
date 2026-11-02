// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { meQuery } from '../api/auth.ts';
import { changeLanguage } from './index.ts';
import { isLanguage } from './language.ts';

/** After sign-in, the language saved in the profile wins over this browser's choice. */
export function useProfileLanguage(): void {
  const { data } = useQuery(meQuery);
  const locale = data?.user.locale;
  useEffect(() => {
    if (isLanguage(locale)) void changeLanguage(locale);
  }, [locale]);
}
