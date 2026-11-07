// MongoDB store (works with MongoDB Atlas or a local mongod).
//
// Collections
//   rooms      one document per room: the live state the dashboard shows
//   readings   a snapshot of each room every few seconds (time series collection)
//   decisions  every change the controller made, with its reason
//   overrides  every manual override set or cleared from the dashboard

const { MongoClient } = require('mongodb');

const WEEK_SECONDS = 7 * 24 * 60 * 60;

class MongoStore {
  constructor(uri, dbName) {
    this.name = 'mongodb';
    this.uri = uri;
    this.dbName = dbName;
    this.timeseries = false;
  }

  async init() {
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 8000, appName: 'nimbus-dashboard' });
    await this.client.connect();
    this.db = this.client.db(this.dbName);

    await this.ensureReadingsCollection();
    await this.db.collection('decisions').createIndex({ room: 1, ts: -1 });
    await this.db.collection('overrides').createIndex({ room: 1, ts: -1 });

    this.rooms = this.db.collection('rooms');
    this.readings = this.db.collection('readings');
    this.decisions = this.db.collection('decisions');
    this.overrides = this.db.collection('overrides');
  }

  // Readings go in a time series collection when the server supports it
  // (MongoDB 5.0+, including Atlas free tier). Otherwise a normal collection
  // with an index for range queries and a TTL index that deletes old rows.
  async ensureReadingsCollection() {
    const exists = await this.db.listCollections({ name: 'readings' }).toArray();
    if (!exists.length) {
      try {
        await this.db.createCollection('readings', {
          timeseries: { timeField: 'ts', metaField: 'room', granularity: 'seconds' },
          expireAfterSeconds: WEEK_SECONDS,
        });
      } catch (err) {
        if (err.codeName !== 'NamespaceExists') await this.db.createCollection('readings');
      }
    }
    const [info] = await this.db.listCollections({ name: 'readings' }).toArray();
    this.timeseries = info && info.type === 'timeseries';

    const readings = this.db.collection('readings');
    await readings.createIndex({ room: 1, ts: 1 });
    if (!this.timeseries) {
      try {
        await readings.createIndex({ ts: 1 }, { expireAfterSeconds: WEEK_SECONDS });
      } catch (err) {
        console.warn('[mongo] could not create TTL index on readings:', err.message);
      }
    }
  }

  async close() {
    if (this.client) await this.client.close();
  }

  async loadRooms() {
    const docs = await this.rooms.find({}).toArray();
    return docs.map(({ _id, ...rest }) => ({ ...rest, id: _id }));
  }

  async saveRoom(room) {
    const { id, ...rest } = room;
    await this.rooms.replaceOne({ _id: id }, { ...rest, id }, { upsert: true });
  }

  async insertReading(reading) {
    await this.readings.insertOne({ ...reading });
  }

  async getReadings(roomId, since) {
    return this.readings
      .find({ room: roomId, ts: { $gte: since } }, { projection: { _id: 0 } })
      .sort({ ts: 1 })
      .limit(20000)
      .toArray();
  }

  async insertDecision(decision) {
    await this.decisions.insertOne({ ...decision });
  }

  async getDecisions(roomId, limit) {
    return this.decisions
      .find({ room: roomId }, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
  }

  async insertOverride(entry) {
    await this.overrides.insertOne({ ...entry });
  }

  // One aggregation pipeline computes the room's stats for a time window.
  // If the server can't run it (some MongoDB-compatible services lack $max or
  // $avg), the same numbers are computed here from the raw readings instead.
  async summary(roomId, since, poorThreshold) {
    try {
      return await this.aggregateSummary(roomId, since, poorThreshold);
    } catch (err) {
      if (!this.warnedAggregate) {
        console.warn(`[mongo] summary aggregation not supported here (${err.message}); computing it in Node instead`);
        this.warnedAggregate = true;
      }
      const rows = await this.getReadings(roomId, since);
      const people = rows.map((r) => r.people).filter(Number.isFinite);
      const aq = rows.map((r) => r.aq).filter(Number.isFinite);
      const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
      return {
        samples: rows.length,
        peakPeople: people.length ? Math.max(...people) : null,
        avgPeople: mean(people),
        avgAq: mean(aq),
        poorSamples: aq.filter((v) => v >= poorThreshold).length,
      };
    }
  }

  async aggregateSummary(roomId, since, poorThreshold) {
    const [row] = await this.readings
      .aggregate([
        { $match: { room: roomId, ts: { $gte: since } } },
        {
          $group: {
            _id: null,
            samples: { $sum: 1 },
            peakPeople: { $max: '$people' },
            avgPeople: { $avg: '$people' },
            avgAq: { $avg: '$aq' },
            poorSamples: { $sum: { $cond: [{ $gte: ['$aq', poorThreshold] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    if (!row) return { samples: 0, peakPeople: null, avgPeople: null, avgAq: null, poorSamples: 0 };
    const { _id, ...stats } = row;
    return stats;
  }
}

module.exports = { MongoStore };
