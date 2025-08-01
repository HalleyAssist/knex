// Migrator
// -------
const differenceWith = require('lodash/differenceWith');
const get = require('lodash/get');
const isEmpty = require('lodash/isEmpty');
const max = require('lodash/max');
const {
  getLockTableName,
  getTable,
  getTableName,
} = require('./table-resolver');
const { getSchemaBuilder } = require('./table-creator');
const migrationListResolver = require('./migration-list-resolver');
const MigrationGenerator = require('./MigrationGenerator');
const { getMergedConfig } = require('./migrator-configuration-merger');
const { isBoolean, isFunction } = require('../../util/is');

class LockError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'MigrationLocked';
  }
}

// The new migration we're performing, typically called from the `knex.migrate`
// interface on the main `knex` object. Passes the `knex` instance performing
// the migration.
class Migrator {
  constructor(knex) {
    // Clone knex instance and remove post-processing that is unnecessary for internal queries from a cloned config
    if (isFunction(knex)) {
      if (!knex.isTransaction) {
        this.knex = knex.withUserParams({
          ...knex.userParams,
        });
      } else {
        this.knex = knex;
      }
    } else {
      this.knex = Object.assign({}, knex);
      this.knex.userParams = this.knex.userParams || {};
    }

    this.config = getMergedConfig(
      this.knex.client.config.migrations,
      undefined,
      this.knex.client.logger
    );
    this.generator = new MigrationGenerator(
      this.knex.client.config.migrations,
      this.knex.client.logger
    );
    this._activeMigration = {
      fileName: null,
    };
  }

  // Migrators to the latest configuration.
  async latest(config) {
    this._disableProcessing();
    this.config = getMergedConfig(config, this.config, this.knex.client.logger);

    const allAndCompleted = await migrationListResolver.listAllAndCompleted(
      this.config,
      this.knex
    );

    if (!this.config.disableMigrationsListValidation) {
      validateMigrationList(this.config.migrationSource, []);
    }

    const [all, completed] = allAndCompleted;

    const migrations = getNewMigrations(
      this.config.migrationSource,
      all,
      completed
    );

    const transactionForAll =
      !this.config.disableTransactions &&
      !(
        await Promise.all(
          migrations.map(async (migration) => {
            const migrationContents =
              await this.config.migrationSource.getMigration(migration);
            return !this._useTransaction(migrationContents);
          })
        )
      ).some((isTransactionUsed) => isTransactionUsed);

    if (transactionForAll) {
      return this.knex.transaction((trx) => {
        return this._runBatch(migrations, 'up', trx);
      });
    } else {
      return this._runBatch(migrations, 'up');
    }
  }

  // Runs the next migration that has not yet been run
  async up(config) {
    this._disableProcessing();
    this.config = getMergedConfig(config, this.config, this.knex.client.logger);

    const allAndCompleted = await migrationListResolver.listAllAndCompleted(
      this.config,
      this.knex
    );

    if (!this.config.disableMigrationsListValidation) {
      validateMigrationList(this.config.migrationSource, []);
    }
    const [all, completed] = allAndCompleted;

    const newMigrations = getNewMigrations(
      this.config.migrationSource,
      all,
      completed
    );

    let migrationToRun;
    const name = this.config.name;
    if (name) {
      if (!completed.includes(name)) {
        migrationToRun = newMigrations.find((migration) => {
          return (
            this.config.migrationSource.getMigrationName(migration) === name
          );
        });
        if (!migrationToRun) {
          throw new Error(`Migration "${name}" not found.`);
        }
      }
    } else {
      migrationToRun = newMigrations[0];
    }

    const useTransaction =
      !migrationToRun ||
      this._useTransaction(
        await this.config.migrationSource.getMigration(migrationToRun)
      );

    const migrationsToRun = [];
    if (migrationToRun) {
      migrationsToRun.push(migrationToRun);
    }

    const transactionForAll =
      !this.config.disableTransactions && (!migrationToRun || useTransaction);

    if (transactionForAll) {
      return await this.knex.transaction((trx) => {
        return this._runBatch(migrationsToRun, 'up', trx);
      });
    } else {
      return await this._runBatch(migrationsToRun, 'up');
    }
  }

