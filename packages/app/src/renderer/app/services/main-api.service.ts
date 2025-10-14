import { Injectable } from '@angular/core';
import { Environment } from '@mockoon/commons';
import { MainAPIModel } from 'src/renderer/app/models/main-api.model';
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue
} from 'electron';
import {
  EnvironmentDescriptor,
  Settings
} from 'src/shared/models/settings.model';

type DockerRuntimeConfig = {
  storageApiBase?: string;
};

declare global {
  interface Window {
    __MOCKOON_DOCKER_CONFIG__?: DockerRuntimeConfig;
  }
}

/**
 * Main API service used to emulate calls to Electron's main process (preload + ipc.ts) in the web version
 *
 * This implementation keeps IndexedDB/localStorage persistence for the default web build
 * while optionally delegating data access to a storage API when running inside the Docker
 * runtime. The storage API URL is provided through the window.__MOCKOON_DOCKER_CONFIG__ global.
 */
@Injectable({ providedIn: 'root' })
export class MainApiService implements MainAPIModel {
  private readonly dbName = 'mockoon-db';
  // version can be always 1 as migrations are handled by the environment schema/migrationId
  // Also, the web app is always up to date with the latest schema and first user to connect migrates the envs
  private readonly dbVersion = 1;
  private readonly environmentStoreName = 'environments';

  private readonly storageApiBase: string | null;
  private readonly useStorageApi: boolean;

  constructor() {
    const dockerConfig =
      typeof window !== 'undefined' && window.__MOCKOON_DOCKER_CONFIG__
        ? window.__MOCKOON_DOCKER_CONFIG__
        : {};

    this.storageApiBase = this.normalizeApiBase(dockerConfig.storageApiBase);
    this.useStorageApi = !!this.storageApiBase;
  }

  public invoke(
    channel: 'APP_READ_ENVIRONMENT_DATA',
    path: string
  ): Promise<Environment>;
  public invoke(channel: 'APP_READ_SETTINGS_DATA'): Promise<Settings>;
  public invoke(
    channel: 'APP_WRITE_ENVIRONMENT_DATA',
    data: Environment,
    descriptor: EnvironmentDescriptor,
    storagePrettyPrint?: boolean
  ): Promise<void>;
  public invoke(
    channel: 'APP_DELETE_ENVIRONMENT_DATA',
    path: string
  ): Promise<void>;
  public invoke(
    channel: 'APP_WRITE_SETTINGS_DATA',
    newSettings: Settings,
    storagePrettyPrint?: boolean
  ): Promise<void>;
  public invoke(channel: 'APP_READ_CLIPBOARD'): Promise<any>;
  public invoke(
    channel: 'APP_SHOW_OPEN_DIALOG',
    options: OpenDialogOptions
  ): Promise<OpenDialogReturnValue>;
  public invoke(
    channel: 'APP_SHOW_SAVE_DIALOG',
    options: SaveDialogOptions
  ): Promise<SaveDialogReturnValue>;
  public invoke(
    channel:
      | 'APP_GET_MIME_TYPE'
      | 'APP_GET_HASH'
      | 'APP_GET_FILENAME'
      | 'APP_READ_FILE'
      | 'APP_BUILD_STORAGE_FILEPATH'
      | 'APP_GET_BASE_PATH'
      | 'APP_REPLACE_FILEPATH_EXTENSION',
    pathOrNameOrString: string
  ): Promise<string>;
  public invoke(
    channel: 'APP_WRITE_FILE',
    path: string,
    data: string
  ): Promise<void>;
  public invoke(
    channel: 'APP_SERVER_GET_PROCESSED_DATABUCKET_VALUE',
    environmentUuid: string,
    databucketUuid: string
  ): Promise<any>;
  public invoke(
    channel: 'APP_START_SERVER',
    environment: Environment,
    environmentPath: string
  ): Promise<any>;
  public invoke(
    channel: 'APP_STOP_SERVER' | 'APP_UNWATCH_FILE',
    uuid: string
  ): Promise<void>;
  public invoke(channel: 'APP_GET_OS'): Promise<NodeJS.Platform>;
  public invoke(channel: 'APP_UNWATCH_ALL_FILE'): Promise<void>;
  public invoke(channel: string, ...data: any[]): Promise<any> {
    return this.dispatch(channel, data);
  }

