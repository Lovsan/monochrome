const { assert } = require('chai');
const MongoPlugin = require('../plugins/storage_mongo');

let plugin;

describe('Mongo storage plugin', function() {
  this.beforeEach(function() {
    plugin = MongoPlugin.createNewClient('mongodb://localhost', 'monochrome_persistence_test', 'monochrome_persistence_test');
  });

  afterEach(async function() {
    this.timeout(15000);
    await plugin.clear();
    await plugin.close();
  });

  it('Gives me back what I give it', async function() {
    await plugin.editValue('testKey', () => 5);
    assert.equal(5, await plugin.getValue('testKey'));
  }).timeout(15000);
  it('Gives me the default value if key does not exist', async function() {
    assert.equal(10, await plugin.getValue('testKey', 10));
  }).timeout(15000);
  it('Gives me the existing value, not the default, if a value exists', async function() {
    await plugin.editValue('testKey', () => 15);
    assert.equal(15, await plugin.getValue('testKey', 'f'));
  }).timeout(15000);
  it('Returns undefined by default if key is not present', async function() {
    assert.isUndefined(await plugin.getValue('testKey2'));
  }).timeout(15000);
  it('Deletes values successfully', async function() {
    await plugin.editValue('testKey2', () => 'test');
    await plugin.deleteKey('testKey2');
    assert.isUndefined(await plugin.getValue('testKey2'));
  }).timeout(15000);
  it('Clears the database successfully', async function() {
    await plugin.editValue('testKey3', () => 'test');
    await plugin.clear();
    assert.isUndefined(await plugin.getValue('testKey3'));
  }).timeout(15000);
  it('Upserts new value with setValue', async function() {
    await plugin.setValue('testKey4', 'testing');
    assert.equal(await plugin.getValue('testKey4'), 'testing');
  });
  it('Replaces old value with setValue', async function() {
    await plugin.setValue('test__Key5', 'testing');
    await plugin.setValue('test__Key5', 'testing2');
    assert.equal(await plugin.getValue('test__Key5'), 'testing2');
  });
});