  // Rollback the last "batch", or all, of migrations that were run.
  rollback(config, all = false) {
    this._disableProcessing();
    return new Promise((resolve, reject) => {
      try {
        this.config = getMergedConfig(
          config,
          this.config,
          this.knex.client.logger
        );
      } catch (e) {
        reject(e);
      }
      migrationListResolver
        .listAllAndCompleted(this.config, this.knex)
        .then((value) => {
          if (!this.config.disableMigrationsListValidation) {
            validateMigrationList(this.config.migrationSource, value);
          }
          return value;
        })
        .then((val) => {
          const [allMigrations, completedMigrations] = val;

          return all
            ? allMigrations
                .filter((migration) => {
                  return completedMigrations
                    .map((migration) => migration.name)
                    .includes(
                      this.config.migrationSource.getMigrationName(migration)
                    );
                })
                .reverse()
            : this._getLastBatch(val);
        })
        .then((migrations) => {
          return this._runBatch(migrations, 'down');
        })
        .then(resolve, reject);
    });
  }

  down(config) {
    this._disableProcessing();
    this.config = getMergedConfig(config, this.config, this.knex.client.logger);

    return migrationListResolver
      .listAllAndCompleted(this.config, this.knex)
      .then((value) => {
        if (!this.config.disableMigrationsListValidation) {
          validateMigrationList(this.config.migrationSource, value);
        }
        return value;
      })
      .then(([all, completed]) => {
        const completedMigrations = all.filter((migration) => {
          return completed
            .map((migration) => migration.name)
            .includes(this.config.migrationSource.getMigrationName(migration));
        });

        let migrationToRun;
        const name = this.config.name;
        if (name) {
          migrationToRun = completedMigrations.find((migration) => {
            return (
              this.config.migrationSource.getMigrationName(migration) === name
            );
          });
          if (!migrationToRun) {
            throw new Error(`Migration "${name}" was not run.`);
          }
        } else {
          migrationToRun = completedMigrations[completedMigrations.length - 1];
        }

        const migrationsToRun = [];
        if (migrationToRun) {
          migrationsToRun.push(migrationToRun);
        }

        return this._runBatch(migrationsToRun, 'down');
      });
  }

  status(config) {
    this._disableProcessing();
    this.config = getMergedConfig(config, this.config, this.knex.client.logger);

    return Promise.all([
      getTable(this.knex, this.config.tableName, this.config.schemaName).select(
        '*'
      ),
      migrationListResolver.listAll(this.config.migrationSource),
    ]).then(([db, code]) => db.length - code.length);
  }

  // Retrieves and returns the current migration version we're on, as a promise.
  // If no migrations have been run yet, return "none".
  currentVersion(config) {
    this._disableProcessing();
    this.config = getMergedConfig(config, this.config, this.knex.client.logger);

    return migrationListResolver
      .listCompleted(this.config.tableName, this.config.schemaName, this.knex)
      .then((completed) => {
        const val = max(completed.map((value) => value.name.split('_')[0]));
        return val === undefined ? 'none' : val;
      });
  }

  // list all migrations
  async list(config) {
    this._disableProcessing();
    this.config = getMergedConfig(config, this.config, this.knex.client.logger);

    const [all, completed] = await migrationListResolver.listAllAndCompleted(
      this.config,
      this.knex
    );

    if (!this.config.disableMigrationsListValidation) {
      validateMigrationList(this.config.migrationSource, [all, []]);
    }

    const newMigrations = getNewMigrations(
      this.config.migrationSource,
      all,
      completed
    );
    return [completed, newMigrations];
  }

  async forceFreeMigrationsLock(config) {
    this._disableProcessing();
    this.config = getMergedConfig(config, this.config, this.knex.client.logger);
    const { schemaName, tableName } = this.config;
    const lockTableName = getLockTableName(tableName);
    const { knex } = this;
    const getLockTable = () => getTable(knex, lockTableName, schemaName);
    const tableExists = await getSchemaBuilder(knex, schemaName).hasTable(
      lockTableName
    );
    if (tableExists) {
      await getLockTable().del();
      await getLockTable().insert({
        is_locked: 0,
      });
    }
  }

  // Creates a new migration, with a given name.
  make(name, config) {
    return this.generator.make(name, config, this.knex.client.logger);
  }

  _disableProcessing() {
    if (this.knex.disableProcessing) {
      this.knex.disableProcessing();
    }
  }

