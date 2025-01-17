import MemoryStorage from './memoryStorage';
import * as keys from './constants';

const isSupported = () => {
  try {
    window.localStorage.setItem('local_storage_supported', '1');
    const result = window.localStorage.getItem('local_storage_supported');
    window.localStorage.removeItem('local_storage_supported');
    return result === '1';
  } catch (error) {
    return false;
  }
};

const storage = isSupported() ? window.localStorage : MemoryStorage;

export const getItem = (key: String, defaultValue: any = null) => {
  const value = storage.getItem(key);

  try {
    return JSON.parse(value) || defaultValue;
  } catch (SyntaxError) {
    return value || defaultValue;
  }
};

export const getItemWithExpiry = (key: String, defaultValue: any = null) => {
  const rawExpiry = getItem(key, null);

  if (!rawExpiry) {
    return defaultValue;
  }

  // compare the expiry time of the item with the current time
  if ((new Date()).getTime() > rawExpiry.expiry) {
    // eslint-disable-next-line
    removeItem(key);
    return defaultValue;
  }

  return rawExpiry.value;
};

export const getRawItem = (key: String) => storage.getItem(key);

export const setItem = (key: String, value: any) =>
  storage.setItem(
    key,
    typeof value === 'string' ? value : JSON.stringify(value)
  );

export const setItemWithExpiry = (key: String, value: any, ttl: number) =>
  setItem(
    key,
    {
      value,
      expiry: (new Date()).getTime() + ttl,
    }
  );

export const removeItem = (key: String) => {
  setItem(key, ''); // Due to some versions of browser bug can't removeItem correctly.
  storage.removeItem(key);
};

export const isLatestLocalStorageVersion = () => {
  const LOCAL_STORAGE_VERSION = keys.LOCAL_STORAGE_VERSION;
  const localVersion = getItem(keys.KEY_LOCAL_STORAGE_VERSION);
  return LOCAL_STORAGE_VERSION === localVersion;
};

export const removeOutdatedKeys = () => {
  if (isLatestLocalStorageVersion()) return;

  setItem(keys.KEY_LOCAL_STORAGE_VERSION, keys.LOCAL_STORAGE_VERSION);

  const localDexscanKeys = Object.keys(localStorage).filter(key => key.indexOf('flow.') === 0);

  // Using 'Object.values()' fails unit testing because some browsers don't support it
  const dexscanKeys = Object.keys(keys).map(it => keys[it]);

  localDexscanKeys.forEach((localCobKey) => {
    const hasMatch = dexscanKeys.some(key => key === localCobKey);
    if (!hasMatch) {
      localStorage.removeItem(localCobKey);
    }
  });
};
