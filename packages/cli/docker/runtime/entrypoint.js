'use strict';

const { spawn } = require('child_process');
const compression = require('compression');
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  BuildEnvironment,
  defaultEnvironmentVariablesPrefix,
  defaultMaxTransactionLogs
} = require('@mockoon/commons');

const MODE = (process.env.MOCKOON_MODE || '').toLowerCase();
const DATA_DIR = process.env.MOCKOON_DATA_DIR || '/data';
const ENV_SUBDIR = process.env.MOCKOON_ENV_SUBDIR || 'environments';
const UI_DIST_DIR =
  process.env.MOCKOON_UI_DIST || path.resolve(__dirname, '..', 'ui');
const API_PREFIX = process.env.MOCKOON_API_PREFIX || '/storage';
const UI_PORT = parseInt(process.env.MOCKOON_UI_PORT || '8080', 10);
const API_BODY_LIMIT = process.env.MOCKOON_API_BODY_LIMIT || '10mb';
const CLI_BINARY = process.env.MOCKOON_CLI_BINARY || 'mockoon-cli';
const CLI_EXTRA_ARGS = parseArgList(process.env.MOCKOON_CLI_EXTRA_ARGS);
const CLI_DISABLE_LOG_TO_FILE = process.env.MOCKOON_DISABLE_LOG_TO_FILE !== 'false';
const CLI_WATCH = process.env.MOCKOON_CLI_WATCH !== 'false';
const CLI_POLLING_INTERVAL =
  process.env.MOCKOON_CLI_POLLING_INTERVAL || process.env.MOCKOON_POLLING_INTERVAL;

const DEFAULT_DATA_FILES =
  process.env.MOCKOON_DATA_FILES || process.env.MOCKOON_DATA_FILE || 'environment.json';
const DEFAULT_PORT = parseInt(process.env.MOCKOON_DEFAULT_PORT || '3000', 10);
const DEFAULT_ENV_NAME =
  process.env.MOCKOON_DEFAULT_ENV_NAME || 'Docker environment';

const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'];

const cliArgsFromProcess = process.argv.slice(2);

if (cliArgsFromProcess.length > 0 || MODE === 'cli') {
  // CLI passthrough mode
  const args =
    cliArgsFromProcess.length > 0 ? cliArgsFromProcess : buildDefaultCliArgs();
  runCli(args);
} else {
  startCombinedMode().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[mockoon] Fatal error while starting runtime', error);
    process.exit(1);
  });
}

function parseArgList(value) {
  if (!value) {
    return [];
  }

  const tokens =
    value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"(.*)"$/, '$1')) ??
    [];

  return tokens.filter(Boolean);
}

function sanitizeStorageKey(value) {
  if (!value) {
    return '';
  }

  const lastSegment = value.replace(/\\/g, '/').split('/').pop() || '';
  const sanitized = lastSegment.replace(/[^a-zA-Z0-9_.-]/g, '');

  return sanitized || lastSegment;
}

function ensureJsonExtension(value) {
  const sanitized = sanitizeStorageKey(value);

  if (!sanitized) {
    return 'environment.json';
  }

  return sanitized.toLowerCase().endsWith('.json')
    ? sanitized
    : `${sanitized}.json`;
}

function buildDefaultCliArgs(resolvedDataFiles) {
  const dataFiles =
    resolvedDataFiles ?? resolveDataFiles(parseDataFileNames(DEFAULT_DATA_FILES));

  if (!dataFiles.length) {
    throw new Error(
      'No data files configured. Set MOCKOON_DATA_FILE(S) or provide CLI arguments.'
    );
  }

  const args = ['start', '--data', ...dataFiles];

  if (CLI_WATCH) {
    args.push('--watch');
  }

  if (CLI_DISABLE_LOG_TO_FILE) {
    args.push('--disable-log-to-file');
  }

  if (CLI_POLLING_INTERVAL) {
    args.push('--polling-interval', `${CLI_POLLING_INTERVAL}`);
  }

  if (CLI_EXTRA_ARGS.length) {
    args.push(...CLI_EXTRA_ARGS);
  }

  return args;
}

function runCli(args) {
  const child = spawn(CLI_BINARY, args, {
    stdio: 'inherit'
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(0);
    } else {
      process.exit(code ?? 0);
    }
  });
}