  _lockMigrations(trx) {
    const tableName = getLockTableName(this.config.tableName);
    return getTable(this.knex, tableName, this.config.schemaName)
      .transacting(trx)
      .where('is_locked', '=', 0)
      .update({ is_locked: 1 })
      .then((rowCount) => {
        if (rowCount !== 1) {
          throw new Error('Migration table is already locked');
        }
      });
  }

  _getLock(trx) {
    const transact = trx ? (fn) => fn(trx) : (fn) => this.knex.transaction(fn);
    return transact((trx) => {
      return this._lockMigrations(trx);
    }).catch((err) => {
      throw new LockError(err.message);
    });
  }

  _freeLock(trx = this.knex) {
    const tableName = getLockTableName(this.config.tableName);
    return getTable(trx, tableName, this.config.schemaName).update({
      is_locked: 0,
    });
  }

  // Run a batch of current migrations, in sequence.
  async _runBatch(migrations, direction, trx) {
    const canGetLockInTransaction =
      this.knex.client.driverName !== 'cockroachdb';
    try {
      await this._getLock(canGetLockInTransaction ? trx : undefined);
      // When there is a wrapping transaction, some migrations
      // could have been done while waiting for the lock:
      const completed = trx
        ? await migrationListResolver.listCompleted(
            this.config.tableName,
            this.config.schemaName,
            trx
          )
        : [];

      migrations = getNewMigrations(
        this.config.migrationSource,
        migrations,
        completed
      );

      await Promise.all(
        migrations.map(this._validateMigrationStructure.bind(this))
      );

      let batchNo = await this._latestBatchNumber(trx);
      if (direction === 'up') batchNo++;

      // Run any hooks before/after this batch
      const beforeAll = this.config.beforeAll || (() => {});
      const afterAll = this.config.afterAll || (() => {});

      let res = [];
      if (migrations.length > 0) {
        await beforeAll(trx || this.knex, migrations);
        res = await this._waterfallBatch(batchNo, migrations, direction, trx);
        await afterAll(trx || this.knex, migrations);
      }

      await this._freeLock(canGetLockInTransaction ? trx : undefined);
      return res;
    } catch (error) {
      let cleanupReady = Promise.resolve();

      if (error instanceof LockError) {
        // If locking error do not free the lock.
        this.knex.client.logger.warn(
          `Can't take lock to run migrations: ${error.message}`
        );
        this.knex.client.logger.warn(
          'If you are sure migrations are not running you can release the ' +
            "lock manually by running 'knex migrate:unlock'"
        );
      } else {
        if (this._activeMigration.fileName) {
          this.knex.client.logger.warn(
            `migration file "${this._activeMigration.fileName}" failed`
          );
        }
        this.knex.client.logger.warn(
          `migration failed with error: ${error.message}`
        );
        // If the error was not due to a locking issue, then remove the lock.
        cleanupReady = this._freeLock(
          canGetLockInTransaction ? trx : undefined
        );
      }

      try {
        await cleanupReady;
        // eslint-disable-next-line no-empty
      } catch (e) {}
      throw error;
    }
  }

  // Validates some migrations by requiring and checking for an `up` and `down`
  // function.
  async _validateMigrationStructure(migration) {
    const migrationName =
      this.config.migrationSource.getMigrationName(migration);
    // maybe promise
    const migrationContent = await this.config.migrationSource.getMigration(
      migration
    );
    if (typeof migrationContent.up !== 'function') {
      throw new Error(
        `Invalid migration: ${migrationName} must have an up function`
      );
    }

    return migration;
  }

  // Get the last batch of migrations, by name, ordered by insert id in reverse
  // order.
  async _getLastBatch([allMigrations]) {
    const { tableName, schemaName } = this.config;
    const migrationNames = await getTable(this.knex, tableName, schemaName)
      .where('batch', function (qb) {
        qb.max('batch').from(getTableName(tableName, schemaName));
      })
      .orderBy('id', 'desc');

    const lastBatchMigrations = migrationNames.map((migration) => {
      return allMigrations.find((entry) => {
        return (
          this.config.migrationSource.getMigrationName(entry) === migration.name
        );
      });
    });
    return Promise.all(lastBatchMigrations);
  }

