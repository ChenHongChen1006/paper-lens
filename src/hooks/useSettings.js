// useSettings — small React hook wrapping storage.js's settings table so
// pages can read/write API key, model, and research background without
// each re-implementing the same load/save boilerplate.

import { useCallback, useEffect, useState } from 'react';
import { getAllSettings, setSetting } from '../lib/storage.js';

export function useSettings() {
  const [settings, setSettings] = useState(null);

  const reload = useCallback(async () => {
    const s = await getAllSettings();
    setSettings(s);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const update = useCallback(async (key, value) => {
    await setSetting(key, value);
    setSettings((prev) => ({ ...(prev || {}), [key]: value }));
  }, []);

  return { settings, reload, update };
}