  public send(channel: string, ...data: any[]) {
    return new Promise<any>((resolve) => {
      switch (channel) {
        case 'APP_WRITE_CLIPBOARD':
          if (navigator.clipboard) {
            navigator.clipboard.writeText(data[0]);
          }
          break;

        case 'APP_LOGS': {
          // log similarly to main process (which uses winston)
          const log = data[0] as {
            type: 'info' | 'error';
            message: string;
            payload?: any;
          };

          const consoleMessage = {
            timestamp: new Date().toISOString(),
            level: log.type,
            app: 'mockoon-web',
            message: log.message,
            ...log.payload
          };

          if (log.type === 'error') {
            // eslint-disable-next-line no-console
            console.error(consoleMessage);
          } else if (log.type === 'info') {
            // eslint-disable-next-line no-console
            console.log(consoleMessage);
          }
          break;
        }
        default:
          break;
      }

      resolve(undefined);
    });
  }

  public receive(_channel: string, _callback: (...args: any[]) => void) {
    /* noop */
  }

  private async dispatch(channel: string, data: any[]) {
    switch (channel) {
      case 'APP_READ_ENVIRONMENT_DATA':
        return await this.readEnvironmentData(data[0] as string);
      case 'APP_WRITE_ENVIRONMENT_DATA':
        return await this.writeEnvironmentData(
          data[0] as Environment,
          data[1] as EnvironmentDescriptor | undefined,
          data[2] as boolean | undefined
        );
      case 'APP_DELETE_ENVIRONMENT_DATA':
        return await this.deleteEnvironmentData(data[0] as string);
      case 'APP_READ_SETTINGS_DATA':
        return await this.readSettingsData();
      case 'APP_WRITE_SETTINGS_DATA':
        return await this.writeSettingsData(
          data[0] as Settings,
          data[1] as boolean | undefined
        );
      case 'APP_BUILD_STORAGE_FILEPATH':
        return this.buildStorageFilePath(data[0] as string);
      case 'APP_GET_HASH': {
        const msgUint8 = new TextEncoder().encode(data[0]);

        return window.crypto.subtle
          .digest('SHA-1', msgUint8)
          .then((hashBuffer) => {
            const hashArray = Array.from(new Uint8Array(hashBuffer));

            return hashArray
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
          });
      }
      case 'APP_GET_FILENAME':
        return this.extractFileName(data[0] as string);
      case 'APP_GET_OS': {
        // use same names as in electron
        const platform: string = (
          navigator?.['userAgentData']?.platform ??
          navigator.platform ??
          'unknown'
        ).toLowerCase();

        if (platform.includes('win')) {
          return 'win32';
        } else if (platform.includes('mac')) {
          return 'darwin';
        } else if (platform.includes('linux')) {
          return 'linux';
        } else {
          return 'unknown';
        }
      }
      case 'APP_READ_CLIPBOARD':
        return navigator.clipboard?.readText() ?? '';
      default:
        return undefined;
    }
  }

  private normalizeApiBase(base?: string): string | null {
    if (!base) {
      return null;
    }

    const trimmed = base.trim();

    if (!trimmed) {
      return null;
    }

    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  }

  private ensureStorageKey(value: string): string {
    if (!value) {
      return '';
    }

    const lastSegment = value.replaceAll('\\', '/').split('/').pop() ?? '';
    const sanitized = lastSegment.replace(/[^a-zA-Z0-9_.-]/g, '');

    return sanitized || lastSegment;
  }

  private buildEnvironmentUrl(path: string, pretty = false): string {
    if (!this.storageApiBase) {
      throw new Error('Storage API not configured');
    }

    const key = this.ensureStorageKey(path);
    let url = `${this.storageApiBase}/environments/${encodeURIComponent(key)}`;

    if (pretty) {
      url += url.includes('?') ? '&pretty=1' : '?pretty=1';
    }

    return url;
  }

  private buildSettingsUrl(pretty = false): string {
    if (!this.storageApiBase) {
      throw new Error('Storage API not configured');
    }

    let url = `${this.storageApiBase}/settings`;

    if (pretty) {
      url += '?pretty=1';
    }

    return url;
  }

  private buildStorageFilePath(name: string): string {
    if (this.useStorageApi) {
      const sanitized = this.ensureStorageKey(name).replace(/\.json$/i, '');

      return `${sanitized || 'environment'}.json`;
    }

    return name;
  }

  private extractFileName(path: string): string {
    if (!path) {
      return '';
    }

    const lastSegment = path.replaceAll('\\', '/').split('/').pop() ?? '';

    return lastSegment.replace(/\.json$/i, '');
  }

  private async readEnvironmentData(
    path: string
  ): Promise<Environment | undefined> {
    if (this.useStorageApi) {
      try {
        const response = await fetch(this.buildEnvironmentUrl(path), {
          cache: 'no-store'
        });

        if (response.status === 404) {
          return undefined;
        }

        if (!response.ok) {
          throw new Error(
            `Unable to read environment (${response.statusText || response.status})`
          );
        }

        return (await response.json()) as Environment;
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error('Unable to read environment');
      }
    }

    return await this.readEnvironmentDataIndexedDb(path);
  }