  // Returns the latest batch number.
  _latestBatchNumber(trx = this.knex) {
    return trx
      .from(getTableName(this.config.tableName, this.config.schemaName))
      .max('batch as max_batch')
      .then((obj) => obj[0].max_batch || 0);
  }

  // If transaction config for a single migration is defined, use that.
  // Otherwise, rely on the common config. This allows enabling/disabling
  // transaction for a single migration at will, regardless of the common
  // config.
  _useTransaction(migrationContent, allTransactionsDisabled) {
    const singleTransactionValue = get(migrationContent, 'config.transaction');

    return isBoolean(singleTransactionValue)
      ? singleTransactionValue
      : !allTransactionsDisabled;
  }

  // Runs a batch of `migrations` in a specified `direction`, saving the
  // appropriate database information as the migrations are run.
  _waterfallBatch(batchNo, migrations, direction, trx) {
    const trxOrKnex = trx || this.knex;
    const { tableName, schemaName, disableTransactions } = this.config;
    let current = Promise.resolve();
    const log = [];
    migrations.forEach((migration) => {
      const name = this.config.migrationSource.getMigrationName(migration);
      this._activeMigration.fileName = name;
      const migrationContent =
        this.config.migrationSource.getMigration(migration);

      const beforeEach = this.config.beforeEach || (() => {});
      const afterEach = this.config.afterEach || (() => {});

      // We're going to run each of the migrations in the current "up".
      current = current
        .then(async () => await migrationContent) //maybe promise
        .then(async (migrationContent) => {
          this._activeMigration.fileName = name;
          if (
            !trx &&
            this._useTransaction(migrationContent, disableTransactions)
          ) {
            this.knex.enableProcessing();
            return await this.knex.transaction(async (trx) => {
              await beforeEach(trx, [migration]);
              const migrationResult = await checkPromise(
                this.knex.client.logger,
                migrationContent[direction](trx),
                name
              );
              await afterEach(trx, [migration]);
              return migrationResult;
            });
          }

          trxOrKnex.enableProcessing();
          await beforeEach(trxOrKnex, [migration]);
          const migrationResult = await checkPromise(
            this.knex.client.logger,
            migrationContent[direction](trxOrKnex),
            name
          );
          await afterEach(trxOrKnex, [migration]);
          return migrationResult;
        })
        .then(() => {
          trxOrKnex.disableProcessing();
          this.knex.disableProcessing();
          log.push(name);
          if (direction === 'up') {
            return trxOrKnex.into(getTableName(tableName, schemaName)).insert({
              name,
              batch: batchNo,
              migration_time: new Date(),
            });
          }
          if (direction === 'down') {
            return trxOrKnex
              .from(getTableName(tableName, schemaName))
              .where({ name })
              .del();
          }
        });
    });

    return current.then(() => [batchNo, log]);
  }

  _transaction(knex, migrationContent, direction, name) {
    return knex.transaction((trx) => {
      return checkPromise(
        knex.client.logger,
        migrationContent[direction](trx),
        name,
        () => {
          trx.commit();
        }
      );
    });
  }
}

// Validates that migrations are present in the appropriate directories.
function validateMigrationList(migrationSource, migrations) {
  const [all, completed] = migrations;
  const diff = getMissingMigrations(migrationSource, completed, all);
  if (!isEmpty(diff)) {
    const names = diff.map((d) => d.name);
    throw new Error(
      `The migration directory is corrupt, the following files are missing: ${names.join(
        ', '
      )}`
    );
  }
}

function getMissingMigrations(migrationSource, completed, all) {
  return differenceWith(completed, all, (c, a) => {
    return c.name === migrationSource.getMigrationName(a);
  });
}

function getNewMigrations(migrationSource, all, completed) {
  let lastestVersion = max(
    completed.map((c) => parseInt(c.name.split('_')[0]))
  );

  if (!lastestVersion) {
    return all;
  }

  let ret = [];
  for (const a of all) {
    const version = parseInt(migrationSource.getMigrationName(a).split('_')[0]);
    if (version > lastestVersion) {
      ret.push(a);
    }
  }

  return ret;
}

function checkPromise(logger, migrationPromise, name) {
  if (!migrationPromise || typeof migrationPromise.then !== 'function') {
    logger.warn(`migration ${name} did not return a promise`);
  }
  return migrationPromise;
}

module.exports = {
  Migrator,
};