async function startCombinedMode() {
  const initialState = await ensureInitialState();

  await writeDockerRuntimeConfig(API_PREFIX);

  const cliProcess = spawn(CLI_BINARY, buildDefaultCliArgs(initialState.dataFiles), {
    stdio: 'inherit'
  });

  const app = createServer(initialState);
  const server = app.listen(UI_PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[mockoon] UI available on port ${UI_PORT}, storage API exposed at ${API_PREFIX}`
    );
  });

  let shuttingDown = false;

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    server.close(() => {
      process.exit(exitCode);
    });

    if (cliProcess && !cliProcess.killed) {
      cliProcess.kill('SIGTERM');
    }
  };

  cliProcess.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (signal) {
      shutdown(0);
    } else {
      shutdown(code ?? 0);
    }
  });

  TERMINATION_SIGNALS.forEach((signal) => {
    process.on(signal, () => {
      shutdown(0);
    });
  });

  process.on('uncaughtException', (error) => {
    // eslint-disable-next-line no-console
    console.error('[mockoon] Uncaught exception', error);
    shutdown(1);
  });

  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[mockoon] Unhandled rejection', reason);
    shutdown(1);
  });
}

function parseDataFileNames(value) {
  return value
    .split(',')
    .map((item) => ensureJsonExtension(item.trim()))
    .filter(Boolean);
}

function resolveDataFiles(fileNames) {
  const envDir = path.join(DATA_DIR, ENV_SUBDIR);

  return fileNames.map((fileName) => path.join(envDir, fileName));
}

async function ensureInitialState() {
  const envDir = path.join(DATA_DIR, ENV_SUBDIR);
  const settingsPath = path.join(DATA_DIR, 'settings.json');

  await fsp.mkdir(envDir, { recursive: true });

  const fileNames = parseDataFileNames(DEFAULT_DATA_FILES);
  const resolvedDataFiles = resolveDataFiles(fileNames);

  const descriptors = [];

  for (let index = 0; index < resolvedDataFiles.length; index += 1) {
    const dataFilePath = resolvedDataFiles[index];
    const dataFileName = fileNames[index];

    const environment = await ensureEnvironmentFile(
      dataFilePath,
      dataFileName,
      index
    );

    descriptors.push({
      uuid: environment.uuid,
      path: dataFileName,
      cloud: false,
      lastServerHash: null
    });
  }

  await ensureSettingsFile(settingsPath, descriptors);

  return {
    envDir,
    dataFiles: resolvedDataFiles,
    descriptors,
    settingsPath
  };
}

async function ensureEnvironmentFile(filePath, fileName, index) {
  try {
    await fsp.access(filePath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (!parsed || typeof parsed !== 'object' || !parsed.uuid) {
      throw new Error(
        `Environment file "${fileName}" is missing a valid uuid property.`
      );
    }

    return parsed;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Environment file "${fileName}" could not be parsed: ${error.message}`
        );
      }

      throw error;
    }

    const environment = BuildEnvironment({
      name:
        resolvedDefaultName(index) ||
        `${DEFAULT_ENV_NAME} ${resolvedSuffix(index)}`,
      hasContentTypeHeader: true,
      hasCorsHeaders: true,
      hasDefaultRoute: true,
      port: DEFAULT_PORT + index
    });

    await fsp.writeFile(filePath, JSON.stringify(environment, null, 2), 'utf-8');

    return environment;
  }
}

function resolvedDefaultName(index) {
  if (!process.env.MOCKOON_ENV_NAMES) {
    return null;
  }

  const parts = process.env.MOCKOON_ENV_NAMES.split(',');

  return parts[index] ? parts[index].trim() : null;
}

function resolvedSuffix(index) {
  return index === 0 ? '' : `#${index + 1}`;
}