  private async writeEnvironmentData(
    environment: Environment,
    descriptor?: EnvironmentDescriptor,
    storagePrettyPrint?: boolean
  ): Promise<void> {
    if (this.useStorageApi) {
      const targetPath = descriptor?.path ?? environment.uuid;

      try {
        const response = await fetch(
          this.buildEnvironmentUrl(targetPath, storagePrettyPrint === true),
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            cache: 'no-store',
            body: JSON.stringify(environment)
          }
        );

        if (!response.ok) {
          throw new Error(
            `Unable to write environment (${response.statusText || response.status})`
          );
        }
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error('Unable to write environment');
      }

      return;
    }

    await this.writeEnvironmentDataIndexedDb(environment);
  }

  private async deleteEnvironmentData(path: string): Promise<void> {
    if (this.useStorageApi) {
      try {
        const response = await fetch(this.buildEnvironmentUrl(path), {
          method: 'DELETE',
          cache: 'no-store'
        });

        if (response.status === 404 || response.status === 204) {
          return;
        }

        if (!response.ok) {
          throw new Error(
            `Unable to delete environment (${response.statusText || response.status})`
          );
        }
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error('Unable to delete environment');
      }

      return;
    }

    await this.deleteEnvironmentDataIndexedDb(path);
  }

  private async readSettingsData(): Promise<Settings | null> {
    if (this.useStorageApi) {
      try {
        const response = await fetch(this.buildSettingsUrl(), {
          cache: 'no-store'
        });

        if (response.status === 404) {
          return null;
        }

        if (!response.ok) {
          throw new Error(
            `Unable to read settings (${response.statusText || response.status})`
          );
        }

        return (await response.json()) as Settings;
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error('Unable to read settings');
      }
    }

    const raw = localStorage.getItem('appSettings');

    return raw ? (JSON.parse(raw) as Settings) : null;
  }

  private async writeSettingsData(
    settings: Settings,
    storagePrettyPrint?: boolean
  ): Promise<void> {
    if (this.useStorageApi) {
      try {
        const response = await fetch(
          this.buildSettingsUrl(storagePrettyPrint === true),
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            cache: 'no-store',
            body: JSON.stringify(settings)
          }
        );

        if (!response.ok) {
          throw new Error(
            `Unable to write settings (${response.statusText || response.status})`
          );
        }
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error('Unable to write settings');
      }

      return;
    }

    localStorage.setItem('appSettings', JSON.stringify(settings));
  }

  private connectToIndexedDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const openRequest = indexedDB.open(this.dbName, this.dbVersion);

      openRequest.onupgradeneeded = (openRequestEvent) => {
        const db = (openRequestEvent.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.environmentStoreName)) {
          db.createObjectStore(this.environmentStoreName, { keyPath: 'uuid' });
        }
      };

      openRequest.onsuccess = (openRequestEvent) => {
        resolve((openRequestEvent.target as IDBOpenDBRequest).result);
      };

      openRequest.onerror = (openRequestErrorEvent) => {
        reject((openRequestErrorEvent.target as any).error);
      };
    });
  }

  private async deleteEnvironmentDataIndexedDb(
    environmentUuid: string
  ): Promise<void> {
    const db = await this.connectToIndexedDB();

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [this.environmentStoreName],
        'readwrite'
      );
      const store = transaction.objectStore(this.environmentStoreName);
      const deleteRequest = store.delete(environmentUuid);

      deleteRequest.onsuccess = () => {
        resolve();
      };
      deleteRequest.onerror = (event) => {
        reject((event.target as any).error);
      };

      transaction.oncomplete = () => db.close();
    });
  }

  private async writeEnvironmentDataIndexedDb(
    environment: Environment
  ): Promise<void> {
    const db = await this.connectToIndexedDB();

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [this.environmentStoreName],
        'readwrite'
      );

      transaction.oncomplete = () => db.close();
      transaction.onerror = (event) => {
        reject((event.target as any).error);
      };

      const store = transaction.objectStore(this.environmentStoreName);
      const addRequest = store.put(environment);

      addRequest.onsuccess = () => {
        resolve();
      };
      addRequest.onerror = (event_1) => {
        reject((event_1.target as any).error);
      };
    });
  }

  private async readEnvironmentDataIndexedDb(
    uuid: string
  ): Promise<Environment | undefined> {
    const db = await this.connectToIndexedDB();

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [this.environmentStoreName],
        'readonly'
      );
      const store = transaction.objectStore(this.environmentStoreName);
      const getRequest = store.get(uuid);

      getRequest.onsuccess = (event) => {
        resolve((event.target as any).result);
      };
      getRequest.onerror = (event_1) => {
        reject((event_1.target as any).error);
      };

      transaction.oncomplete = () => db.close();
    });
  }
}
