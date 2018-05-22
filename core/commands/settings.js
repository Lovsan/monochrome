const reload = require('require-reload')(require);
const assert = require('assert');
const Hook = reload('./../message_processors/user_and_channel_hook.js');
const getUserIsServerAdmin = reload('./../util/user_is_server_admin.js');
const state = require('./../util/misc_unreloadable_data.js');

if (!state.settingsCommand) {
  state.settingsCommand = {
    msgSentForKey: {},
  };
}

const msgSentForKey = state.settingsCommand.msgSentForKey;

const CATEGORY_DESCRIPTION = 'The following subcategories and settings are available. Type the number of the one you want to see/change.';
const HOOK_EXPIRATION_MS = 180000;

async function sendMessageUnique(responseToMsg, content) {
  const key = responseToMsg.channel.id + responseToMsg.author.id;
  if (msgSentForKey[key]) {
    try {
      await msgSentForKey[key].delete();
    } catch (err) {
      // Swallow
    }
  }

  const sendMessagePromise = responseToMsg.channel.createMessage(content);
  const sentMessage = await sendMessagePromise;
  msgSentForKey[key] = sentMessage;

  return sendMessagePromise;
}

function isCategory(settingsTreeNode) {
  return !!settingsTreeNode.children;
}

function createFieldsForChildren(children) {
  const categories = [];
  const settings = [];

  for (const child of children) {
    if (isCategory(child)) {
      categories.push(child);
    } else {
      settings.push(child);
    }
  }

  let optionNumber = 0;

  const categoriesString = categories.map(category => {
    optionNumber += 1;
    return `${optionNumber}. ${category.userFacingName}`;
  }).join('\n');

  const settingsString = settings.map(setting => {
    optionNumber += 1;
    const adminOnlyString = setting.serverOnly ? ' (*admin only*)' : '';
    return `${optionNumber}. ${setting.userFacingName}${adminOnlyString}`;
  }).join('\n');

  const fields = [];
  if (categoriesString) {
    fields.push({ name: 'Subcategories', value: categoriesString });
  }
  if (settingsString) {
    fields.push({ name: 'Settings', value: settingsString });
  }

  return fields;
}

function createContentForRoot(children, color, iconUri) {
  return {
    embed: {
      title: 'Settings',
      description: CATEGORY_DESCRIPTION,
      fields: createFieldsForChildren(children),
      color: color,
      footer: {
        icon_url: iconUri,
        text: 'Say \'cancel\' to cancel.',
      },
    },
  };
}

function createContentForCategory(category, color, iconUri) {
  return {
    embed: {
      title: `Settings (${category.userFacingName})`,
      description: CATEGORY_DESCRIPTION,
      fields: createFieldsForChildren(category.children),
      color: color,
      footer: {
        icon_url: iconUri,
        text: 'You can also say \'back\' or \'cancel\'.',
      },
    },
  };
}

async function createContentForSetting(msg, settings, setting, color, iconUri) {
  return {
    embed: {
      title: `Settings (${setting.userFacingName})`,
      description: setting.description,
      color: color,
      fields: [
        {
          name: 'Allowed values',
          value: setting.allowedValuesDescription,
        },
        {
          name: 'Can be changed by',
          value: setting.serverOnly ? 'Server admin' : 'Anyone',
        },
        {
          name: 'Current value',
          value: await settings.getUserFacingSettingValue(
            setting.uniqueId,
            msg.channel.guild ? msg.channel.guild.id : msg.channel.id,
            msg.channel.id,
            msg.author.id,
          ),
        }
      ],
      footer: {
        icon_url: iconUri,
        text: 'To change the value, type in the new value. Or say \'back\' or \'cancel\'.',
      },
    },
  };
}

function messageToIndex(msg) {
  const msgAsInt = parseInt(msg.content);
  return msgAsInt - 1;
}

function handleExpiration(msg) {
  return msg.channel.createMessage('The settings menu has closed due to inactivity.');
}

function findParent(children, targetNode, previous) {
  if (!children) {
    return undefined;
  }

  for (const child of children) {
    if (child === targetNode) {
      return previous;
    }
    const childResult = findParent(child.children, targetNode, child);
    if (childResult) {
      return childResult;
    }
  }

  return undefined;
}

function tryGoBack(hook, msg, monochrome, settingsNode, color) {
  const root = monochrome.getSettings().getRawSettingsTree();
  if (msg.content.toLowerCase() === 'back') {
    const parent = findParent(monochrome.getSettings().getRawSettingsTree(), settingsNode, root);
    if (parent) {
      hook.unregister();
      return showNode(monochrome, msg, color, parent);
    }
  }

  return false;
}

function tryCancel(hook, msg) {
  if (msg.content.toLowerCase() === 'cancel') {
    hook.unregister();
    return msg.channel.createMessage('The settings menu has been closed.');
  }

  return false;
}

