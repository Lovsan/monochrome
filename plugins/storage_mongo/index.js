const { MongoClient } = require('mongodb');

class MongoDBStoragePlugin {
  constructor(clientPromise, dbName, collectionName) {
    this.clientPromise = clientPromise;
    this.dbName = dbName;
    this.collectionName = collectionName;
  }

  static createNewClient(dbUri, dbName, collectionName) {
    if (!dbUri || !dbName || !collectionName) {
      throw new Error('Invalid arguments. Must provide dbUri, dbName, and collectionName');
    }

    const clientPromise = MongoClient.connect(
      dbUri,
      {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      },
    );

    return new MongoDBStoragePlugin(clientPromise, dbName, collectionName);
  }

  static createWithClient(client, dbName, collectionName) {
    return new MongoDBStoragePlugin(client, dbName, collectionName);
  }

  getMongoClient() {
    return this.clientPromise;
  }

  async doConnect() {
    this.client = await this.clientPromise;
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection(this.collectionName);
    await this.collection.createIndex({ key: 1 }, { unique: true });
  }

  async connect() {
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect();
    }

    await this.connectPromise;
  }

  async getValue(key, defaultValue) {
    await this.connect();

    const result = await this.collection.findOne({ key });
    return result === null ? defaultValue : result.value;
  }

  async editValue(key, editFn, defaultValue = undefined) {
    await this.connect();

    const valueWrapper = await this.collection.findOne({ key });
    const value = valueWrapper ? valueWrapper.value : defaultValue;
    const updatedValue = await editFn(value);
    await this.collection.updateOne(
      { key },
      { $set: { value: updatedValue } },
      { upsert: true },
    );

    return updatedValue;
  }

  async deleteKey(key) {
    await this.connect();
    await this.collection.deleteOne({ key });
  }

  async close() {
    await this.connect();
    await this.client.close();
  }

  async clear() {
    await this.connect();
    await this.db.dropDatabase();
  }
}

module.exports = MongoDBStoragePlugin;
