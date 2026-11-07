const { MemoryStore } = require('./memory');
const { MongoStore } = require('./mongo');

async function createStore(config) {
  if (config.mongoUri) {
    const store = new MongoStore(config.mongoUri, config.mongoDb);
    try {
      await store.init();
      const kind = store.timeseries ? 'time series' : 'regular';
      console.log(`[store] connected to MongoDB, database "${config.mongoDb}" (readings: ${kind} collection)`);
      return store;
    } catch (err) {
      console.error(`[store] could not connect to MongoDB: ${err.message}`);
      console.error('[store] check MONGODB_URI and that your IP is allowed in Atlas Network Access.');
      console.error('[store] falling back to the in-memory store for now.');
    }
  } else {
    console.log('[store] MONGODB_URI not set, keeping data in memory');
  }
  const memory = new MemoryStore();
  await memory.init();
  return memory;
}

module.exports = { createStore };