function handleRootViewMsg(hook, monochrome, msg, color) {
  const index = messageToIndex(msg);
  const settingsNodes = monochrome.getSettings().getRawSettingsTree();
  if (index < settingsNodes.length) {
    const nextNode = settingsNodes[index];
    hook.unregister();
    return showNode(monochrome, msg, color, nextNode);
  }

  return tryCancel(hook, msg);
}

async function tryApplyNewSetting(hook, monochrome, msg, color, setting, newUserFacingValue, locationString) {
  const settings = monochrome.getSettings();
  const userIsServerAdmin = getUserIsServerAdmin(msg, monochrome.getConfig());

  const cancelBackResult = tryHandleCancelBack(hook, monochrome, msg, color, setting);
  if (cancelBackResult) {
    return cancelBackResult;
  }

  const serverId = msg.channel.guild ? msg.channel.guild.id : msg.channel.id;
  const locationStringLowerCase = locationString.toLowerCase();
  let setResults;
  let resultString;

  if (locationStringLowerCase === 'me') {
    resultString = 'The new setting has been applied as a user setting. It will take effect whenever you use the command. The settings menu is now closed.';
    if (setting.serverOnly) {
      return msg.channel.createMessage('That setting cannot be set as a user setting. Please say **this channel**, **this server**, **cancel**, **back**, or provide a list of channels.');
    }
    setResults = [await settings.setUserSettingValue(setting.uniqueId, msg.author.id, newUserFacingValue)];
  } else if (locationStringLowerCase === 'this channel' || !msg.channel.guild) {
    resultString = 'The new setting has been applied to this channel. The settings menu is now closed.';
    setResults = [await settings.setChannelSettingValue(setting.uniqueId, serverId, msg.channel.id, newUserFacingValue, userIsServerAdmin)];
  } else if (locationStringLowerCase === 'this server') {
    resultString = 'The new setting has been applied to all channels in this server. The settings menu is now closed.';
    setResults = [await settings.setServerWideSettingValue(setting.uniqueId, serverId, newUserFacingValue, userIsServerAdmin)];
  } else {
    resultString = `The new setting has been applied to the channels: ${locationString}.　The settings menu is now closed.`;
    const channelStrings = locationString.split(/ +/);
    const channelIds = [];

    for (const channelString of channelStrings) {
      const regexResult = /<#(.*?)>/.exec(channelString);
      if (!regexResult || !msg.channel.guild.channels.find(channel => channel.id === regexResult[1])) {
        return msg.channel.createMessage(`I didn\'t find a channel in this server called **${channelString}**. Please check that the channel exists and try again.`);
      }
      channelIds.push(regexResult[1]);
    }

    const promises = channelIds.map(channelId => {
      return settings.setChannelSettingValue(setting.uniqueId, serverId, channelId, newUserFacingValue, userIsServerAdmin);
    });

    setResults = await Promise.all(promises);
  }

  hook.unregister();

  for (const result of setResults) {
    if (!result.accepted) {
      monochrome.getLogger().logFailure('SETTINGS', `Unexpected setting update rejection. Reason: ${result.reason}`);
      return msg.channel.createMessage('There was an error updating that setting. Sorry. I\'ll look into it!');
    }
  }

  return msg.channel.createMessage(resultString);
}

function tryPromptForSettingLocation(hook, msg, monochrome, settingNode, color, newUserFacingValue) {
  const userIsServerAdmin = getUserIsServerAdmin(msg, monochrome.getConfig());

  if (!userIsServerAdmin) {
    if (settingNode.serverOnly) {
      return msg.channel.createMessage('Only a server admin can set that setting. You can say **back** or **cancel**.');
    } else {
      return tryApplyNewSetting(hook, monochrome, msg, color, settingNode, newUserFacingValue, 'me');
    }
  }

  if (hook) {
    hook.unregister();
  }

  hook = Hook.registerHook(
    msg.author.id,
    msg.channel.id,
    (cbHook, cbMsg, monochrome) => tryApplyNewSetting(
      cbHook,
      monochrome,
      cbMsg,
      color,
      settingNode,
      newUserFacingValue,
      cbMsg.content,
    ),
    monochrome.getLogger(),
  );

  hook.setExpirationInMs(HOOK_EXPIRATION_MS, () => handleExpiration(msg));
  if (settingNode.serverOnly) {
    return msg.channel.createMessage('Where should the new setting be applied? You can say **this server**, **this channel**, or list channels, for example: **#general #bot #quiz**. You can also say **cancel** or **back**.');
  } else {
    return msg.channel.createMessage('Where should the new setting be applied? You can say **me**, **this server**, **this channel**, or list channels, for example: **#general #bot #quiz**. You can also say **cancel** or **back**.');
  }
}

