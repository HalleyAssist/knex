const Client = require('../../client');
const { SUPPORTED_CLIENTS } = require('../../constants');

const { getDialectByNameOrAlias } = require('../../dialects');
const { resolveClientNameWithAliases } = require('../../util/helpers');
const PgDialect = require('../../dialects/postgres/index.js');

function resolveConfig(config) {
  let Dialect;
  let resolvedConfig;

  // MH: config must be an object
  const parsedConfig = config;

  // If user provided no relevant parameters, use generic client
  if (
    arguments.length === 0 ||
    (!parsedConfig.client && !parsedConfig.dialect)
  ) {
    Dialect = Client;
  }
  // If user provided Client constructor as a parameter, use it
  else if (typeof parsedConfig.client === 'function') {
    Dialect = parsedConfig.client;
  }
  // If neither applies, let's assume user specified name of a client or dialect as a string
  else {
    const clientName = parsedConfig.client || parsedConfig.dialect;
    if (!SUPPORTED_CLIENTS.includes(clientName)) {
      throw new Error(
        `knex: Unknown configuration option 'client' value ${clientName}. Note that it is case-sensitive, check documentation for supported values.`
      );
    }

    const resolvedClientName = resolveClientNameWithAliases(clientName);
    if (resolvedClientName === 'postgres') {
      // MH: static include for packing
      Dialect = PgDialect;
    } else {
      Dialect = getDialectByNameOrAlias(clientName);
    }
  }

  // If config connection parameter is passed as string, try to parse it
  if (typeof parsedConfig.connection === 'string') {
    resolvedConfig = Object.assign({}, parsedConfig, {
      connection: parseConnection(parsedConfig.connection).connection,
    });
  } else {
    resolvedConfig = Object.assign({}, parsedConfig);
  }

  return {
    resolvedConfig,
    Dialect,
  };
}

module.exports = {
  resolveConfig,
};