async function ensureSettingsFile(settingsPath, descriptors) {
  let settingsContent = null;

  try {
    settingsContent = await fsp.readFile(settingsPath, 'utf-8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }

  let settings =
    settingsContent && settingsContent.trim()
      ? parseJsonOrNull(settingsContent)
      : null;

  if (!settings || typeof settings !== 'object') {
    settings = buildDefaultSettings(descriptors);
  } else {
    if (!Array.isArray(settings.environments)) {
      settings.environments = [];
    }

    let changed = false;

    descriptors.forEach((descriptor) => {
      const existing = settings.environments.find(
        (item) => item.uuid === descriptor.uuid
      );

      if (!existing) {
        settings.environments.push(descriptor);
        changed = true;
      } else if (existing.path !== descriptor.path) {
        existing.path = descriptor.path;
        changed = true;
      }
    });

    if (!settings.activeEnvironmentUuid && descriptors.length) {
      settings.activeEnvironmentUuid = descriptors[0].uuid;
      changed = true;
    }

    if (changed) {
      await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    }

    return;
  }

  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function buildDefaultSettings(descriptors) {
  return {
    welcomeShown: true,
    maxLogsPerEnvironment: defaultMaxTransactionLogs,
    truncateRouteName: true,
    mainMenuSize: 100,
    secondaryMenuSize: 200,
    fakerLocale: 'en',
    fakerSeed: null,
    lastChangelog: '0.0.0',
    environments: descriptors,
    disabledRoutes: {},
    collapsedFolders: {},
    enableTelemetry: false,
    storagePrettyPrint: true,
    fileWatcherEnabled: 'disabled',
    dialogWorkingDir: '',
    startEnvironmentsOnLoad: true,
    logTransactions: false,
    environmentsCategoriesOrder: ['local', 'cloud'],
    environmentsCategoriesCollapsed: {
      local: false,
      cloud: false
    },
    envVarsPrefix: defaultEnvironmentVariablesPrefix,
    activeEnvironmentUuid: descriptors.length ? descriptors[0].uuid : null,
    enableRandomLatency: false,
    recentLocalEnvironments: [],
    displayLogsIsoTimestamp: false,
    deployPreferredRegion: null
  };
}

async function writeDockerRuntimeConfig(apiPrefix) {
  const assetsDirectory = path.join(UI_DIST_DIR, 'assets');
  const targetFile = path.join(assetsDirectory, 'docker-config.js');

  await fsp.mkdir(assetsDirectory, { recursive: true });

  const config = {
    storageApiBase: apiPrefix
  };

  const content = `window.__MOCKOON_DOCKER_CONFIG__ = Object.assign({}, window.__MOCKOON_DOCKER_CONFIG__ || {}, ${JSON.stringify(
    config
  )});\n`;

  await fsp.writeFile(targetFile, content, 'utf-8');
}

function createServer(initialState) {
  const app = express();
  const envDir = initialState.envDir;
  const settingsPath = initialState.settingsPath;

  app.disable('x-powered-by');
  app.use(compression());
  app.use(
    express.json({
      limit: API_BODY_LIMIT
    })
  );

  const router = express.Router();

  router.get('/settings', async (_req, res) => {
    try {
      const content = await fsp.readFile(settingsPath, 'utf-8');

      res.json(JSON.parse(content));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        res.status(404).end();
      } else {
        handleServerError(res, error, 'Unable to read settings file');
      }
    }
  });

  router.put('/settings', async (req, res) => {
    try {
      const pretty = isPretty(req);
      const payload = req.body ?? {};

      await fsp.writeFile(
        settingsPath,
        JSON.stringify(payload, null, pretty ? 2 : undefined),
        'utf-8'
      );

      res.status(204).end();
    } catch (error) {
      handleServerError(res, error, 'Unable to write settings file');
    }
  });

  router.get('/environments/:id', async (req, res) => {
    const fileName = ensureJsonExtension(req.params.id);
    const filePath = path.join(envDir, fileName);

    try {
      const content = await fsp.readFile(filePath, 'utf-8');

      res.json(JSON.parse(content));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        res.status(404).end();
      } else if (error instanceof SyntaxError) {
        res
          .status(500)
          .json({ message: `Environment file "${fileName}" is not valid JSON` });
      } else {
        handleServerError(res, error, 'Unable to read environment file');
      }
    }
  });

  router.put('/environments/:id', async (req, res) => {
    const fileName = ensureJsonExtension(req.params.id);
    const filePath = path.join(envDir, fileName);

    try {
      const pretty = isPretty(req);
      const payload = req.body;

      if (!payload || typeof payload !== 'object') {
        res.status(400).json({ message: 'Environment payload is required' });

        return;
      }

      await fsp.writeFile(
        filePath,
        JSON.stringify(payload, null, pretty ? 2 : undefined),
        'utf-8'
      );

      res.status(204).end();
    } catch (error) {
      handleServerError(res, error, 'Unable to write environment file');
    }
  });

  router.delete('/environments/:id', async (req, res) => {
    const fileName = ensureJsonExtension(req.params.id);
    const filePath = path.join(envDir, fileName);

    try {
      await fsp.rm(filePath);
      res.status(204).end();
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        res.status(404).end();
      } else {
        handleServerError(res, error, 'Unable to delete environment file');
      }
    }
  });

  app.use(API_PREFIX, router);

  app.use(
    express.static(UI_DIST_DIR, {
      index: false,
      cacheControl: false,
      fallthrough: true
    })
  );

  app.get('*', async (_req, res, next) => {
    try {
      res.sendFile(path.join(UI_DIST_DIR, 'index.html'));
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    handleServerError(res, error, 'Unexpected server error');
  });

  return app;
}

function isPretty(req) {
  const value = req.query?.pretty;

  if (value === undefined) {
    return true;
  }

  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true';
  }

  return false;
}

function handleServerError(res, error, defaultMessage) {
  // eslint-disable-next-line no-console
  console.error('[mockoon] storage API error:', defaultMessage, error);

  res.status(500).json({
    message: defaultMessage
  });
}