async function handleSettingViewMsg(hook, monochrome, msg, color, setting) {
  const cancelBackResult = tryHandleCancelBack(hook, monochrome, msg, color, setting);
  if (cancelBackResult) {
    return cancelBackResult;
  }

  const settings = monochrome.getSettings();
  const newUserFacingValue = msg.content;

  const isValid = await settings.userFacingValueIsValidForSetting(setting, newUserFacingValue);
  if (!isValid) {
    return msg.channel.createMessage('That isn\'t a valid value for that setting. Please check the **Allowed values** and try again. You can also say **back** or **cancel**.');
  }

  return tryPromptForSettingLocation(hook, msg, monochrome, setting, color, newUserFacingValue);
}

function tryHandleCancelBack(hook, monochrome, msg, color, node) {
  const cancelResult = tryCancel(hook, msg);
  if (cancelResult) {
    return cancelResult;
  }

  return tryGoBack(
    hook,
    msg,
    monochrome,
    node,
    color,
  );
}

function handleCategoryViewMsg(hook, monochrome, msg, color, category) {
  const index = messageToIndex(msg);
  const childNodes = category.children;
  if (index < childNodes.length) {
    const nextNode = childNodes[index];
    hook.unregister();
    return showNode(monochrome, msg, color, nextNode);
  }

  return tryHandleCancelBack(hook, monochrome, msg, color, category);
}

function showRoot(monochrome, msg, color) {
  const settingsTree = monochrome.getSettings().getRawSettingsTree();
  const iconUri = monochrome.getConfig().settingsIconUri;
  const rootContent = createContentForRoot(settingsTree, color, iconUri);
  const hook = Hook.registerHook(
    msg.author.id,
    msg.channel.id,
    (cbHook, cbMsg, monochrome) => handleRootViewMsg(
      cbHook,
      monochrome,
      cbMsg,
      color,
    ),
    monochrome.getLogger(),
  );

  hook.setExpirationInMs(HOOK_EXPIRATION_MS, () => handleExpiration(msg));
  return sendMessageUnique(msg, rootContent);
}

function showCategory(monochrome, msg, color, category) {
  const iconUri = monochrome.getConfig().settingsIconUri;
  const categoryContent = createContentForCategory(category, color, iconUri);
  const hook = Hook.registerHook(
    msg.author.id, msg.channel.id,
    (cbHook, cbMsg, monochrome) => handleCategoryViewMsg(
      cbHook,
      monochrome,
      cbMsg,
      color,
      category,
    ),
    monochrome.getLogger(),
  );

  hook.setExpirationInMs(HOOK_EXPIRATION_MS, () => handleExpiration(msg));
  return sendMessageUnique(msg, categoryContent);
}

async function showSetting(monochrome, msg, color, setting) {
  const iconUri = monochrome.getConfig().settingsIconUri;
  const settings = monochrome.getSettings();
  const settingContent = await createContentForSetting(msg, settings, setting, color, iconUri);
  const hook = Hook.registerHook(
    msg.author.id, msg.channel.id,
    (cbHook, cbMsg, monochrome) => handleSettingViewMsg(
      cbHook,
      monochrome,
      cbMsg,
      color,
      setting,
    ),
    monochrome.getLogger(),
  );

  hook.setExpirationInMs(HOOK_EXPIRATION_MS, () => handleExpiration(msg));
  return sendMessageUnique(msg, settingContent);
}

function showNode(monochrome, msg, color, node) {
  if (Array.isArray(node)) {
    return showRoot(monochrome, msg, color);
  } else if (node.children) {
    return showCategory(monochrome, msg, color, node);
  } else {
    return showSetting(monochrome, msg, color, node);
  }
}

function shortcut(monochrome, msg, suffix, color) {
  const settings = monochrome.getSettings();
  const [uniqueId, value] = suffix.split(' ');
  const setting = settings.getTreeNodeForUniqueId(uniqueId);

  if (!setting) {
    return msg.channel.createMessage(`I didn't find a setting with ID: ${uniqueId}`);
  }
  if (!value) {
    return showNode(monochrome, msg, color, setting);
  }

  return tryPromptForSettingLocation(undefined, msg, monochrome, setting, color, value);
}

function execute(monochrome, msg, suffix, color) {
  if (suffix) {
    return shortcut(monochrome, msg, suffix, color);
  } else {
    return showNode(monochrome, msg, color, monochrome.getSettings().getRawSettingsTree());
  }
}

class SettingsCommand {
  constructor(config) {
    this.commandAliases = config.settingsCommandAliases;
    this.uniqueId = 'autoGeneratedSettings425654';
    this.canBeChannelRestricted = false;
    this.shortDescription = 'Configure my settings.';
    this.longDescription = 'Configure my settings. Server admins can configure my default settings on their server. Users can configure user settings.';

    this.action = (erisBot, monochrome, msg, suffix) => execute(
      monochrome,
      msg,
      suffix,
      config.colorForSettingsSystemEmbeds,
    );
  }
}

module.exports = SettingsCommand;